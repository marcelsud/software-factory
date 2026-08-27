import { createHash } from "node:crypto";
import {
  type ChimpbaseModuleInterface,
  defineChimpbaseModuleImplementation,
  defineChimpbaseModuleSubscription,
} from "chimpbase/core";
import {
  type ChimpbaseLogger,
  type ChimpbaseModuleCallReference,
  type ChimpbaseTelemetryAttributes,
  type ChimpbaseTraceSpan,
  cron,
  type Infer,
  v,
} from "chimpbase/runtime";
import type { Kysely } from "kysely";
import {
  effectReceipt,
  eventRecord,
  health,
  operationsEffect,
  operationsEffectPage,
  operationsEvent,
  operationsEventPage,
  operationsHealth,
  operationsRebuildResult,
  operationsRun,
  operationsRunDetails,
  operationsRunPage,
  operationsTimelineEntry,
  operatorCommandAudit,
  type ReplayBundle,
  replayBundleEnvelope,
  replayEvent,
  run,
} from "../../contracts/index.ts";
import {
  createReplayBundle,
  parseReplayBundle,
  projectOperationsTelemetry,
  sha256Digest,
  telemetryRecordsForEvent,
} from "../../replay.ts";
import {
  type OperationEffectProjectionRow,
  type OperationEventProjectionRow,
  type OperationRunProjectionRow,
  type OperationsDatabase,
  type OperationTimelineProjectionRow,
  type OperatorCommandAuditRow,
  operationsMigrations,
} from "../../storage/operations-database.ts";
import { assets } from "../assets/interface.ts";
import { definitions } from "../definitions/interface.ts";
import { effects } from "../effects/interface.ts";
import { execution } from "../execution/interface.ts";
import { intake } from "../intake/interface.ts";
import { runs } from "../runs/interface.ts";
import { operations } from "./interface.ts";

const implementationInterface = operations as unknown as ChimpbaseModuleInterface<
  typeof operations.calls,
  typeof operations.events
>;

type OperationsRun = Infer<typeof operationsRun>;
type OperationsEffect = Infer<typeof operationsEffect>;
type SafeObject = Record<string, unknown>;

type Probe = () => boolean | Promise<boolean>;
export interface OperationsImplementationDependencies {
  credentialsPresent?: Probe;
  now?: () => Date;
  pollLagMs?: () => number | null | Promise<number | null>;
  repositoryReachability?: () =>
    | Record<string, "reachable" | "unreachable">
    | Promise<Record<string, "reachable" | "unreachable">>;
  staleLocks?: () => number | Promise<number>;
  storageReady?: Probe;
  workerReady?: Probe;
  workflowReady?: Probe;
}

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const maximumPageSize = 100;
interface OperationsContext {
  readonly db: { readonly schema: string | null; kysely(): unknown };
  readonly module: { readonly name: string } | null;
}

interface OperationsTelemetryContext {
  readonly log: ChimpbaseLogger;
  metric(name: string, value: number, labels?: ChimpbaseTelemetryAttributes): void;
  trace<TResult>(
    name: string,
    callback: (span: ChimpbaseTraceSpan) => TResult | Promise<TResult>,
    attributes?: ChimpbaseTelemetryAttributes,
  ): Promise<TResult>;
}

interface ReplayCallContext {
  call<TInput, TOutput>(
    contract: ChimpbaseModuleCallReference<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
}

const runPageCursor = v.object({ runId: v.string(), startedAt: v.string() });
const eventPageCursor = v.object({ eventId: v.string(), sequence: v.integer() });
const effectPageCursor = v.object({
  idempotencyKey: v.string(),
  requestedAt: v.string(),
});

function dbFrom(ctx: OperationsContext): Kysely<OperationsDatabase> {
  if (ctx.module?.name !== "operations" || ctx.db.schema !== "chimpbase_operations")
    throw new Error("operations module context required");
  return ctx.db.kysely() as Kysely<OperationsDatabase>;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as SafeObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

function identity(kind: string, payload: unknown): string {
  return `evt_${createHash("sha256").update(kind).update("\0").update(canonical(payload)).digest("hex")}`;
}

function pageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumPageSize)
    throw new Error(`invalid_limit: limit must be between 1 and ${maximumPageSize}`);
  return limit;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(canonical(value)).toString("base64url");
}

function decodeCursor<T>(cursor: string, validator: { parse(value: unknown): T }): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return validator.parse(value);
  } catch {
    throw new Error("invalid_cursor: cursor is malformed");
  }
}

function safeSourceEvent(event: SafeObject) {
  return {
    actor: event.actor,
    correlationId: event.correlationId,
    deliveryId: event.deliveryId,
    eventType: event.eventType,
    observedAt: event.observedAt,
    occurredAt: event.occurredAt,
    repository: event.repository,
    sourceId: event.sourceId,
    sourceRevision: event.sourceRevision,
    subject: event.subject,
  };
}

function runTime(run: SafeObject): string {
  if (typeof run.finishedAt === "string") return run.finishedAt;
  const startedAt = String(run.startedAt);
  const sequence = typeof run.auditSequence === "number" ? run.auditSequence : 0;
  const milliseconds = Date.parse(startedAt);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds + sequence).toISOString()
    : startedAt;
}

function factOrder(left: OperationEventProjectionRow, right: OperationEventProjectionRow): number {
  const time = left.occurred_at.localeCompare(right.occurred_at);
  if (time !== 0) return time;
  if (left.run_id !== null && left.run_id === right.run_id) {
    const leftSequence = Number((JSON.parse(left.payload_json) as SafeObject).auditSequence ?? -1);
    const rightSequence = Number(
      (JSON.parse(right.payload_json) as SafeObject).auditSequence ?? -1,
    );
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  }
  return left.event_id.localeCompare(right.event_id);
}

async function emitFactTelemetry(
  ctx: OperationsContext & OperationsTelemetryContext,
  event: {
    eventId: string;
    kind: string;
    occurredAt: string;
    payload: SafeObject;
    runId: string;
    sequence: number;
  },
): Promise<void> {
  const record = telemetryRecordsForEvent(event)[0];
  if (record === undefined) throw new Error("factory telemetry record missing");
  const labels = {
    ...record.attributes,
    failureCategory: record.failureCategory,
    productOutcome: record.productOutcome,
    schemaVersion: record.schemaVersion,
    sourceModule: record.scope.module,
  };
  ctx.log.info("factory.event.v1", labels);
  ctx.metric("factory.events", 1, labels);
  await ctx.trace("factory.event.v1", async () => undefined, labels);
}

