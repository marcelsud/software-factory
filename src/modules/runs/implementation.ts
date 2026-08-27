import { createHash } from "node:crypto";
import {
  type ChimpbaseModuleInterface,
  chimpbaseModuleResourcePrefix,
  defineChimpbaseModuleImplementation,
  defineChimpbaseModuleSubscription,
} from "chimpbase/core";
import { type ChimpbaseContext, type Infer, v, workflow } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import {
  type ExecutionPlanV2,
  type FactoryEvent,
  isDataRecord,
  type Run,
  type RunV2,
  type RunV3,
  run,
  runFinished,
  runFinishedV2,
  runFinishedV3,
  runV2,
  runV3,
} from "../../contracts/index.ts";
import {
  type RunEngineStateRow,
  type RunRow,
  type RunsDatabase,
  runsMigrations,
} from "../../storage/runs-database.ts";
import { definitions } from "../definitions/interface.ts";
import { effects } from "../effects/interface.ts";
import { execution } from "../execution/interface.ts";
import { intake } from "../intake/interface.ts";
import { runs } from "./interface.ts";

const implementationInterface = runs as unknown as ChimpbaseModuleInterface<
  typeof runs.calls,
  typeof runs.events
>;

const legacyRunWorkflow = workflow<{ runId: string }, { phase: "waiting" | "done" }>({
  name: "factory-runs",
  version: 1,
  initialState: () => ({ phase: "waiting" }),
  run(ctx) {
    if (ctx.state.phase === "done") return ctx.complete(ctx.state);
    return ctx.waitForSignal("finish", {
      state: ctx.state,
      onSignal: () => ({ phase: "done" }),
    });
  },
});

const workflowInput = v.object({ runId: v.string(), startedAt: v.string() });
const workflowState = v.object({
  logicalNow: v.string(),
  phase: v.enum(["drive", "waiting"]),
  wakeKind: v.string().optional(),
});
const workflowSignal = v.object({
  identity: v.string(),
  occurredAt: v.string(),
  wakeKind: v.string(),
});

export const FACTORY_RUNS_V2_WORKFLOW_DIGEST = createHash("sha256")
  .update(
    JSON.stringify({
      input: workflowInput.schema,
      name: "factory-runs-v2",
      signals: { resume: workflowSignal.schema },
      state: workflowState.schema,
      version: 2,
    }),
  )
  .digest("hex");
type GenericWorkflowState = Infer<typeof workflowState>;

const genericRunWorkflow = workflow<Infer<typeof workflowInput>, GenericWorkflowState>({
  name: "factory-runs-v2",
  version: 2,
  inputSchema: workflowInput,
  stateSchema: workflowState,
  signalSchemas: { resume: workflowSignal },
  initialState: (input) => ({ logicalNow: input.startedAt, phase: "drive" }),
  async run(ctx) {
    const directive = await ctx.call(runs.calls.driveRun, {
      now: ctx.state.logicalNow,
      runId: ctx.input.runId,
      ...(ctx.state.wakeKind === undefined ? {} : { wakeKind: ctx.state.wakeKind }),
    });
    if (directive.kind === "complete") return ctx.complete({ ...ctx.state, wakeKind: undefined });
    if (directive.kind === "sleep") {
      return ctx.sleep(directive.delayMs ?? 0, {
        state: { ...ctx.state, phase: "drive", wakeKind: "retry" },
        stepId: "retry-delay",
      });
    }
    return ctx.waitForSignal(directive.signal ?? "resume", {
      state: { ...ctx.state, phase: "waiting", wakeKind: undefined },
      stepId: directive.timeoutMs === undefined ? "wait" : "gate-wait",
      ...(directive.timeoutMs === undefined ? {} : { timeoutMs: directive.timeoutMs }),
      onSignal: ({ payload }) => {
        const wake = workflowSignal.parse(payload);
        return {
          logicalNow: wake.occurredAt,
          phase: "drive",
          wakeKind: wake.wakeKind,
        };
      },
      ...(directive.timeoutMs === undefined
        ? {}
        : {
            onTimeout: ({ state }) => ({
              logicalNow: state.logicalNow,
              phase: "drive" as const,
              wakeKind: "timeout",
            }),
          }),
    });
  },
});

export interface RunsImplementationDependencies {
  readonly moduleManifestDigest?: string;
  readonly workflowVersionDigest?: string;
}

type StartRunV2Input = Infer<typeof runs.calls.startRunV2.input>;
interface RunsContext {
  readonly db: { readonly schema: string | null; kysely(): unknown };
  readonly module: { readonly name: string } | null;
  readonly publish: ChimpbaseContext["publish"];
  readonly workflow: ChimpbaseContext["workflow"];
}

function runsDb(ctx: RunsContext): Kysely<RunsDatabase> {
  if (ctx.module?.name !== "runs" || ctx.db.schema !== "chimpbase_runs") {
    throw new Error("runs module context required");
  }
  return ctx.db.kysely() as Kysely<RunsDatabase>;
}

type ModuleContext = RunsContext;