async function recordFact(
  ctx: OperationsContext & OperationsTelemetryContext,
  kind: string,
  occurredAt: string,
  payload: SafeObject,
  runId: string | null = null,
  sourceKey: string | null = null,
): Promise<boolean> {
  const db = dbFrom(ctx);
  const payloadJson = canonical(payload);
  const eventId = identity(kind, payload);
  const existing = await db
    .selectFrom("event_projections")
    .selectAll()
    .where("event_id", "=", eventId)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (
      existing.kind !== kind ||
      existing.occurred_at !== occurredAt ||
      existing.payload_json !== payloadJson ||
      existing.run_id !== runId ||
      existing.source_key !== sourceKey
    )
      throw new Error("projection_conflict: event identity has different fields");
    return false;
  }
  const last = await db
    .selectFrom("event_projections")
    .select(({ fn }) => fn.max<number>("sequence").as("sequence"))
    .executeTakeFirst();
  const sequence = (last?.sequence ?? 0) + 1;
  const processedAt = new Date().toISOString();
  await db
    .insertInto("event_projections")
    .values({
      event_id: eventId,
      kind,
      occurred_at: occurredAt,
      payload_json: payloadJson,
      run_id: runId,
      sequence,
      source_key: sourceKey,
    })
    .execute();
  await emitFactTelemetry(ctx, {
    eventId,
    kind,
    occurredAt,
    payload,
    runId: runId ?? "global",
    sequence,
  });
  if (runId !== null) await rebuild(db, runId);
  else if (kind === "definition.published" || kind === "skill.pinned") await rebuild(db);
  else if (kind === "source.accepted" && sourceKey !== null) {
    const matchingRuns = await db
      .selectFrom("run_projections")
      .selectAll()
      .where("source_key", "=", sourceKey)
      .execute();
    for (const matchingRun of matchingRuns) {
      const projection = operationsRun.parse({
        ...JSON.parse(matchingRun.projection_json),
        sourceEvent: payload,
      });
      await db
        .updateTable("run_projections")
        .set({ projection_json: canonical(projection) })
        .where("run_id", "=", matchingRun.run_id)
        .execute();
      await db
        .insertInto("timeline_projections")
        .values({
          event_id: eventId,
          kind,
          occurred_at: occurredAt,
          payload_json: payloadJson,
          run_id: matchingRun.run_id,
          sequence: (last?.sequence ?? 0) + 1,
        })
        .onConflict((conflict) => conflict.columns(["run_id", "event_id"]).doNothing())
        .execute();
    }
  }
  await db
    .insertInto("health_projection")
    .values({ id: "projection-worker", last_sequence: sequence, updated_at: processedAt })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({ last_sequence: sequence, updated_at: processedAt }),
    )
    .execute();
  return true;
}

function currentRevision(pinned: string, current: string | null) {
  return { current, drift: current !== null && current !== pinned, pinned };
}

function currentRevisionMap(pinned: Record<string, string>, current: Record<string, string>) {
  const selected = Object.fromEntries(
    Object.keys(pinned)
      .sort()
      .flatMap((key) => (current[key] === undefined ? [] : [[key, current[key]]])),
  );
  return {
    current: selected,
    drift: Object.entries(pinned).some(
      ([key, digest]) => selected[key] !== undefined && selected[key] !== digest,
    ),
    pinned: Object.fromEntries(Object.entries(pinned).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function sourceKey(factoryEventId: string): string {
  const separator = factoryEventId.lastIndexOf(":");
  return separator < 0 ? factoryEventId : factoryEventId.slice(0, separator);
}
async function nextRunTime(ctx: OperationsContext, runId: string): Promise<string> {
  const latest = await dbFrom(ctx)
    .selectFrom("event_projections")
    .select("occurred_at")
    .where("run_id", "=", runId)
    .orderBy("occurred_at", "desc")
    .orderBy("sequence", "desc")
    .executeTakeFirst();
  if (latest === undefined) return new Date(0).toISOString();
  const milliseconds = Date.parse(latest.occurred_at);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds + 1).toISOString()
    : latest.occurred_at;
}
async function nextGlobalTime(ctx: OperationsContext): Promise<string> {
  const latest = await dbFrom(ctx)
    .selectFrom("event_projections")
    .select("occurred_at")
    .orderBy("occurred_at", "desc")
    .orderBy("sequence", "desc")
    .executeTakeFirst();
  if (latest === undefined) return new Date(0).toISOString();
  const milliseconds = Date.parse(latest.occurred_at);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds + 1).toISOString()
    : latest.occurred_at;
}

async function rebuild(database: Kysely<OperationsDatabase>, onlyRunId?: string) {
  let facts: OperationEventProjectionRow[];
  if (onlyRunId === undefined) {
    facts = await database.selectFrom("event_projections").selectAll().execute();
  } else {
    const scoped = await database
      .selectFrom("event_projections")
      .selectAll()
      .where("run_id", "=", onlyRunId)
      .execute();
    const global = await database
      .selectFrom("event_projections")
      .selectAll()
      .where("kind", "in", ["definition.published", "skill.pinned"])
      .execute();
    const currentRun = await database
      .selectFrom("event_projections")
      .selectAll()
      .where("kind", "=", "run.state")
      .orderBy("occurred_at", "desc")
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const latestState = scoped
      .filter((fact) => fact.kind === "run.state")
      .sort(factOrder)
      .at(-1);
    const source =
      latestState === undefined
        ? undefined
        : await database
            .selectFrom("event_projections")
            .selectAll()
            .where(
              "source_key",
              "=",
              sourceKey(
                String((JSON.parse(latestState.payload_json) as SafeObject).factoryEventId),
              ),
            )
            .where("kind", "=", "source.accepted")
            .orderBy("sequence", "asc")
            .executeTakeFirst();
    const unique = new Map<string, OperationEventProjectionRow>();
    for (const fact of [
      ...global,
      ...scoped,
      ...(currentRun === undefined ? [] : [currentRun]),
      ...(source === undefined ? [] : [source]),
    ])
      unique.set(fact.event_id, fact);
    facts = [...unique.values()];
  }
  facts.sort(factOrder);
  const db = database;

  if (onlyRunId === undefined) {
    await db.deleteFrom("timeline_projections").execute();
    await db.deleteFrom("effect_projections").execute();
    await db.deleteFrom("run_projections").execute();
  } else {
    await db.deleteFrom("timeline_projections").where("run_id", "=", onlyRunId).execute();
    await db.deleteFrom("effect_projections").where("run_id", "=", onlyRunId).execute();
    await db.deleteFrom("run_projections").where("run_id", "=", onlyRunId).execute();
  }

  let currentDefinition: string | null = null;
  let currentFlows: Record<string, string> = {};
  let currentAgentProfiles: Record<string, string> = {};
  const currentSkills: Record<string, string> = {};
  const sources = new Map<string, OperationEventProjectionRow>();
  for (const fact of facts) {
    const payload = JSON.parse(fact.payload_json) as SafeObject;
    if (fact.kind === "definition.published") {
      currentDefinition = String(payload.definitionDigest);
      currentFlows = payload.flowDigests as Record<string, string>;
    } else if (fact.kind === "skill.pinned") {
      currentSkills[String(payload.id)] = String(payload.digest);
    } else if (fact.kind === "run.state") {
      currentAgentProfiles = payload.agentProfileDigests as Record<string, string>;
    } else if (fact.kind === "source.accepted" && fact.source_key !== null) {
      sources.set(fact.source_key, fact);
    }
  }

  const runFacts = new Map<string, OperationEventProjectionRow[]>();
  for (const fact of facts) {
    if (fact.run_id === null) continue;
    if (onlyRunId !== undefined && fact.run_id !== onlyRunId) continue;
    const entries = runFacts.get(fact.run_id) ?? [];
    entries.push(fact);
    runFacts.set(fact.run_id, entries);
  }

  const runRows: OperationRunProjectionRow[] = [];
  const timelineRows: OperationTimelineProjectionRow[] = [];
  const effectRows = new Map<string, OperationEffectProjectionRow>();

  for (const [runId, entries] of [...runFacts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const stateFacts = entries.filter((entry) => entry.kind === "run.state");
    const latest = stateFacts.at(-1);
    if (latest === undefined) continue;
    const state = JSON.parse(latest.payload_json) as SafeObject;
    const pinnedSkills = state.skillDigests as Record<string, string>;
    const pinnedProfiles = state.agentProfileDigests as Record<string, string>;
    const factoryEventId = String(state.factoryEventId);
    const source = sources.get(sourceKey(factoryEventId));
    let failureCategory: string | null = null;
    for (const entry of entries) {
      const payload = JSON.parse(entry.payload_json) as SafeObject;
      if (entry.kind === "attempt.finished") {
        const failure = payload.failure as SafeObject | null;
        if (failure !== null && failure !== undefined && typeof failure.category === "string")
          failureCategory = failure.category;
      }
      if (entry.kind === "effect.finished" && typeof payload.failureCategory === "string")
        failureCategory = payload.failureCategory;
    }
    const run = operationsRun.parse({
      currentAttemptId: state.currentAttemptId ?? null,
      currentCorrelationToken: state.currentCorrelationToken ?? null,
      currentEffectKey: state.currentEffectKey ?? null,
      currentGateId: state.currentGateId ?? null,
      currentGateStatus: state.currentGateStatus ?? null,
      currentStepId: state.currentStepId ?? null,
      failureCategory,
      factoryEventId,
      finishedAt: state.finishedAt ?? null,
      flowId: state.flowId,
      leaseExpiresAt: null,
      leaseOwner: null,
      outcome: state.outcome,
      revisions: {
        agentProfiles: currentRevisionMap(pinnedProfiles, currentAgentProfiles),
        definition: currentRevision(String(state.definitionDigest), currentDefinition),
        flow: currentRevision(String(state.flowDigest), currentFlows[String(state.flowId)] ?? null),
        skills: currentRevisionMap(pinnedSkills, currentSkills),
      },
      runId,
      sourceEvent: source === undefined ? null : JSON.parse(source.payload_json),
      startedAt: state.startedAt,
      stateId: state.stateId,
      status: state.status,
      terminal: terminalStatuses.has(String(state.status)),
      updatedAt: entries.at(-1)?.occurred_at ?? String(state.startedAt),
    });
    runRows.push({
      finished_at: run.finishedAt,
      projection_json: canonical(run),
      run_id: runId,
      source_key: sourceKey(factoryEventId),
      started_at: run.startedAt,
      status: run.status,
      updated_at: run.updatedAt,
    });
    const timeline = source === undefined ? entries : [source, ...entries];
    timeline.sort((left, right) => {
      const occurred = left.occurred_at.localeCompare(right.occurred_at);
      return occurred === 0 ? left.sequence - right.sequence : occurred;
    });
    for (const fact of timeline)
      timelineRows.push({
        event_id: fact.event_id,
        kind: fact.kind,
        occurred_at: fact.occurred_at,
        payload_json: fact.payload_json,
        run_id: runId,
        sequence: fact.sequence,
      });
  }

  for (const fact of facts) {
    if (onlyRunId !== undefined && fact.run_id !== onlyRunId) continue;
    const payload = JSON.parse(fact.payload_json) as SafeObject;
    if (fact.kind === "effect.requested") {
      const value = operationsEffect.parse({
        correlationToken: payload.correlationToken,
        effectId: payload.effectId,
        externalId: null,
        externalRevision: null,
        externalUrl: null,
        failureCategory: null,
        finishedAt: null,
        idempotencyKey: payload.idempotencyKey,
        outcome: null,
        recordedAt: payload.requestedAt,
        runId: payload.runId,
        status: "queued",
      });
      effectRows.set(value.idempotencyKey, effectRow(value));
    } else if (fact.kind === "effect.finished") {
      const value = operationsEffect.parse({ ...payload, status: "finished" });
      effectRows.set(value.idempotencyKey, effectRow(value));
    }
  }

  for (const row of runRows) await db.insertInto("run_projections").values(row).execute();
  for (const row of timelineRows) await db.insertInto("timeline_projections").values(row).execute();
  for (const row of [...effectRows.values()].sort((a, b) =>
    a.idempotency_key.localeCompare(b.idempotency_key),
  ))
    await db.insertInto("effect_projections").values(row).execute();

  return operationsRebuildResult.parse({
    effects: effectRows.size,
    events: facts.length,
    runs: runRows.length,
    timeline: timelineRows.length,
  });
}

function effectRow(effect: OperationsEffect): OperationEffectProjectionRow {
  return {
    effect_id: effect.effectId,
    finished_at: effect.finishedAt,
    idempotency_key: effect.idempotencyKey,
    projection_json: canonical(effect),
    requested_at: effect.recordedAt,
    run_id: effect.runId,
    status: effect.status,
  };
}
async function legacyRun(database: Kysely<OperationsDatabase>, projection: OperationsRun) {
  const fact = await database
    .selectFrom("event_projections")
    .select("payload_json")
    .where("kind", "=", "run.state")
    .where("run_id", "=", projection.runId)
    .orderBy("sequence", "desc")
    .executeTakeFirstOrThrow();
  const state = JSON.parse(fact.payload_json) as SafeObject;
  const status =
    projection.status === "queued" ||
    projection.status === "retrying" ||
    projection.status === "paused"
      ? "running"
      : projection.status;
  return run.parse({
    agentProfileDigests: projection.revisions.agentProfiles.pinned,
    definitionDigest: projection.revisions.definition.pinned,
    ...(projection.finishedAt === null ? {} : { finishedAt: projection.finishedAt }),
    factoryEventId: projection.factoryEventId,
    flowDigest: projection.revisions.flow.pinned,
    flowId: projection.flowId,
    moduleManifestDigest: state.moduleManifestDigest,
    runId: projection.runId,
    skillDigests: projection.revisions.skills.pinned,
    startedAt: projection.startedAt,
    stateId: projection.stateId,
    status,
    workflowVersionDigest: state.workflowVersionDigest,
  });
}

function legacyEffect(effect: OperationsEffect) {
  const outcome =
    effect.status === "queued"
      ? "pending"
      : effect.outcome === "applied" || effect.outcome === "already_applied"
        ? "applied"
        : effect.outcome === "rejected"
          ? "rejected"
          : "ambiguous";
  return effectReceipt.parse({
    effectId: effect.effectId,
    externalRevision: effect.externalRevision,
    ...(effect.finishedAt === null ? {} : { finishedAt: effect.finishedAt }),
    idempotencyKey: effect.idempotencyKey,
    outcome,
    recordedAt: effect.recordedAt,
    runId: effect.runId,
  });
}

function auditFromRow(row: OperatorCommandAuditRow) {
  return operatorCommandAudit.parse({
    actor: row.actor,
    appliedAt: row.applied_at,
    commandKey: row.command_key,
    error: row.error,
    kind: row.kind,
    outcome: row.outcome,
    requestedAt: row.requested_at,
    runId: row.run_id,
  });
}

async function booleanProbe(probe: Probe | undefined): Promise<boolean> {
  if (probe === undefined) return true;
  try {
    return await probe();
  } catch {
    return false;
  }
}
async function refreshWorkerHeartbeat(ctx: OperationsContext): Promise<{ updatedAt: string }> {
  const db = dbFrom(ctx);
  const newest = await db
    .selectFrom("event_projections")
    .select(({ fn }) => fn.max<number>("sequence").as("sequence"))
    .executeTakeFirst();
  const updatedAt = new Date().toISOString();
  const lastSequence = newest?.sequence ?? 0;
  await db
    .insertInto("health_projection")
    .values({ id: "projection-worker", last_sequence: lastSequence, updated_at: updatedAt })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({ last_sequence: lastSequence, updated_at: updatedAt }),
    )
    .execute();
  return { updatedAt };
}

const workerHeartbeatCron = cron("projection-heartbeat", "* * * * *", async (ctx) => {
  await refreshWorkerHeartbeat(ctx);
});

async function replayEventsForRun(
  database: Kysely<OperationsDatabase>,
  runId: string,
): Promise<Infer<typeof replayEvent>[]> {
  const rows = await database
    .selectFrom("timeline_projections")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("sequence", "asc")
    .orderBy("event_id", "asc")
    .execute();
  return rows.map((row) =>
    replayEvent.parse({
      eventId: row.event_id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
      runId,
      sequence: row.sequence,
    }),
  );
}

async function persistReplayBundle(ctx: ReplayCallContext, bundle: ReplayBundle) {
  const bytes = Buffer.from(canonical(bundle));
  const sourceDigest = sha256Digest(bytes);
  const attemptId = `replay:${bundle.bundleDigest}`;
  await ctx.call(assets.calls.storeArtifactV2, {
    artifact: {
      attemptId,
      classification: "private",
      createdAt: bundle.createdAt,
      digest: sourceDigest,
      kind: "metadata",
      mediaType: "application/vnd.software-factory.replay+json",
      name: "replay-bundle.json",
      redaction: "raw-private",
      retention: bundle.redactionPolicy.privateRetention,
      runId: bundle.runId,
      size: bytes.byteLength,
    },
    contentBase64: bytes.toString("base64"),
  });
  const published = await ctx.call(assets.calls.publishArtifactV2, {
    attemptId,
    createdAt: bundle.createdAt,
    digest: sourceDigest,
    runId: bundle.runId,
  });
  return replayBundleEnvelope.parse({
    artifactDigest: published.artifact.digest,
    bundle,
  });
}

async function recordReplayStepSkill(
  ctx: OperationsContext,
  value: {
    runId: string;
    skillDigests: Record<string, string>;
    skillId: string;
    stepId: string;
  },
): Promise<void> {
  const skillDigest = value.skillDigests[value.skillId];
  if (skillDigest === undefined) throw new Error("projection_conflict: step skill digest missing");
  const db = dbFrom(ctx);
  const existing = await db
    .selectFrom("step_replay_projections")
    .selectAll()
    .where("run_id", "=", value.runId)
    .where("step_id", "=", value.stepId)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.skill_id !== value.skillId || existing.skill_digest !== skillDigest)
      throw new Error("projection_conflict: step skill revision changed");
    return;
  }
  await db
    .insertInto("step_replay_projections")
    .values({
      run_id: value.runId,
      skill_digest: skillDigest,
      skill_id: value.skillId,
      step_id: value.stepId,
    })
    .execute();
}