function digestIdentity(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function scopedWorkflowId(workflowId: string): string {
  const prefix = chimpbaseModuleResourcePrefix("runs", "workflow-instance");
  return workflowId.startsWith(prefix) ? workflowId : `${prefix}${workflowId}`;
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  );
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function runFromRow(row: RunRow): RunV2 {
  return runV2.parse({
    agentProfileDigests: JSON.parse(row.agent_profile_digests_json),
    auditSequence: row.audit_sequence,
    ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
    ...(row.current_correlation_token === null
      ? {}
      : { currentCorrelationToken: row.current_correlation_token }),
    ...(row.current_effect_key === null ? {} : { currentEffectKey: row.current_effect_key }),
    ...(row.current_gate_id === null ? {} : { currentGateId: row.current_gate_id }),
    ...(row.current_gate_status === null ? {} : { currentGateStatus: row.current_gate_status }),
    ...(row.current_step_id === null ? {} : { currentStepId: row.current_step_id }),
    definitionDigest: row.definition_digest,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    factoryEventId: row.factory_event_id,
    flowDigest: row.flow_digest,
    flowId: row.flow_id,
    moduleManifestDigest: row.module_manifest_digest,
    runId: row.run_id,
    skillDigests: JSON.parse(row.skill_digests_json),
    startedAt: row.started_at,
    stateId: row.state_id,
    status: row.status,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    workflowVersionDigest: row.workflow_version_digest,
  });
}

function runV1FromV2(value: RunV2): Run {
  return run.parse({
    agentProfileDigests: value.agentProfileDigests,
    definitionDigest: value.definitionDigest,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    factoryEventId: value.factoryEventId,
    flowDigest: value.flowDigest,
    flowId: value.flowId,
    moduleManifestDigest: value.moduleManifestDigest,
    runId: value.runId,
    skillDigests: value.skillDigests,
    startedAt: value.startedAt,
    stateId: value.stateId,
    status: value.status === "paused" ? "waiting" : value.status,
    workflowVersionDigest: value.workflowVersionDigest,
  });
}

function runV3FromRows(row: RunRow, engine: RunEngineStateRow): RunV3 {
  const base = runFromRow(row);
  const status =
    engine.engine_phase === "queued"
      ? "queued"
      : engine.engine_phase === "retrying"
        ? "retrying"
        : base.status;
  return runV3.parse({ ...base, outcome: engine.outcome, status });
}

function finishedV2(value: RunV2) {
  if (value.finishedAt === undefined || !isTerminal(value.status))
    throw new Error("run is not terminal");
  return runFinishedV2.parse({
    agentProfileDigests: value.agentProfileDigests,
    auditSequence: value.auditSequence,
    definitionDigest: value.definitionDigest,
    factoryEventId: value.factoryEventId,
    finishedAt: value.finishedAt,
    flowDigest: value.flowDigest,
    flowId: value.flowId,
    moduleManifestDigest: value.moduleManifestDigest,
    runId: value.runId,
    skillDigests: value.skillDigests,
    startedAt: value.startedAt,
    stateId: value.stateId,
    status: value.status,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    workflowVersionDigest: value.workflowVersionDigest,
  });
}

function finishedV1(value: RunV2) {
  const strict = finishedV2(value);
  return runFinished.parse({
    agentProfileDigests: strict.agentProfileDigests,
    definitionDigest: strict.definitionDigest,
    factoryEventId: strict.factoryEventId,
    finishedAt: strict.finishedAt,
    flowDigest: strict.flowDigest,
    flowId: strict.flowId,
    moduleManifestDigest: strict.moduleManifestDigest,
    runId: strict.runId,
    skillDigests: strict.skillDigests,
    startedAt: strict.startedAt,
    stateId: strict.stateId,
    status: strict.status,
    workflowVersionDigest: strict.workflowVersionDigest,
  });
}

function finishedV3(value: RunV3) {
  if (value.finishedAt === undefined || !isTerminal(value.status))
    throw new Error("run is not terminal");
  return runFinishedV3.parse({
    agentProfileDigests: value.agentProfileDigests,
    auditSequence: value.auditSequence,
    definitionDigest: value.definitionDigest,
    factoryEventId: value.factoryEventId,
    finishedAt: value.finishedAt,
    flowDigest: value.flowDigest,
    flowId: value.flowId,
    moduleManifestDigest: value.moduleManifestDigest,
    outcome: value.outcome,
    runId: value.runId,
    skillDigests: value.skillDigests,
    startedAt: value.startedAt,
    stateId: value.stateId,
    status: value.status,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    workflowVersionDigest: value.workflowVersionDigest,
  });
}

async function appendAudit(
  db: Kysely<RunsDatabase>,
  row: RunRow,
  kind: string,
  occurredAt: string,
  payload: unknown,
  patch: Partial<RunRow> = {},
): Promise<RunRow> {
  const sequence = row.audit_sequence + 1;
  await db
    .insertInto("run_audit")
    .values({
      audit_json: JSON.stringify(payload),
      kind,
      occurred_at: occurredAt,
      run_id: row.run_id,
      sequence,
    })
    .execute();
  await db
    .updateTable("runs")
    .set({ ...patch, audit_sequence: sequence })
    .where("run_id", "=", row.run_id)
    .execute();
  return { ...row, ...patch, audit_sequence: sequence };
}

async function loadRows(db: Kysely<RunsDatabase>, runId: string) {
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const engine = await db
    .selectFrom("run_engine_state")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();
  return { engine: engine ?? null, row };
}

function sameLegacyIdentity(
  row: RunRow,
  input: StartRunV2Input,
  initialCorrelationJson: string,
): boolean {
  return (
    row.run_id === input.runId &&
    row.factory_event_id === input.factoryEventId &&
    row.workflow_id === scopedWorkflowId(input.workflowId) &&
    row.workflow_version === input.workflowVersion &&
    row.workflow_version_digest === input.workflowVersionDigest &&
    row.definition_digest === input.definitionDigest &&
    row.flow_id === input.flowId &&
    row.flow_digest === input.flowDigest &&
    recordsEqual(JSON.parse(row.agent_profile_digests_json), input.agentProfileDigests) &&
    recordsEqual(JSON.parse(row.skill_digests_json), input.skillDigests) &&
    row.module_manifest_digest === input.moduleManifestDigest &&
    row.started_at === input.startedAt &&
    initialCorrelationJson === JSON.stringify(input.correlation ?? null)
  );
}

async function loadInitialCorrelation(db: Kysely<RunsDatabase>, runId: string): Promise<string> {
  const identity = await db
    .selectFrom("run_identities")
    .select("initial_correlation_json")
    .where("run_id", "=", runId)
    .executeTakeFirst();
  if (identity === undefined) throw new Error("run_exists: immutable run identity is missing");
  return identity.initial_correlation_json;
}

function triggerMatches(plan: ExecutionPlanV2, event: FactoryEvent): boolean {
  return plan.triggers.some((trigger) => {
    if (trigger.sourceId !== event.sourceId) return false;
    return trigger.predicates.every((predicate) => {
      const path = predicate.field.split(".");
      let value: unknown = event;
      for (const segment of path) {
        if (!isDataRecord(value)) {
          value = undefined;
          break;
        }
        value = value[segment];
      }
      if (predicate.operator === "exists") return value !== undefined && value !== null;
      if (typeof value !== "string") return false;
      if (predicate.operator === "equals") return value === predicate.value;
      if (predicate.operator === "not_equals") return value !== predicate.value;
      if (predicate.operator === "in") return predicate.values?.includes(value) === true;
      return predicate.values?.includes(value) !== true;
    });
  });
}

function admissionScope(
  plan: ExecutionPlanV2,
  event: Pick<FactoryEvent, "repository" | "subject">,
): string {
  const agent = plan.steps.find((step) => step.agentProfile !== undefined)?.agentProfile ?? "none";
  const value =
    plan.concurrency.key === "repository"
      ? event.repository
      : plan.concurrency.key === "subject"
        ? event.subject
        : plan.concurrency.key === "flow"
          ? plan.flowId
          : plan.concurrency.key === "agent-profile"
            ? agent
            : `${event.repository}\0${event.subject}`;
  return `${plan.concurrency.key}\0${value}`;
}

async function publishProjection(
  ctx: ModuleContext,
  row: RunRow,
  engine?: RunEngineStateRow,
): Promise<void> {
  const projection = runFromRow(row);
  ctx.publish(runs.events.runStateChangedV1, runV1FromV2(projection));
  ctx.publish(runs.events.runStateChangedV2, projection);
  if (engine !== undefined) ctx.publish(runs.events.runStateChangedV3, runV3FromRows(row, engine));
}

async function signalResume(
  ctx: ModuleContext,
  row: RunRow,
  identity: string,
  occurredAt: string,
  wakeKind: string,
): Promise<void> {
  await ctx.workflow.signal(row.workflow_id, "resume", { identity, occurredAt, wakeKind });
}

async function recordWorkflowSignal(
  ctx: ModuleContext,
  row: RunRow,
  identity: string,
  kind: string,
  correlationToken: string,
  occurredAt: string,
  payload: unknown,
): Promise<boolean> {
  const db = runsDb(ctx);
  const duplicate = await db
    .selectFrom("workflow_signals")
    .select("identity")
    .where("identity", "=", identity)
    .executeTakeFirst();
  if (duplicate !== undefined) return false;
  await db
    .insertInto("workflow_signals")
    .values({
      correlation_token: correlationToken,
      identity,
      payload_json: JSON.stringify(payload),
      recorded_at: occurredAt,
      run_id: row.run_id,
      signal_kind: kind,
    })
    .execute();
  return true;
}

async function finishEngineRun(
  ctx: ModuleContext,
  row: RunRow,
  engine: RunEngineStateRow,
  stateId: string,
  outcome: RunV3["outcome"],
  occurredAt: string,
  terminal?: "success" | "failure",
): Promise<{ engine: RunEngineStateRow; row: RunRow }> {
  if (isTerminal(row.status)) return { engine, row };
  const status =
    outcome === "cancelled"
      ? "cancelled"
      : terminal === "success"
        ? "succeeded"
        : terminal === "failure"
          ? "failed"
          : outcome === "completed" || outcome === "not_actionable"
            ? "succeeded"
            : "failed";
  const cleared: Partial<RunRow> = {
    current_attempt_id: null,
    current_correlation_token: null,
    current_effect_key: null,
    current_gate_id: null,
    current_gate_status: null,
    current_step_id: null,
    finished_at: occurredAt,
    state_id: stateId,
    status,
  };
  const db = runsDb(ctx);
  const updatedRow = await appendAudit(
    db,
    row,
    "run.finished",
    occurredAt,
    { outcome, stateId, status },
    cleared,
  );
  const updatedEngine = {
    ...engine,
    engine_phase: "terminal",
    outcome,
    pending_json: null,
    terminal_published: 1,
  };
  await db
    .updateTable("run_engine_state")
    .set({
      engine_phase: updatedEngine.engine_phase,
      outcome: updatedEngine.outcome,
      pending_json: null,
      terminal_published: 1,
    })
    .where("run_id", "=", row.run_id)
    .execute();
  const admission = await db
    .selectFrom("run_admissions")
    .selectAll()
    .where("run_id", "=", row.run_id)
    .executeTakeFirst();
  if (admission !== undefined && admission.status !== "released") {
    await db.deleteFrom("run_admission_slots").where("run_id", "=", row.run_id).execute();
    await db
      .updateTable("run_admissions")
      .set({ status: "released" })
      .where("run_id", "=", row.run_id)
      .execute();
    const next = await db
      .selectFrom("run_admissions")
      .select("run_id")
      .where("scope_key", "=", admission.scope_key)
      .where("status", "=", "queued")
      .orderBy("requested_at", "asc")
      .orderBy("run_id", "asc")
      .executeTakeFirst();
    if (next !== undefined) {
      const nextRun = await db
        .selectFrom("runs")
        .selectAll()
        .where("run_id", "=", next.run_id)
        .executeTakeFirst();
      if (nextRun !== undefined)
        await signalResume(ctx, nextRun, `admission:${row.run_id}`, occurredAt, "admission");
    }
  }
  const projection = runFromRow(updatedRow);
  await publishProjection(ctx, updatedRow, updatedEngine);
  ctx.publish(runs.events.runFinishedV1, finishedV1(projection));
  ctx.publish(runs.events.runFinishedV2, finishedV2(projection));
  ctx.publish(runs.events.runFinishedV3, finishedV3(runV3FromRows(updatedRow, updatedEngine)));
  return { engine: updatedEngine, row: updatedRow };
}

function inputArtifacts(
  plan: ExecutionPlanV2,
  stepId: string,
  engine: RunEngineStateRow,
): string[] {
  const outputs = JSON.parse(engine.artifact_outputs_json) as Record<string, string[]>;
  return [
    ...new Set(
      plan.artifactHandoffs
        .filter((edge) => edge.toStep === stepId)
        .flatMap((edge) => outputs[edge.fromStep] ?? []),
    ),
  ].sort();
}

async function transition(
  db: Kysely<RunsDatabase>,
  row: RunRow,
  engine: RunEngineStateRow,
  plan: ExecutionPlanV2,
  outcome: string,
  occurredAt: string,
  outputDigests: readonly string[] = [],
  signalMode = false,
): Promise<{ engine: RunEngineStateRow; row: RunRow } | null> {
  const edge = plan.transitions.find(
    (candidate) =>
      candidate.from === row.state_id &&
      candidate.on === outcome &&
      candidate.mode === (signalMode ? "signal" : "immediate"),
  );
  if (edge === undefined) return null;
  const outputs = JSON.parse(engine.artifact_outputs_json) as Record<string, string[]>;
  if (row.current_step_id !== null) outputs[row.current_step_id] = [...outputDigests];
  const target = plan.states.find((state) => state.id === edge.to);
  if (target === undefined) return null;
  const nextRow = await appendAudit(
    db,
    row,
    "state.transitioned",
    occurredAt,
    { from: row.state_id, on: outcome, to: edge.to },
    {
      current_attempt_id: null,
      current_correlation_token: null,
      current_effect_key: null,
      current_gate_id: null,
      current_gate_status: null,
      current_step_id: target.step ?? null,
      state_id: target.id,
      status: target.gate === undefined ? "running" : "waiting",
    },
  );
  const nextEngine = {
    ...engine,
    artifact_outputs_json: JSON.stringify(outputs),
    attempt_count: 0,
    engine_phase: target.gate === undefined ? "runnable" : "waiting",
    paused_from_phase: null,
    last_outcome: outcome,
    outcome: target.gate === undefined ? engine.outcome : "waiting",
    pending_json: null,
    retry_delay_ms: null,
    state_generation: engine.state_generation + 1,
  };
  await db
    .updateTable("run_engine_state")
    .set({
      artifact_outputs_json: nextEngine.artifact_outputs_json,
      attempt_count: 0,
      engine_phase: nextEngine.engine_phase,
      paused_from_phase: null,
      last_outcome: outcome,
      outcome: nextEngine.outcome,
      pending_json: null,
      retry_delay_ms: null,
      state_generation: nextEngine.state_generation,
    })
    .where("run_id", "=", row.run_id)
    .execute();
  return { engine: nextEngine, row: nextRow };
}

async function scheduleRetry(
  db: Kysely<RunsDatabase>,
  row: RunRow,
  engine: RunEngineStateRow,
  plan: ExecutionPlanV2,
  occurredAt: string,
): Promise<{ delayMs: number; engine: RunEngineStateRow; row: RunRow } | null> {
  const state = plan.states.find((candidate) => candidate.id === row.state_id);
  const step = plan.steps.find((candidate) => candidate.id === state?.step);
  if (step === undefined || engine.attempt_count >= step.retry.maxAttempts) return null;
  const delayMs = step.retry.backoffMs * 2 ** Math.max(0, engine.attempt_count - 1);
  const nextRow = await appendAudit(
    db,
    row,
    "step.retry_scheduled",
    occurredAt,
    { attempt: engine.attempt_count + 1, delayMs, stepId: step.id },
    {
      current_attempt_id: null,
      current_correlation_token: null,
      current_effect_key: null,
      status: "waiting",
    },
  );
  const nextEngine = {
    ...engine,
    engine_phase: "retrying",
    pending_json: null,
    retry_delay_ms: delayMs,
  };
  await db
    .updateTable("run_engine_state")
    .set({ engine_phase: "retrying", pending_json: null, retry_delay_ms: delayMs })
    .where("run_id", "=", row.run_id)
    .execute();
  return { delayMs, engine: nextEngine, row: nextRow };
}

function validResult(
  step: ExecutionPlanV2["steps"][number],
  result: unknown,
): result is {
  data: Record<string, unknown>;
  outcome: string;
  outputArtifactDigests: string[];
  summary: string;
} {
  if (
    !isDataRecord(result) ||
    !isDataRecord(result.data) ||
    typeof result.outcome !== "string" ||
    !Array.isArray(result.outputArtifactDigests) ||
    !result.outputArtifactDigests.every((entry) => typeof entry === "string") ||
    typeof result.summary !== "string"
  )
    return false;
  const data = result.data;
  const outputArtifactDigests = result.outputArtifactDigests;
  const contract = step.resultContracts.find((candidate) => candidate.outcome === result.outcome);
  if (
    contract === undefined ||
    new Set(outputArtifactDigests).size < contract.requiredArtifactCount ||
    !contract.requiredData.every((key) => Object.hasOwn(data, key))
  )
    return false;
  return Object.entries(contract.dataTypes).every(([key, expected]) => {
    if (!Object.hasOwn(data, key)) return false;
    return expected === "unknown" || typeof data[key] === expected;
  });
}

function createSubscriptions(dependencies: RunsImplementationDependencies) {
  const attemptFinished = defineChimpbaseModuleSubscription(
    execution.events.attemptFinishedV1,
    "record-attempt-outcome",
    async (ctx, outcome) => {
      const db = runsDb(ctx);
      const loaded = await loadRows(db, outcome.runId);
      if (
        loaded === null ||
        isTerminal(loaded.row.status) ||
        loaded.row.current_attempt_id !== outcome.attemptId ||
        loaded.row.current_correlation_token !== outcome.correlationToken
      )
        return false;
      if (loaded.engine === null) {
        const failed = outcome.outcome === "failed";
        const updated = await appendAudit(
          db,
          loaded.row,
          `attempt.${outcome.outcome}`,
          outcome.finishedAt,
          outcome,
          {
            current_attempt_id: null,
            current_correlation_token: failed ? null : loaded.row.current_correlation_token,
            current_effect_key: failed ? null : loaded.row.current_effect_key,
            current_gate_id: failed ? null : loaded.row.current_gate_id,
            current_gate_status: failed ? null : loaded.row.current_gate_status,
            current_step_id: failed ? null : loaded.row.current_step_id,
            finished_at: failed ? outcome.finishedAt : loaded.row.finished_at,
            status: failed ? "failed" : "running",
          },
        );
        await publishProjection(ctx, updated);
        if (failed) {
          await ctx.workflow.signal(updated.workflow_id, "finish", {});
          const projection = runFromRow(updated);
          ctx.publish(runs.events.runFinishedV1, finishedV1(projection));
          ctx.publish(runs.events.runFinishedV2, finishedV2(projection));
        }
        return true;
      }
      const identity = `attempt:${outcome.attemptId}:${outcome.finishedAt}`;
      if (
        !(await recordWorkflowSignal(
          ctx,
          loaded.row,
          identity,
          "attempt.finished",
          outcome.correlationToken,
          outcome.finishedAt,
          outcome,
        ))
      )
        return false;
      const row = await appendAudit(
        db,
        loaded.row,
        `attempt.${outcome.outcome}`,
        outcome.finishedAt,
        outcome,
      );
      await db
        .updateTable("run_engine_state")
        .set({ pending_json: JSON.stringify({ kind: "attempt", outcome }) })
        .where("run_id", "=", row.run_id)
        .execute();
      await signalResume(ctx, row, identity, outcome.finishedAt, "attempt.finished");
      return true;
    },
  );

  const effectFinished = defineChimpbaseModuleSubscription(
    effects.events.effectFinishedV2,
    "record-effect-outcome",
    async (ctx, outcome) => {
      const db = runsDb(ctx);
      const loaded = await loadRows(db, outcome.runId);
      if (
        loaded === null ||
        isTerminal(loaded.row.status) ||
        loaded.row.current_effect_key !== outcome.idempotencyKey ||
        loaded.row.current_correlation_token !== outcome.correlationToken
      )
        return false;
      if (loaded.engine === null) {
        const failed = outcome.outcome === "rejected";
        const updated = await appendAudit(
          db,
          loaded.row,
          `effect.${outcome.outcome}`,
          outcome.finishedAt,
          outcome,
          {
            current_attempt_id: failed ? null : loaded.row.current_attempt_id,
            current_correlation_token: failed ? null : loaded.row.current_correlation_token,
            current_effect_key:
              outcome.outcome === "ambiguous" ? loaded.row.current_effect_key : null,
            current_gate_id: failed ? null : loaded.row.current_gate_id,
            current_gate_status: failed ? null : loaded.row.current_gate_status,
            current_step_id: failed ? null : loaded.row.current_step_id,
            finished_at: failed ? outcome.finishedAt : loaded.row.finished_at,
            status: failed ? "failed" : outcome.outcome === "ambiguous" ? "waiting" : "running",
          },
        );
        await publishProjection(ctx, updated);
        if (failed) {
          await ctx.workflow.signal(updated.workflow_id, "finish", {});
          const projection = runFromRow(updated);
          ctx.publish(runs.events.runFinishedV1, finishedV1(projection));
          ctx.publish(runs.events.runFinishedV2, finishedV2(projection));
        }
        return true;
      }
      const identity = `effect:${outcome.idempotencyKey}:${outcome.finishedAt}`;
      if (
        !(await recordWorkflowSignal(
          ctx,
          loaded.row,
          identity,
          "effect.finished",
          outcome.correlationToken,
          outcome.finishedAt,
          outcome,
        ))
      )
        return false;
      const row = await appendAudit(
        db,
        loaded.row,
        `effect.${outcome.outcome}`,
        outcome.finishedAt,
        outcome,
      );
      await db
        .updateTable("run_engine_state")
        .set({ pending_json: JSON.stringify({ kind: "effect", outcome }) })
        .where("run_id", "=", row.run_id)
        .execute();
      await signalResume(ctx, row, identity, outcome.finishedAt, "effect.finished");
      return true;
    },
  );

  const acceptedEvent = defineChimpbaseModuleSubscription(
    intake.events.factoryEventAcceptedV2,
    "start-matching-runs",
    async (ctx, accepted) => {
      if (
        dependencies.moduleManifestDigest === undefined ||
        dependencies.workflowVersionDigest === undefined
      )
        return 0;
      const active = await ctx.call(definitions.calls.getActiveDefinition, {});
      if (active === null) return 0;
      let started = 0;
      for (const flowId of Object.keys(active.flowDigests).sort()) {
        const plan = await ctx.call(definitions.calls.getExecutionPlanV2, {
          definitionDigest: active.definitionDigest,
          flowId,
        });
        if (plan === null || !triggerMatches(plan, accepted.event)) continue;
        const identity = digestIdentity(
          "factory-event",
          accepted.event.sourceId,
          accepted.event.deliveryId,
        );
        const runId = digestIdentity("run", active.definitionDigest, plan.flowDigest, identity);
        await ctx.call(runs.calls.startRunV3, {
          definitionDigest: active.definitionDigest,
          factoryEventId: `${identity}:${flowId}`,
          flowId,
          moduleManifestDigest: dependencies.moduleManifestDigest,
          repository: accepted.event.repository,
          runId,
          startedAt: accepted.event.observedAt,
          subject: accepted.event.subject,
          workflowId: digestIdentity("workflow", runId),
          workflowVersionDigest: dependencies.workflowVersionDigest,
        });
        started += 1;
      }
      const db = runsDb(ctx);
      const waiting = await db
        .selectFrom("run_engine_state")
        .select("run_id")
        .where("engine_phase", "=", "waiting")
        .execute();
      for (const candidate of waiting) {
        const loaded = await loadRows(db, candidate.run_id);
        if (
          loaded === null ||
          loaded.engine === null ||
          loaded.engine.repository !== accepted.event.repository ||
          loaded.engine.subject !== accepted.event.subject ||
          loaded.row.current_gate_id === null ||
          loaded.row.current_correlation_token === null
        )
          continue;
        const plan = await ctx.call(definitions.calls.getExecutionPlanV2, {
          definitionDigest: loaded.row.definition_digest,
          flowId: loaded.row.flow_id,
        });
        const state = plan?.states.find((entry) => entry.id === loaded.row.state_id);
        const gate = plan?.gates.find((entry) => entry.id === state?.gate);
        if (gate?.kind !== "event") continue;
        const signal = gate.accepted.find(
          (entry) =>
            entry === accepted.event.eventType || entry === `event.${accepted.event.eventType}`,
        );
        if (signal === undefined) continue;
        await ctx.call(runs.calls.signalRun, {
          correlationToken: loaded.row.current_correlation_token,
          gateId: loaded.row.current_gate_id,
          identity: digestIdentity(
            "gate-event",
            accepted.event.sourceId,
            accepted.event.deliveryId,
            loaded.row.run_id,
          ),
          occurredAt: accepted.event.observedAt,
          runId: loaded.row.run_id,
          signal,
        });
      }
      return started;
    },
  );
  return [attemptFinished, effectFinished, acceptedEvent] as const;
}

export function createRunsImplementation(dependencies: RunsImplementationDependencies = {}) {
  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: runsMigrations,
    registrations: [legacyRunWorkflow, genericRunWorkflow],
    subscriptions: createSubscriptions(dependencies),
    resources: {
      collections: [
        "operator-commands",
        "run-admissions",
        "run-admission-slots",
        "run-engine-state",
        "run-gates",
        "runs",
        "workflow-signals",
      ],
      tables: [
        "operator_commands",
        "run_admission_slots",
        "run_admissions",
        "run_audit",
        "run_engine_state",
        "run_gates",
        "run_identities",
        "runs",
        "workflow_signals",
      ],
      workflows: ["factory-runs", "factory-runs-v2"],
    },
    calls: {
      async startRun(ctx, input) {
        const projection = await ctx.call(runs.calls.startRunV2, {
          ...input,
          workflowId: input.runId,
          workflowVersion: legacyRunWorkflow.definition.version,
        });
        return runV1FromV2(projection);
      },
      async startRunV2(ctx, input) {
        const db = runsDb(ctx);
        const existing = await db
          .selectFrom("runs")
          .selectAll()
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (
            !sameLegacyIdentity(existing, input, await loadInitialCorrelation(db, existing.run_id))
          )
            throw new Error("run_exists: immutable run identity has different pins");
          return runFromRow(existing);
        }
        const existingEvent = await db
          .selectFrom("runs")
          .selectAll()
          .where("factory_event_id", "=", input.factoryEventId)
          .executeTakeFirst();
        if (existingEvent !== undefined) {
          if (
            !sameLegacyIdentity(
              existingEvent,
              input,
              await loadInitialCorrelation(db, existingEvent.run_id),
            )
          )
            throw new Error("run_exists: factory event identity has different pins");
          return runFromRow(existingEvent);
        }
        if (input.workflowVersion !== legacyRunWorkflow.definition.version)
          throw new Error("invalid_revision_pin: unsupported workflow version");
        const plan = await ctx.call(definitions.calls.getExecutionPlan, {
          definitionDigest: input.definitionDigest,
          flowId: input.flowId,
        });
        if (
          plan === null ||
          plan.flowDigest !== input.flowDigest ||
          !recordsEqual(plan.agentProfileDigests, input.agentProfileDigests) ||
          !recordsEqual(plan.skillRevisions, input.skillDigests)
        )
          throw new Error(
            "invalid_revision_pin: run pins do not match the compiled execution plan",
          );
        const instance = await ctx.workflow.start(
          legacyRunWorkflow,
          { runId: input.runId },
          { workflowId: input.workflowId },
        );
        const state = plan.states.find((candidate) => candidate.id === plan.initialState);
        if (state === undefined) throw new Error("invalid_revision_pin: initial state is missing");
        const correlation = input.correlation;
        const gate =
          correlation?.gateId === undefined
            ? undefined
            : plan.gates.find((candidate) => candidate.id === correlation.gateId);
        if (correlation?.gateId !== undefined && gate === undefined)
          throw new Error("invalid_revision_pin: correlated gate is not declared");
        const row: RunRow = {
          agent_profile_digests_json: JSON.stringify(input.agentProfileDigests),
          audit_sequence: 1,
          current_attempt_id: correlation?.attemptId ?? null,
          current_correlation_token: correlation?.correlationToken ?? null,
          current_effect_key: correlation?.effectKey ?? null,
          current_gate_id: correlation?.gateId ?? null,
          current_gate_status: gate === undefined ? null : "pending",
          current_step_id: correlation?.stepId ?? state.step ?? null,
          definition_digest: input.definitionDigest,
          factory_event_id: input.factoryEventId,
          finished_at: null,
          flow_digest: input.flowDigest,
          flow_id: input.flowId,
          module_manifest_digest: input.moduleManifestDigest,
          run_id: input.runId,
          skill_digests_json: JSON.stringify(input.skillDigests),
          started_at: input.startedAt,
          state_id: plan.initialState,
          status: gate === undefined ? "running" : "waiting",
          workflow_id: instance.workflowId,
          workflow_version: input.workflowVersion,
          workflow_version_digest: input.workflowVersionDigest,
        };
        await db.insertInto("runs").values(row).execute();
        await db
          .insertInto("run_identities")
          .values({
            initial_correlation_json: JSON.stringify(input.correlation ?? null),
            run_id: input.runId,
          })
          .execute();
        await db
          .insertInto("run_audit")
          .values({
            audit_json: JSON.stringify({ factoryEventId: input.factoryEventId }),
            kind: "run.started",
            occurred_at: input.startedAt,
            run_id: input.runId,
            sequence: 1,
          })
          .execute();
        if (gate !== undefined && correlation !== undefined)
          await db
            .insertInto("run_gates")
            .values({
              accepted_json: JSON.stringify(gate.accepted),
              correlation_token: correlation.correlationToken,
              gate_id: gate.id,
              kind: gate.kind,
              run_id: input.runId,
              satisfied_at: null,
              satisfied_by: null,
              status: "pending",
            })
            .execute();
        await publishProjection(ctx, row);
        if (row.current_step_id !== null && row.current_correlation_token !== null)
          ctx.publish(runs.events.stepRequestedV1, {
            correlationToken: row.current_correlation_token,
            runId: row.run_id,
            stepId: row.current_step_id,
          });
        return runFromRow(row);
      },
      async startRunV3(ctx, input) {
        if (
          dependencies.moduleManifestDigest === undefined ||
          dependencies.workflowVersionDigest === undefined ||
          input.moduleManifestDigest !== dependencies.moduleManifestDigest ||
          input.workflowVersionDigest !== dependencies.workflowVersionDigest
        )
          throw new Error(
            "invalid_revision_pin: trusted composition pins are missing or unverified",
          );
        const db = runsDb(ctx);
        const existing = await loadRows(db, input.runId);
        if (existing !== null) {
          if (
            existing.engine === null ||
            existing.row.definition_digest !== input.definitionDigest ||
            existing.row.flow_id !== input.flowId ||
            existing.row.factory_event_id !== input.factoryEventId ||
            existing.row.module_manifest_digest !== input.moduleManifestDigest ||
            existing.row.started_at !== input.startedAt ||
            existing.row.workflow_id !== scopedWorkflowId(input.workflowId) ||
            existing.row.workflow_version_digest !== input.workflowVersionDigest ||
            existing.engine.repository !== input.repository ||
            existing.engine.subject !== input.subject
          )
            throw new Error("run_exists: immutable run identity has different pins");
          return runV3FromRows(existing.row, existing.engine);
        }
        const active = await ctx.call(definitions.calls.getActiveDefinition, {});
        if (active === null || active.definitionDigest !== input.definitionDigest)
          throw new Error("invalid_revision_pin: definition is not active");
        const plan = await ctx.call(definitions.calls.getExecutionPlanV2, {
          definitionDigest: input.definitionDigest,
          flowId: input.flowId,
        });
        if (plan === null || active.flowDigests[input.flowId] !== plan.flowDigest)
          throw new Error("invalid_revision_pin: strict execution plan is missing");
        const initial = plan.states.find((state) => state.id === plan.initialState);
        if (initial === undefined)
          throw new Error("invalid_revision_pin: initial state is missing");
        const workflowId = scopedWorkflowId(input.workflowId);
        const row: RunRow = {
          agent_profile_digests_json: JSON.stringify(plan.agentProfileDigests),
          audit_sequence: 1,
          current_attempt_id: null,
          current_correlation_token: null,
          current_effect_key: null,
          current_gate_id: null,
          current_gate_status: null,
          current_step_id: initial.step ?? null,
          definition_digest: plan.definitionDigest,
          factory_event_id: input.factoryEventId,
          finished_at: null,
          flow_digest: plan.flowDigest,
          flow_id: plan.flowId,
          module_manifest_digest: input.moduleManifestDigest,
          run_id: input.runId,
          skill_digests_json: JSON.stringify(plan.skillRevisions),
          started_at: input.startedAt,
          state_id: initial.id,
          status: "waiting",
          workflow_id: workflowId,
          workflow_version: 2,
          workflow_version_digest: input.workflowVersionDigest,
        };
        const engine: RunEngineStateRow = {
          artifact_outputs_json: "{}",
          attempt_count: 0,
          engine_phase: "queued",
          paused_from_phase: null,
          last_outcome: null,
          outcome: "waiting",
          pending_json: null,
          repository: input.repository,
          retry_delay_ms: null,
          state_generation: 0,
          run_id: input.runId,
          subject: input.subject,
          terminal_published: 0,
        };
        await db.insertInto("runs").values(row).execute();
        await db
          .insertInto("run_identities")
          .values({ initial_correlation_json: "null", run_id: input.runId })
          .execute();
        await db.insertInto("run_engine_state").values(engine).execute();
        await db
          .insertInto("run_admissions")
          .values({
            limit_value: plan.concurrency.limit,
            requested_at: input.startedAt,
            run_id: input.runId,
            scope_key: admissionScope(plan, input),
            status: "queued",
          })
          .execute();
        await db
          .insertInto("run_audit")
          .values({
            audit_json: JSON.stringify({
              factoryEventId: input.factoryEventId,
              pins: {
                definitionDigest: plan.definitionDigest,
                flowDigest: plan.flowDigest,
                moduleManifestDigest: input.moduleManifestDigest,
                workflowVersionDigest: input.workflowVersionDigest,
              },
            }),
            kind: "run.started",
            occurred_at: input.startedAt,
            run_id: input.runId,
            sequence: 1,
          })
          .execute();
        await ctx.workflow.start(
          genericRunWorkflow,
          { runId: input.runId, startedAt: input.startedAt },
          { workflowId: input.workflowId },
        );
        await publishProjection(ctx, row, engine);
        return runV3FromRows(row, engine);
      },
      async getRun(ctx, input) {
        const loaded = await loadRows(runsDb(ctx), input.runId);
        return loaded === null ? null : runV1FromV2(runFromRow(loaded.row));
      },
      async getRunV2(ctx, input) {
        const loaded = await loadRows(runsDb(ctx), input.runId);
        return loaded === null ? null : runFromRow(loaded.row);
      },
      async getRunV3(ctx, input) {
        const loaded = await loadRows(runsDb(ctx), input.runId);
        return loaded === null || loaded.engine === null
          ? null
          : runV3FromRows(loaded.row, loaded.engine);
      },
      async getRunAudit(ctx, input) {
        const db = runsDb(ctx);
        return (
          await db
            .selectFrom("run_audit")
            .selectAll()
            .where("run_id", "=", input.runId)
            .orderBy("sequence", "asc")
            .execute()
        ).map((entry) => ({
          kind: entry.kind,
          occurredAt: entry.occurred_at,
          payloadJson: entry.audit_json,
          sequence: entry.sequence,
        }));
      },
      async applyOperatorCommand(ctx, input) {
        const current = await ctx.call(runs.calls.getRunV2, { runId: input.runId });
        if (current === null) throw new Error("run_not_found");
        const projection = await ctx.call(runs.calls.applyOperatorCommandV2, {
          ...input,
          ...(current.currentCorrelationToken === undefined
            ? {}
            : { correlationToken: current.currentCorrelationToken }),
          ...(current.currentGateId === undefined ? {} : { gateId: current.currentGateId }),
        });
        return runV1FromV2(projection);
      },
      async applyOperatorCommandV2(ctx, input) {
        const db = runsDb(ctx);
        const loaded = await loadRows(db, input.runId);
        if (loaded === null) throw new Error("run_not_found");
        const duplicate = await db
          .selectFrom("operator_commands")
          .select(["command_json", "run_id"])
          .where("command_id", "=", input.commandId)
          .executeTakeFirst();
        if (duplicate !== undefined) {
          if (duplicate.command_json !== JSON.stringify(input) || duplicate.run_id !== input.runId)
            throw new Error("command_not_allowed: command identity has different fields");
          return runFromRow(loaded.row);
        }
        if (isTerminal(loaded.row.status)) throw new Error("command_not_allowed: run is terminal");
        if (loaded.engine === null) {
          let patch: Partial<RunRow>;
          if (input.kind === "pause") {
            if (loaded.row.status === "paused") {
              throw new Error("command_not_allowed: run is already paused");
            }
            patch = { status: "paused" };
          } else if (input.kind === "resume") {
            if (loaded.row.status !== "paused") {
              throw new Error("command_not_allowed: run is not paused");
            }
            patch = {
              status: loaded.row.current_gate_status === "pending" ? "waiting" : "running",
            };
          } else if (input.kind === "cancel") {
            patch = {
              current_attempt_id: null,
              current_correlation_token: null,
              current_effect_key: null,
              current_gate_id: null,
              current_gate_status: null,
              current_step_id: null,
              finished_at: input.issuedAt,
              status: "cancelled",
            };
          } else if (input.kind === "retry") {
            if (loaded.row.current_gate_status === "pending") {
              throw new Error("command_not_allowed: retry cannot bypass a pending gate");
            }
            patch = {
              current_correlation_token: digestIdentity(
                loaded.row.current_correlation_token ?? loaded.row.run_id,
                input.commandId,
              ),
              finished_at: null,
              status: "running",
            };
          } else {
            if (
              loaded.row.current_gate_id === null ||
              loaded.row.current_gate_status !== "pending" ||
              input.gateId !== loaded.row.current_gate_id ||
              input.correlationToken !== loaded.row.current_correlation_token
            )
              throw new Error("command_not_allowed: stale or missing gate correlation");
            const gate = await db
              .selectFrom("run_gates")
              .selectAll()
              .where("run_id", "=", loaded.row.run_id)
              .where("gate_id", "=", loaded.row.current_gate_id)
              .where("correlation_token", "=", loaded.row.current_correlation_token ?? "")
              .executeTakeFirstOrThrow();
            const signal = `operator.${input.kind}`;
            if (!(JSON.parse(gate.accepted_json) as string[]).includes(signal)) {
              throw new Error("command_not_allowed: gate rejects signal");
            }
            await db
              .updateTable("run_gates")
              .set({
                satisfied_at: input.issuedAt,
                satisfied_by: input.commandId,
                status: input.kind === "approve" ? "approved" : "rejected",
              })
              .where("run_id", "=", loaded.row.run_id)
              .where("gate_id", "=", loaded.row.current_gate_id)
              .where("correlation_token", "=", loaded.row.current_correlation_token ?? "")
              .execute();
            patch =
              input.kind === "approve"
                ? { current_gate_status: "approved", status: "running" }
                : {
                    current_attempt_id: null,
                    current_correlation_token: null,
                    current_effect_key: null,
                    current_gate_id: null,
                    current_gate_status: "rejected",
                    current_step_id: null,
                    finished_at: input.issuedAt,
                    status: "failed",
                  };
          }
          await db
            .insertInto("operator_commands")
            .values({
              command_id: input.commandId,
              command_json: JSON.stringify(input),
              issued_at: input.issuedAt,
              kind: input.kind,
              run_id: input.runId,
            })
            .execute();
          await db
            .insertInto("workflow_signals")
            .values({
              correlation_token:
                input.correlationToken ?? loaded.row.current_correlation_token ?? loaded.row.run_id,
              identity: input.commandId,
              payload_json: JSON.stringify(input),
              recorded_at: input.issuedAt,
              run_id: input.runId,
              signal_kind: `operator.${input.kind}`,
            })
            .execute();
          const row = await appendAudit(
            db,
            loaded.row,
            `operator.${input.kind}`,
            input.issuedAt,
            input,
            patch,
          );
          await publishProjection(ctx, row);
          if (isTerminal(row.status)) {
            await ctx.workflow.signal(row.workflow_id, "finish", {});
            const projection = runFromRow(row);
            ctx.publish(runs.events.runFinishedV1, finishedV1(projection));
            ctx.publish(runs.events.runFinishedV2, finishedV2(projection));
          }
          return runFromRow(row);
        }
        const engine = loaded.engine;
        let patch: Partial<RunRow> = {};
        let enginePatch: Partial<RunEngineStateRow> = {};
        let wakeKind = input.kind;
        if (input.kind === "pause") {
          if (engine.engine_phase === "paused")
            throw new Error("command_not_allowed: run is already paused");
          patch = { status: "paused" };
          enginePatch = {
            engine_phase: "paused",
            outcome: "waiting",
            paused_from_phase: engine.engine_phase,
          };
        } else if (input.kind === "resume") {
          if (engine.engine_phase !== "paused")
            throw new Error("command_not_allowed: run is not paused");
          const admission = await db
            .selectFrom("run_admissions")
            .select("status")
            .where("run_id", "=", input.runId)
            .executeTakeFirstOrThrow();
          const gatePending = loaded.row.current_gate_status === "pending";
          const resumedPhase =
            admission.status === "queued"
              ? "queued"
              : gatePending
                ? "waiting"
                : (engine.paused_from_phase ?? "runnable");
          patch = {
            status:
              resumedPhase === "queued" || resumedPhase === "waiting" || resumedPhase === "retrying"
                ? "waiting"
                : "running",
          };
          enginePatch = { engine_phase: resumedPhase, paused_from_phase: null };
        } else if (input.kind === "cancel") {
          await db
            .insertInto("operator_commands")
            .values({
              command_id: input.commandId,
              command_json: JSON.stringify(input),
              issued_at: input.issuedAt,
              kind: input.kind,
              run_id: input.runId,
            })
            .execute();
          await finishEngineRun(
            ctx,
            loaded.row,
            engine,
            loaded.row.state_id,
            "cancelled",
            input.issuedAt,
          );
          await signalResume(ctx, loaded.row, input.commandId, input.issuedAt, "cancel");
          return runFromRow((await loadRows(db, input.runId))?.row ?? loaded.row);
        } else if (input.kind === "retry") {
          if (engine.engine_phase !== "retrying" || loaded.row.current_gate_status === "pending")
            throw new Error("command_not_allowed: no retryable work");
          patch = {
            current_attempt_id: null,
            current_correlation_token: null,
            current_effect_key: null,
            status: "running",
          };
          enginePatch = { engine_phase: "runnable", pending_json: null, retry_delay_ms: null };
          wakeKind = "retry";
        } else {
          if (
            loaded.row.current_gate_id === null ||
            loaded.row.current_gate_status !== "pending" ||
            input.gateId !== loaded.row.current_gate_id ||
            input.correlationToken !== loaded.row.current_correlation_token
          )
            throw new Error("command_not_allowed: stale or missing gate correlation");
          const gate = await db
            .selectFrom("run_gates")
            .selectAll()
            .where("run_id", "=", loaded.row.run_id)
            .where("gate_id", "=", loaded.row.current_gate_id)
            .where("correlation_token", "=", loaded.row.current_correlation_token ?? "")
            .executeTakeFirstOrThrow();
          const signal = `operator.${input.kind}`;
          if (!(JSON.parse(gate.accepted_json) as string[]).includes(signal))
            throw new Error("command_not_allowed: gate rejects signal");
          await db
            .updateTable("run_gates")
            .set({
              satisfied_at: input.issuedAt,
              satisfied_by: input.commandId,
              status: input.kind === "approve" ? "approved" : "rejected",
            })
            .where("run_id", "=", loaded.row.run_id)
            .where("gate_id", "=", loaded.row.current_gate_id)
            .where("correlation_token", "=", loaded.row.current_correlation_token ?? "")
            .execute();
          patch = {
            current_gate_status: input.kind === "approve" ? "approved" : "rejected",
            status: "running",
          };
          enginePatch = {
            engine_phase: "runnable",
            pending_json: JSON.stringify({ kind: "gate", outcome: signal }),
          };
          wakeKind = "gate";
        }
        await db
          .insertInto("operator_commands")
          .values({
            command_id: input.commandId,
            command_json: JSON.stringify(input),
            issued_at: input.issuedAt,
            kind: input.kind,
            run_id: input.runId,
          })
          .execute();
        await db
          .updateTable("run_engine_state")
          .set(enginePatch)
          .where("run_id", "=", input.runId)
          .execute();
        const row = await appendAudit(
          db,
          loaded.row,
          `operator.${input.kind}`,
          input.issuedAt,
          input,
          patch,
        );
        await recordWorkflowSignal(
          ctx,
          row,
          input.commandId,
          `operator.${input.kind}`,
          input.correlationToken ?? row.current_correlation_token ?? row.run_id,
          input.issuedAt,
          input,
        );
        await signalResume(ctx, row, input.commandId, input.issuedAt, wakeKind);
        await publishProjection(ctx, row, { ...engine, ...enginePatch });
        return runFromRow(row);
      },
      async signalRun(ctx, input) {
        const db = runsDb(ctx);
        const loaded = await loadRows(db, input.runId);
        if (loaded === null || loaded.engine === null) throw new Error("run_not_found");
        const duplicate = await db
          .selectFrom("workflow_signals")
          .select(["payload_json", "run_id"])
          .where("identity", "=", input.identity)
          .executeTakeFirst();
        if (duplicate !== undefined) {
          if (
            duplicate.run_id !== input.runId ||
            duplicate.payload_json !== JSON.stringify(input)
          ) {
            throw new Error("signal_not_allowed: signal identity has different fields");
          }
          return runV3FromRows(loaded.row, loaded.engine);
        }
        if (
          loaded.row.current_gate_id !== input.gateId ||
          loaded.row.current_gate_status !== "pending" ||
          loaded.row.current_correlation_token !== input.correlationToken
        )
          throw new Error("signal_not_allowed: stale gate correlation");
        const gate = await db
          .selectFrom("run_gates")
          .selectAll()
          .where("run_id", "=", input.runId)
          .where("gate_id", "=", input.gateId)
          .where("correlation_token", "=", input.correlationToken)
          .executeTakeFirstOrThrow();
        if (!(JSON.parse(gate.accepted_json) as string[]).includes(input.signal)) {
          throw new Error("signal_not_allowed: gate rejects signal");
        }
        await db
          .insertInto("workflow_signals")
          .values({
            correlation_token: input.correlationToken,
            identity: input.identity,
            payload_json: JSON.stringify(input),
            recorded_at: input.occurredAt,
            run_id: input.runId,
            signal_kind: input.signal,
          })
          .execute();
        await db
          .updateTable("run_gates")
          .set({
            satisfied_at: input.occurredAt,
            satisfied_by: input.identity,
            status: "approved",
          })
          .where("run_id", "=", input.runId)
          .where("gate_id", "=", input.gateId)
          .where("correlation_token", "=", input.correlationToken)
          .execute();
        const engine = {
          ...loaded.engine,
          engine_phase: "runnable",
          pending_json: JSON.stringify({ kind: "gate", outcome: input.signal }),
        };
        await db
          .updateTable("run_engine_state")
          .set({ engine_phase: "runnable", pending_json: engine.pending_json })
          .where("run_id", "=", input.runId)
          .execute();
        const row = await appendAudit(
          db,
          loaded.row,
          `gate.${input.signal}`,
          input.occurredAt,
          input,
          { current_gate_status: "approved", status: "running" },
        );
        await signalResume(ctx, row, input.identity, input.occurredAt, "gate");
        await publishProjection(ctx, row, engine);
        return runV3FromRows(row, engine);
      },
      async driveRun(ctx, input) {
        const db = runsDb(ctx);
        const loaded = await loadRows(db, input.runId);
        if (loaded === null || loaded.engine === null) throw new Error("run_not_found");
        let { engine, row } = loaded;
        if (isTerminal(row.status)) return { kind: "complete" as const };
        const plan = await ctx.call(definitions.calls.getExecutionPlanV2, {
          definitionDigest: row.definition_digest,
          flowId: row.flow_id,
        });
        if (plan === null || plan.flowDigest !== row.flow_digest)
          throw new Error("invalid_revision_pin: pinned plan is missing");
        if (engine.engine_phase === "paused") return { kind: "wait" as const, signal: "resume" };
        if (engine.engine_phase === "queued") {
          const admission = await db
            .selectFrom("run_admissions")
            .selectAll()
            .where("run_id", "=", row.run_id)
            .executeTakeFirstOrThrow();
          const firstQueued = await db
            .selectFrom("run_admissions")
            .select("run_id")
            .where("scope_key", "=", admission.scope_key)
            .where("status", "=", "queued")
            .orderBy("requested_at", "asc")
            .orderBy("run_id", "asc")
            .executeTakeFirst();
          if (firstQueued?.run_id !== row.run_id)
            return { kind: "wait" as const, signal: "resume" };
          const ownedSlot = await db
            .selectFrom("run_admission_slots")
            .select("slot_number")
            .where("run_id", "=", row.run_id)
            .executeTakeFirst();
          let slot: number | null = ownedSlot?.slot_number ?? null;
          for (
            let candidate = 0;
            slot === null && candidate < admission.limit_value;
            candidate += 1
          ) {
            const inserted = await db
              .insertInto("run_admission_slots")
              .values({
                run_id: row.run_id,
                scope_key: admission.scope_key,
                slot_number: candidate,
              })
              .onConflict((conflict) => conflict.columns(["scope_key", "slot_number"]).doNothing())
              .returning("slot_number")
              .executeTakeFirst();
            if (inserted !== undefined) {
              slot = inserted.slot_number;
              break;
            }
          }
          if (slot === null) return { kind: "wait" as const, signal: "resume" };
          await db
            .updateTable("run_admissions")
            .set({ status: "active" })
            .where("run_id", "=", row.run_id)
            .execute();
          row = await appendAudit(
            db,
            row,
            "admission.granted",
            input.now,
            { scope: admission.scope_key, slot },
            { status: "running" },
          );
          engine = { ...engine, engine_phase: "runnable" };
          await db
            .updateTable("run_engine_state")
            .set({ engine_phase: "runnable" })
            .where("run_id", "=", row.run_id)
            .execute();
          const nextQueued = await db
            .selectFrom("run_admissions")
            .select("run_id")
            .where("scope_key", "=", admission.scope_key)
            .where("status", "=", "queued")
            .orderBy("requested_at", "asc")
            .orderBy("run_id", "asc")
            .executeTakeFirst();
          if (nextQueued !== undefined) {
            const nextRun = await db
              .selectFrom("runs")
              .selectAll()
              .where("run_id", "=", nextQueued.run_id)
              .executeTakeFirst();
            if (nextRun !== undefined) {
              await signalResume(
                ctx,
                nextRun,
                `admission-fill:${row.run_id}`,
                input.now,
                "admission",
              );
            }
          }
        }
        if (engine.engine_phase === "retrying") {
          if (input.wakeKind !== "retry")
            return { delayMs: engine.retry_delay_ms ?? 0, kind: "sleep" as const };
          engine = { ...engine, engine_phase: "runnable", retry_delay_ms: null };
          await db
            .updateTable("run_engine_state")
            .set({ engine_phase: "runnable", retry_delay_ms: null })
            .where("run_id", "=", row.run_id)
            .execute();
          await db
            .updateTable("runs")
            .set({ status: "running" })
            .where("run_id", "=", row.run_id)
            .execute();
          row = { ...row, status: "running" };
        }
        const state = plan.states.find((candidate) => candidate.id === row.state_id);
        if (state === undefined) {
          await finishEngineRun(ctx, row, engine, row.state_id, "failed", input.now);
          return { kind: "complete" as const };
        }
        if (state.terminalOutcome !== undefined) {
          if (state.terminal !== "success" && state.terminal !== "failure") {
            throw new Error("invalid_revision_pin: terminal state classification is missing");
          }
          await finishEngineRun(
            ctx,
            row,
            engine,
            state.id,
            state.terminalOutcome,
            input.now,
            state.terminal,
          );
          return { kind: "complete" as const };
        }
        if (engine.pending_json !== null) {
          const pending = JSON.parse(engine.pending_json) as Record<string, unknown>;
          if (pending.kind === "attempt" && isDataRecord(pending.outcome)) {
            const step = plan.steps.find((candidate) => candidate.id === state.step);
            if (step === undefined || pending.outcome.outcome === "failed") {
              const retry = await scheduleRetry(db, row, engine, plan, input.now);
              if (retry === null) {
                await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
                return { kind: "complete" as const };
              }
              await publishProjection(ctx, retry.row, retry.engine);
              return { delayMs: retry.delayMs, kind: "sleep" as const };
            }
            const result = pending.outcome.result;
            if (!validResult(step, result)) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            const next = await transition(
              db,
              row,
              engine,
              plan,
              result.outcome,
              input.now,
              result.outputArtifactDigests,
            );
            if (next === null) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            row = next.row;
            engine = next.engine;
            await publishProjection(ctx, row, engine);
            return { kind: "sleep" as const, delayMs: 0 };
          }
          if (pending.kind === "effect" && isDataRecord(pending.outcome)) {
            if (pending.outcome.outcome === "ambiguous") {
              engine = {
                ...engine,
                engine_phase: "waiting",
                outcome: "waiting",
                pending_json: null,
              };
              await db
                .updateTable("run_engine_state")
                .set({ engine_phase: "waiting", outcome: "waiting", pending_json: null })
                .where("run_id", "=", row.run_id)
                .execute();
              row = await appendAudit(
                db,
                row,
                "effect.ambiguous_waiting",
                input.now,
                { idempotencyKey: row.current_effect_key },
                { status: "waiting" },
              );
              await publishProjection(ctx, row, engine);
              return { kind: "wait" as const, signal: "resume" };
            }
            const next = await transition(
              db,
              row,
              engine,
              plan,
              String(pending.outcome.outcome),
              input.now,
            );
            if (next === null) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            await publishProjection(ctx, next.row, next.engine);
            return { delayMs: 0, kind: "sleep" as const };
          }
          if (pending.kind === "gate") {
            const next = await transition(
              db,
              row,
              engine,
              plan,
              String(pending.outcome),
              input.now,
              [],
              true,
            );
            if (next === null) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            await publishProjection(ctx, next.row, next.engine);
            return { delayMs: 0, kind: "sleep" as const };
          }
        }
        if (state.gate !== undefined) {
          const gate = plan.gates.find((candidate) => candidate.id === state.gate);
          if (gate === undefined) {
            await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
            return { kind: "complete" as const };
          }
          if (input.wakeKind === "timeout" && gate.timeoutOutcome !== undefined) {
            const next = await transition(
              db,
              row,
              engine,
              plan,
              gate.timeoutOutcome,
              input.now,
              [],
              true,
            );
            if (next === null)
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
            else await publishProjection(ctx, next.row, next.engine);
            return { delayMs: 0, kind: "sleep" as const };
          }
          if (row.current_gate_id === null) {
            const outputs = JSON.parse(engine.artifact_outputs_json) as Record<string, string[]>;
            const artifacts = [
              ...new Set(gate.requiredArtifactSteps.flatMap((stepId) => outputs[stepId] ?? [])),
            ];
            if (
              (gate.requiredOutcome !== undefined &&
                engine.last_outcome !== gate.requiredOutcome) ||
              artifacts.length < gate.requiredArtifactCount
            ) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            const token = digestIdentity(
              row.run_id,
              state.id,
              String(engine.state_generation),
              "gate",
            );
            await db
              .insertInto("run_gates")
              .values({
                accepted_json: JSON.stringify(gate.accepted),
                correlation_token: token,
                gate_id: gate.id,
                kind: gate.kind,
                run_id: row.run_id,
                satisfied_at: null,
                satisfied_by: null,
                status: "pending",
              })
              .onConflict((conflict) =>
                conflict.columns(["run_id", "gate_id", "correlation_token"]).doNothing(),
              )
              .execute();
            row = await appendAudit(
              db,
              row,
              "gate.waiting",
              input.now,
              { gateId: gate.id, token },
              {
                current_correlation_token: token,
                current_gate_id: gate.id,
                current_gate_status: "pending",
                status: "waiting",
              },
            );
            engine = { ...engine, engine_phase: "waiting", outcome: "waiting" };
            await db
              .updateTable("run_engine_state")
              .set({ engine_phase: "waiting", outcome: "waiting" })
              .where("run_id", "=", row.run_id)
              .execute();
            await publishProjection(ctx, row, engine);
          }
          return {
            kind: "wait" as const,
            signal: "resume",
            ...(gate.timeoutMs === undefined ? {} : { timeoutMs: gate.timeoutMs }),
          };
        }
        const step = plan.steps.find((candidate) => candidate.id === state.step);
        if (step === undefined) {
          await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
          return { kind: "complete" as const };
        }
        if (step.kind === "deterministic") {
          const next = await transition(
            db,
            row,
            engine,
            plan,
            step.deterministicOutcome ?? "",
            input.now,
          );
          if (next === null) await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
          else await publishProjection(ctx, next.row, next.engine);
          return { delayMs: 0, kind: "sleep" as const };
        }
        if (row.current_attempt_id !== null || row.current_effect_key !== null)
          return { kind: "wait" as const, signal: "resume" };
        const number = engine.attempt_count + 1;
        const token = digestIdentity(
          row.run_id,
          state.id,
          String(engine.state_generation),
          String(number),
          "correlation",
        );
        if (step.kind === "agent") {
          const attemptId = digestIdentity(
            row.run_id,
            state.id,
            String(engine.state_generation),
            String(number),
            "attempt",
          );
          const profile =
            step.agentProfile === undefined ? undefined : plan.agentProfiles[step.agentProfile];
          if (profile === undefined) {
            await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
            return { kind: "complete" as const };
          }
          const artifacts = inputArtifacts(plan, step.id, engine);
          row = await appendAudit(
            db,
            row,
            "step.requested",
            input.now,
            { attemptId, attempt: number, inputArtifactDigests: artifacts, stepId: step.id },
            {
              current_attempt_id: attemptId,
              current_correlation_token: token,
              current_step_id: step.id,
              status: "running",
            },
          );
          engine = { ...engine, attempt_count: number, engine_phase: "running" };
          await db
            .updateTable("run_engine_state")
            .set({ attempt_count: number, engine_phase: "running" })
            .where("run_id", "=", row.run_id)
            .execute();
          try {
            await ctx.call(execution.calls.requestAttempt, {
              agentProfile: profile,
              attemptId,
              correlationToken: token,
              inputArtifactDigests: artifacts,
              runId: row.run_id,
              skillDigests: plan.skillRevisions,
              startedAt: input.now,
              stepId: step.id,
            });
          } catch (error) {
            row = await appendAudit(db, row, "infrastructure.failed", input.now, {
              message: error instanceof Error ? error.message : String(error),
              stepId: step.id,
            });
            const retry = await scheduleRetry(db, row, engine, plan, input.now);
            if (retry === null) {
              await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
              return { kind: "complete" as const };
            }
            await publishProjection(ctx, retry.row, retry.engine);
            return { delayMs: retry.delayMs, kind: "sleep" as const };
          }
          ctx.publish(runs.events.stepRequestedV1, {
            correlationToken: token,
            runId: row.run_id,
            stepId: step.id,
          });
          ctx.publish(runs.events.stepRequestedV2, {
            agentProfileDigest: profile.digest,
            attemptId,
            correlationToken: token,
            inputArtifactDigests: artifacts,
            runId: row.run_id,
            skillDigests: plan.skillRevisions,
            stepId: step.id,
          });
          await publishProjection(ctx, row, engine);
          return { kind: "wait" as const, signal: "resume" };
        }
        const idempotencyKey = digestIdentity(
          row.run_id,
          state.id,
          String(engine.state_generation),
          String(number),
          "effect",
        );
        const artifacts = inputArtifacts(plan, step.id, engine);
        row = await appendAudit(
          db,
          row,
          "effect.requested",
          input.now,
          { idempotencyKey, inputArtifactDigests: artifacts, stepId: step.id },
          {
            current_correlation_token: token,
            current_effect_key: idempotencyKey,
            current_step_id: step.id,
            status: "running",
          },
        );
        engine = { ...engine, attempt_count: number, engine_phase: "running" };
        await db
          .updateTable("run_engine_state")
          .set({ attempt_count: number, engine_phase: "running" })
          .where("run_id", "=", row.run_id)
          .execute();
        const intent = {
          capability: step.effectCapability ?? "",
          correlationToken: token,
          expectedExternalRevision: null,
          idempotencyKey,
          payloadDigest: artifacts[0] ?? step.effectPayloadDigest ?? "",
          provenance: `${row.run_id}/step:${step.id}`,
          requestedAt: input.now,
          runId: row.run_id,
          target: step.effectTarget ?? "",
        };
        try {
          await ctx.call(effects.calls.requestEffectV2, intent);
        } catch (error) {
          row = await appendAudit(db, row, "infrastructure.failed", input.now, {
            message: error instanceof Error ? error.message : String(error),
            stepId: step.id,
          });
          const retry = await scheduleRetry(db, row, engine, plan, input.now);
          if (retry === null) {
            await finishEngineRun(ctx, row, engine, state.id, "failed", input.now);
            return { kind: "complete" as const };
          }
          await publishProjection(ctx, retry.row, retry.engine);
          return { delayMs: retry.delayMs, kind: "sleep" as const };
        }
        ctx.publish(runs.events.effectRequestedV1, {
          capability: intent.capability,
          correlationToken: intent.correlationToken,
          expectedExternalRevision: intent.expectedExternalRevision,
          idempotencyKey: intent.idempotencyKey,
          payloadDigest: intent.payloadDigest,
          provenance: intent.provenance,
          runId: intent.runId,
          target: intent.target,
        });
        ctx.publish(runs.events.effectRequestedV2, intent);
        await publishProjection(ctx, row, engine);
        return { kind: "wait" as const, signal: "resume" };
      },
    },
  });
}

export const runsImplementation = createRunsImplementation();