function createSubscriptions() {
  return [
    defineChimpbaseModuleSubscription(
      definitions.events.definitionPublishedV1,
      "project-definition-v1",
      async (ctx, value) =>
        recordFact(ctx, "definition.published", await nextGlobalTime(ctx), {
          definitionDigest: value.definitionDigest,
          flowDigests: value.flowDigests,
          sourceName: value.sourceName,
        }),
    ),
    defineChimpbaseModuleSubscription(
      intake.events.factoryEventAcceptedV2,
      "project-source-event-v2",
      async (ctx, value) => {
        const event = safeSourceEvent(value.event as unknown as SafeObject);
        const key = String(value.event.correlationId).startsWith("factory-event:")
          ? String(value.event.correlationId).slice("factory-event:".length)
          : createHash("sha256")
              .update("factory-event\0")
              .update(value.event.sourceId)
              .update("\0")
              .update(value.event.deliveryId)
              .digest("hex");
        return recordFact(ctx, "source.accepted", value.event.observedAt, event, null, key);
      },
    ),
    defineChimpbaseModuleSubscription(
      assets.events.skillRevisionPinnedV2,
      "project-skill-v2",
      async (ctx, value) =>
        recordFact(ctx, "skill.pinned", await nextGlobalTime(ctx), {
          capabilities: value.capabilities,
          digest: value.digest,
          id: value.id,
          source: value.source,
          version: value.version,
        }),
    ),
    defineChimpbaseModuleSubscription(
      runs.events.runStateChangedV4,
      "project-run-state-v4",
      async (ctx, value) =>
        recordFact(
          ctx,
          "run.state",
          runTime(value as unknown as SafeObject),
          value as unknown as SafeObject,
          value.runId,
          sourceKey(value.factoryEventId),
        ),
    ),
    defineChimpbaseModuleSubscription(
      runs.events.stepRequestedV2,
      "project-step-v2",
      async (ctx, value) =>
        recordFact(
          ctx,
          "step.requested",
          await nextRunTime(ctx, value.runId),
          value as unknown as SafeObject,
          value.runId,
        ),
    ),
    defineChimpbaseModuleSubscription(
      runs.events.stepRequestedV3,
      "project-step-v3",
      async (ctx, value) => recordReplayStepSkill(ctx, value),
    ),
    defineChimpbaseModuleSubscription(
      execution.events.attemptFinishedV2,
      "project-attempt-v2",
      async (ctx, value) =>
        recordFact(
          ctx,
          "attempt.finished",
          value.finishedAt,
          {
            agentProfileDigest: value.agentProfileDigest,
            attemptId: value.attemptId,
            correlationToken: value.correlationToken,
            failure: value.result.failure ?? null,
            finishedAt: value.finishedAt,
            outcome: value.result.outcome?.outcome ?? null,
            resultDocument:
              value.result.outcome === undefined
                ? null
                : {
                    outcome: value.result.outcome.outcome,
                    outputArtifactDigests: value.result.outcome.outputArtifactDigests,
                  },
            runId: value.runId,
            startedAt: value.startedAt,
            status: value.result.status,
            stepId: value.stepId,
          },
          value.runId,
        ),
    ),
    defineChimpbaseModuleSubscription(
      assets.events.artifactStoredV2,
      "project-artifact-v2",
      async (ctx, value) =>
        recordFact(
          ctx,
          "artifact.stored",
          value.createdAt,
          value as unknown as SafeObject,
          value.runId,
        ),
    ),
    defineChimpbaseModuleSubscription(
      runs.events.effectRequestedV3,
      "project-effect-request-v3",
      async (ctx, value) =>
        recordFact(
          ctx,
          "effect.requested",
          value.requestedAt,
          {
            capability: value.capability,
            correlationToken: value.correlationToken,
            effectId: `effect_${createHash("sha256").update(value.idempotencyKey).digest("hex")}`,
            idempotencyKey: value.idempotencyKey,
            operation: { kind: value.operation.kind },
            provenance: value.provenance,
            requestedAt: value.requestedAt,
            runId: value.provenance.runId,
            target: value.target,
          },
          value.provenance.runId,
        ),
    ),
    defineChimpbaseModuleSubscription(
      effects.events.effectFinishedV3,
      "project-effect-finished-v3",
      async (ctx, value) =>
        recordFact(
          ctx,
          "effect.finished",
          value.finishedAt,
          value as unknown as SafeObject,
          value.runId,
        ),
    ),
    defineChimpbaseModuleSubscription(
      runs.events.runFinishedV4,
      "project-run-finished-v4",
      async (ctx, value) =>
        recordFact(
          ctx,
          "run.finished",
          value.finishedAt,
          value as unknown as SafeObject,
          value.runId,
        ),
    ),
  ] as const;
}

export function createOperationsImplementation(
  dependencies: OperationsImplementationDependencies = {},
) {
  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: operationsMigrations,
    registrations: [workerHeartbeatCron],
    subscriptions: createSubscriptions(),
    calls: {
      async listRuns(ctx, input) {
        const limit = pageSize(input.limit);
        const matches: Infer<typeof run>[] = [];
        let after: string | null = null;
        do {
          const page: Infer<typeof operations.calls.listRunsV2.output> = await ctx.call(
            operations.calls.listRunsV2,
            { ...(after === null ? {} : { after }), limit: maximumPageSize },
          );
          const items = await Promise.all(
            page.items.map((projection) => legacyRun(dbFrom(ctx), projection)),
          );
          matches.push(
            ...items.filter((item) => input.status === undefined || item.status === input.status),
          );
          after = page.nextCursor;
        } while (matches.length < limit && after !== null);
        return matches.slice(0, limit);
      },
      async showRun(ctx, input) {
        const details = await ctx.call(operations.calls.showRunV2, input);
        return details === null ? null : legacyRun(dbFrom(ctx), details.run);
      },
      async getHealth(ctx) {
        const detailed = await ctx.call(operations.calls.getHealthV2, {});
        const adaptersReady =
          detailed.adapters.credentialsPresent &&
          !Object.values(detailed.adapters.repositories).includes("unreachable");
        return health.parse({
          modules: {
            adapters: adaptersReady ? "ready" : "unavailable",
            storage: detailed.storage === "ready" ? "ready" : "unavailable",
            worker: detailed.worker === "ready" ? "ready" : "unavailable",
            workflow: detailed.workflow === "ready" ? "ready" : "unavailable",
          },
          status: detailed.status,
        });
      },
      async listEvents(ctx, input) {
        const limit = pageSize(input.limit);
        let rows = await dbFrom(ctx)
          .selectFrom("event_projections")
          .selectAll()
          .orderBy("sequence", "asc")
          .orderBy("event_id", "asc")
          .execute();
        if (input.runId !== undefined) rows = rows.filter((row) => row.run_id === input.runId);
        if (input.after !== undefined) {
          const cursor = rows.find((row) => row.event_id === input.after);
          rows =
            cursor === undefined
              ? []
              : rows.filter(
                  (row) =>
                    row.sequence > cursor.sequence ||
                    (row.sequence === cursor.sequence && row.event_id > cursor.event_id),
                );
        }
        return rows.slice(0, limit).map((row) =>
          eventRecord.parse({
            eventId: row.event_id,
            kind: row.kind,
            occurredAt: row.occurred_at,
            payload: JSON.parse(row.payload_json),
          }),
        );
      },
      async listEffects(ctx, input) {
        const page = await ctx.call(operations.calls.listEffectsV2, input);
        return page.items.map(legacyEffect);
      },
      async listRunsV2(ctx, input) {
        const limit = pageSize(input.limit);
        const rows = await dbFrom(ctx)
          .selectFrom("run_projections")
          .selectAll()
          .orderBy("started_at", "desc")
          .orderBy("run_id", "asc")
          .execute();
        let items = rows.filter((row) => input.status === undefined || row.status === input.status);
        if (input.after !== undefined) {
          const cursor = decodeCursor(input.after, runPageCursor);
          items = items.filter(
            (row) =>
              row.started_at < cursor.startedAt ||
              (row.started_at === cursor.startedAt && row.run_id > cursor.runId),
          );
        }
        const page = items
          .slice(0, limit)
          .map((row) => operationsRun.parse(JSON.parse(row.projection_json)));
        const last = page.at(-1);
        return operationsRunPage.parse({
          items: page,
          nextCursor:
            items.length > limit && last !== undefined
              ? encodeCursor({ runId: last.runId, startedAt: last.startedAt })
              : null,
        });
      },
      async showRunV2(ctx, input) {
        const db = dbFrom(ctx);
        const row = await db
          .selectFrom("run_projections")
          .selectAll()
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (row === undefined) return null;
        const timeline = await db
          .selectFrom("timeline_projections")
          .selectAll()
          .where("run_id", "=", input.runId)
          .orderBy("occurred_at", "asc")
          .orderBy("sequence", "asc")
          .execute();
        return operationsRunDetails.parse({
          run: JSON.parse(row.projection_json),
          timeline: timeline.map((entry) =>
            operationsTimelineEntry.parse({
              eventId: entry.event_id,
              kind: entry.kind,
              occurredAt: entry.occurred_at,
              payload: JSON.parse(entry.payload_json),
              runId: entry.run_id,
              sequence: entry.sequence,
            }),
          ),
        });
      },
      async getHealthV2(ctx) {
        const db = dbFrom(ctx);
        const checkedAt = (dependencies.now ?? (() => new Date()))();
        let storageReady = await booleanProbe(dependencies.storageReady);
        let pendingEffects = 0;
        let unreconciledEffects = 0;
        try {
          const rows = await db
            .selectFrom("effect_projections")
            .select(["status", "projection_json"])
            .execute();
          pendingEffects = rows.filter((row) => row.status === "queued").length;
          unreconciledEffects = rows.filter((row) => {
            const value = JSON.parse(row.projection_json) as SafeObject;
            return value.failureCategory === "ambiguous_network";
          }).length;
        } catch {
          storageReady = false;
        }
        let repositories: Record<string, "reachable" | "unreachable"> = {};
        try {
          repositories = (await dependencies.repositoryReachability?.()) ?? {};
        } catch {
          repositories = { probe: "unreachable" };
        }
        let pollLagMs: number | null = null;
        let staleLocks = 0;
        try {
          if (dependencies.pollLagMs !== undefined) {
            pollLagMs = await dependencies.pollLagMs();
          } else {
            const sourceFacts = await db
              .selectFrom("event_projections")
              .select("payload_json")
              .where("kind", "=", "source.accepted")
              .execute();
            let newestCursorAt: number | null = null;
            for (const sourceId of new Set(
              sourceFacts.map(({ payload_json }) =>
                String((JSON.parse(payload_json) as SafeObject).sourceId),
              ),
            )) {
              const cursor = await ctx.call(intake.calls.getSourceCursor, { sourceId });
              if (cursor === null) continue;
              const updatedAt = Date.parse(cursor.updatedAt);
              if (Number.isFinite(updatedAt))
                newestCursorAt =
                  newestCursorAt === null ? updatedAt : Math.max(newestCursorAt, updatedAt);
            }
            pollLagMs =
              newestCursorAt === null ? null : Math.max(0, checkedAt.getTime() - newestCursorAt);
          }
        } catch {
          pollLagMs = null;
        }
        try {
          staleLocks = (await dependencies.staleLocks?.()) ?? 0;
        } catch {
          staleLocks = 1;
        }
        const credentialsPresent = await booleanProbe(dependencies.credentialsPresent);
        const workflowReady = await booleanProbe(dependencies.workflowReady);
        let workerReady: boolean;
        if (dependencies.workerReady !== undefined) {
          workerReady = await booleanProbe(dependencies.workerReady);
        } else {
          try {
            const newest = await db
              .selectFrom("event_projections")
              .select(({ fn }) => fn.max<number>("sequence").as("sequence"))
              .executeTakeFirst();
            const heartbeat = await db
              .selectFrom("health_projection")
              .select("updated_at")
              .where("id", "=", "projection-worker")
              .executeTakeFirst();
            const heartbeatAt =
              heartbeat === undefined ? Number.NaN : Date.parse(heartbeat.updated_at);
            workerReady =
              heartbeat === undefined
                ? newest?.sequence === null || newest?.sequence === undefined
                : Number.isFinite(heartbeatAt) && checkedAt.getTime() - heartbeatAt <= 180_000;
          } catch {
            workerReady = false;
          }
        }
        const degraded =
          !storageReady ||
          !workflowReady ||
          !workerReady ||
          !credentialsPresent ||
          staleLocks > 0 ||
          unreconciledEffects > 0 ||
          Object.values(repositories).includes("unreachable");
        return operationsHealth.parse({
          adapters: { credentialsPresent, repositories },
          checkedAt: checkedAt.toISOString(),
          pendingEffects,
          pollLagMs,
          staleLocks,
          status: degraded ? "degraded" : "ready",
          storage: storageReady ? "ready" : "unavailable",
          unreconciledEffects,
          worker: workerReady ? "ready" : "unavailable",
          workflow: workflowReady ? "ready" : "unavailable",
        });
      },
      async listEventsV2(ctx, input) {
        const limit = pageSize(input.limit);
        let rows = await dbFrom(ctx)
          .selectFrom("event_projections")
          .selectAll()
          .orderBy("sequence", "asc")
          .orderBy("event_id", "asc")
          .execute();
        if (input.runId !== undefined) rows = rows.filter((row) => row.run_id === input.runId);
        if (input.after !== undefined) {
          const cursor = decodeCursor(input.after, eventPageCursor);
          rows = rows.filter(
            (row) =>
              row.sequence > cursor.sequence ||
              (row.sequence === cursor.sequence && row.event_id > cursor.eventId),
          );
        }
        const page = rows.slice(0, limit).map((row) =>
          operationsEvent.parse({
            eventId: row.event_id,
            kind: row.kind,
            occurredAt: row.occurred_at,
            payload: JSON.parse(row.payload_json),
            runId: row.run_id,
            sequence: row.sequence,
          }),
        );
        const last = page.at(-1);
        return operationsEventPage.parse({
          items: page,
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor({ eventId: last.eventId, sequence: last.sequence })
              : null,
        });
      },
      async listEffectsV2(ctx, input) {
        const limit = pageSize(input.limit);
        let rows = await dbFrom(ctx)
          .selectFrom("effect_projections")
          .selectAll()
          .orderBy("requested_at", "desc")
          .orderBy("idempotency_key", "asc")
          .execute();
        if (input.runId !== undefined) rows = rows.filter((row) => row.run_id === input.runId);
        if (input.after !== undefined) {
          const cursor = decodeCursor(input.after, effectPageCursor);
          rows = rows.filter(
            (row) =>
              row.requested_at < cursor.requestedAt ||
              (row.requested_at === cursor.requestedAt &&
                row.idempotency_key > cursor.idempotencyKey),
          );
        }
        const page = rows
          .slice(0, limit)
          .map((row) => operationsEffect.parse(JSON.parse(row.projection_json)));
        const last = page.at(-1);
        return operationsEffectPage.parse({
          items: page,
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor({ idempotencyKey: last.idempotencyKey, requestedAt: last.recordedAt })
              : null,
        });
      },
      async applyOperatorCommand(ctx, input) {
        const db = dbFrom(ctx);
        const commandJson = canonical(input);
        const existing = await db
          .selectFrom("operator_command_audit")
          .selectAll()
          .where("command_key", "=", input.commandKey)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (existing.command_json !== commandJson)
            throw new Error("command_conflict: command identity has different fields");
          if (existing.outcome === "applied") return auditFromRow(existing);
          if (existing.outcome === "rejected")
            await db
              .updateTable("operator_command_audit")
              .set({ error: null, outcome: "requested" })
              .where("command_key", "=", input.commandKey)
              .execute();
        } else {
          await db
            .insertInto("operator_command_audit")
            .values({
              actor: input.actor,
              applied_at: null,
              command_json: commandJson,
              command_key: input.commandKey,
              error: null,
              kind: input.kind,
              outcome: "requested",
              requested_at: input.requestedAt,
              result_json: null,
              run_id: input.runId,
            })
            .execute();
        }
        const result = await ctx.call(runs.calls.applyOperatorCommandV2, {
          commandId: input.commandKey,
          ...(input.correlationToken === undefined
            ? {}
            : { correlationToken: input.correlationToken }),
          ...(input.gateId === undefined ? {} : { gateId: input.gateId }),
          issuedAt: input.requestedAt,
          kind: input.kind,
          runId: input.runId,
        });
        await db
          .updateTable("operator_command_audit")
          .set({
            applied_at: input.requestedAt,
            error: null,
            outcome: "applied",
            result_json: canonical(result),
          })
          .where("command_key", "=", input.commandKey)
          .execute();
        return auditFromRow(
          await db
            .selectFrom("operator_command_audit")
            .selectAll()
            .where("command_key", "=", input.commandKey)
            .executeTakeFirstOrThrow(),
        );
      },
      async recordOperatorCommandRejection(ctx, input) {
        const db = dbFrom(ctx);
        const commandJson = canonical(input.request);
        const existing = await db
          .selectFrom("operator_command_audit")
          .selectAll()
          .where("command_key", "=", input.request.commandKey)
          .executeTakeFirst();
        if (existing?.command_json !== undefined && existing.command_json !== commandJson)
          throw new Error("command_conflict: command identity has different fields");
        if (existing?.outcome === "applied") return auditFromRow(existing);
        if (existing === undefined)
          await db
            .insertInto("operator_command_audit")
            .values({
              actor: input.request.actor,
              applied_at: null,
              command_json: commandJson,
              command_key: input.request.commandKey,
              error: input.error,
              kind: input.request.kind,
              outcome: "rejected",
              requested_at: input.request.requestedAt,
              result_json: null,
              run_id: input.request.runId,
            })
            .execute();
        else
          await db
            .updateTable("operator_command_audit")
            .set({
              applied_at: null,
              error: input.error,
              outcome: "rejected",
              result_json: null,
            })
            .where("command_key", "=", input.request.commandKey)
            .execute();
        return auditFromRow(
          await db
            .selectFrom("operator_command_audit")
            .selectAll()
            .where("command_key", "=", input.request.commandKey)
            .executeTakeFirstOrThrow(),
        );
      },
      async getOperatorCommand(ctx, input) {
        const row = await dbFrom(ctx)
          .selectFrom("operator_command_audit")
          .selectAll()
          .where("command_key", "=", input.commandKey)
          .executeTakeFirst();
        return row === undefined ? null : auditFromRow(row);
      },
      async refreshWorkerHeartbeat(ctx) {
        return await refreshWorkerHeartbeat(ctx);
      },
      async getTelemetrySnapshot(ctx, input) {
        if (!Number.isSafeInteger(input.stuckAfterMs) || input.stuckAfterMs < 0)
          throw new Error("invalid_threshold");
        const rows = await dbFrom(ctx)
          .selectFrom("event_projections")
          .selectAll()
          .where("run_id", "is not", null)
          .orderBy("sequence", "asc")
          .orderBy("event_id", "asc")
          .execute();
        const events = rows.map((row) =>
          replayEvent.parse({
            eventId: row.event_id,
            kind: row.kind,
            occurredAt: row.occurred_at,
            payload: JSON.parse(row.payload_json),
            runId: row.run_id,
            sequence: row.sequence,
          }),
        );
        const projectedPollLag =
          input.pollLagMs !== undefined
            ? input.pollLagMs
            : dependencies.pollLagMs === undefined
              ? null
              : await dependencies.pollLagMs();
        return projectOperationsTelemetry(
          events,
          input.checkedAt,
          input.stuckAfterMs,
          projectedPollLag,
        );
      },
      async exportReplayBundle(ctx, input) {
        const events = await replayEventsForRun(dbFrom(ctx), input.runId);
        const state = events.filter((event) => event.kind === "run.state").at(-1);
        if (state === undefined) throw new Error(`run_not_found: ${input.runId}`);
        const statePayload = state.payload as SafeObject;
        const artifacts = await ctx.call(assets.calls.listRunArtifactsV2, { runId: input.runId });
        const publicArtifacts = await Promise.all(
          artifacts
            .filter((artifact) => artifact.classification === "public")
            .map(async (artifact) => {
              const envelope = await ctx.call(assets.calls.getPublicArtifactV2, {
                digest: artifact.digest,
              });
              if (envelope === null) throw new Error(`artifact_corrupt: ${artifact.digest}`);
              return {
                classification: "public" as const,
                contentBase64: envelope.contentBase64,
                digest: artifact.digest,
                name: artifact.name,
                size: artifact.size,
              };
            }),
        );
        const publicArtifactDigests = new Set(publicArtifacts.map((artifact) => artifact.digest));
        const publishedBySource = new Map(
          artifacts.flatMap((artifact) =>
            artifact.classification === "public" && artifact.sourceDigest !== undefined
              ? [[artifact.sourceDigest, artifact.digest] as const]
              : [],
          ),
        );
        const stepSkillRows = await dbFrom(ctx)
          .selectFrom("step_replay_projections")
          .selectAll()
          .where("run_id", "=", input.runId)
          .execute();
        const stepSkills = new Map(
          stepSkillRows.map(
            (row) => [row.step_id, [row.skill_id, row.skill_digest] as [string, string]] as const,
          ),
        );
        const resultDocuments = events.flatMap((event) => {
          if (event.kind !== "attempt.finished") return [];
          const payload = event.payload as SafeObject;
          const selected = stepSkills.get(String(payload.stepId));
          const resultDocument = payload.resultDocument;
          if (selected === undefined || resultDocument === null || resultDocument === undefined)
            return [];
          const outputArtifactDigests = Array.isArray(
            (resultDocument as SafeObject).outputArtifactDigests,
          )
            ? ((resultDocument as SafeObject).outputArtifactDigests as string[]).flatMap(
                (digest) => {
                  const published = publishedBySource.get(digest);
                  if (published !== undefined) return [published];
                  return publicArtifactDigests.has(digest) ? [digest] : [];
                },
              )
            : [];
          return [
            {
              artifactDigests: outputArtifactDigests,
              result: resultDocument,
              runId: input.runId,
              skillDigest: selected[1],
              skillId: selected[0],
              stepId: String(payload.stepId),
            },
          ];
        });
        const bundle = createReplayBundle({
          artifactDigests: publicArtifacts,
          capabilities: input.capabilities,
          createdAt: input.createdAt,
          events,
          fixtures: input.fixtures,
          pins: {
            agentProfileDigests: statePayload.agentProfileDigests as Record<string, string>,
            definitionDigest: String(statePayload.definitionDigest),
            flowDigest: String(statePayload.flowDigest),
            moduleManifestDigest: String(statePayload.moduleManifestDigest),
            skillDigests: statePayload.skillDigests as Record<string, string>,
            workflowVersionDigest: String(statePayload.workflowVersionDigest),
          },
          redactionPolicy: input.redactionPolicy,
          resultDocuments,
          runId: input.runId,
        });
        return await persistReplayBundle(ctx, bundle);
      },
      async importReplayBundle(ctx, input) {
        return await persistReplayBundle(ctx, parseReplayBundle(input.bundle));
      },
      async getReplayBundle(ctx, input) {
        const envelope = await ctx.call(assets.calls.getPublicArtifactV2, {
          digest: input.digest,
        });
        if (envelope === null) return null;
        const bundle = parseReplayBundle(
          Buffer.from(envelope.contentBase64, "base64").toString("utf8"),
        );
        return replayBundleEnvelope.parse({ artifactDigest: envelope.artifact.digest, bundle });
      },
      async rebuildProjections(ctx) {
        return await rebuild(dbFrom(ctx));
      },
    },
    resources: {
      tables: [
        "effect_projections",
        "event_projections",
        "health_projection",
        "operator_command_audit",
        "run_projections",
        "timeline_projections",
        "step_replay_projections",
      ],
    },
  });
}

export const operationsImplementation = createOperationsImplementation();
