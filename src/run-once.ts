import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type EventSourceAdapter,
  GitHubInvocationEventSource,
} from "./adapters/github-invocation-event-source.ts";
import { canonicalJson } from "./compiler.ts";
import {
  type FactoryEvent,
  factoryConcurrencyKey,
  parseRunOnceInvocationEnvelope,
  parseRunOnceResult,
  RUN_ONCE_EXIT_CODES,
  RUN_ONCE_MAX_OUTPUT_BYTES,
  RUN_ONCE_MAX_OUTPUT_ITEMS,
  type RunOnceArtifactReference,
  type RunOnceEffectReceipt,
  type RunOnceInvocationEnvelope,
  type RunOnceResult,
  type RunOnceResultClass,
} from "./contracts/index.ts";

export interface RunOnceHost {
  close(): Promise<void>;
  drain(options: { readonly maxDurationMs: number; readonly maxRuns: number }): Promise<{
    readonly idle: boolean;
    readonly stopReason: "idle" | "max_duration" | "max_runs";
  }>;
  executeAction(name: string, args?: unknown): Promise<{ readonly result: unknown }>;
}

export interface RunOnceOptions {
  readonly activate: (host: RunOnceHost) => Promise<void>;
  readonly artifactExport: string;
  readonly boot: () => Promise<RunOnceHost>;
  readonly envelope: unknown;
  readonly eventSource?: EventSourceAdapter<RunOnceInvocationEnvelope>;
  readonly expectedDefinitionRevision: string;
  readonly maxDurationMs: number;
  readonly maxWork: number;
  readonly reportDiagnostic?: (message: string) => void;
}

interface ProjectedRun {
  readonly auditSequence: number;
  readonly currentAttemptId: string | null;
  readonly currentEffectKey: string | null;
  readonly currentGateId: string | null;
  readonly currentGateStatus: string | null;
  readonly currentStepId: string | null;
  readonly failureCategory: string | null;
  readonly flowId: string;
  readonly outcome: string;
  readonly runId: string;
  readonly sourceEvent: { readonly correlationId: string; readonly deliveryId: string } | null;
  readonly stateId: string;
  readonly status: string;
  readonly terminal: boolean;
}

interface TimelineEntry {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

export async function executeRunOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const envelope = parseRunOnceInvocationEnvelope(options.envelope);
  let events: readonly FactoryEvent[];
  try {
    if (envelope.definitionRevision !== options.expectedDefinitionRevision)
      throw new Error("run_once_invalid: definitionRevision does not match checked configuration");
    positive(options.maxDurationMs, "maxDurationMs");
    positive(options.maxWork, "maxWork");
    const source = options.eventSource ?? new GitHubInvocationEventSource();
    events = source.normalize(envelope);
  } catch (error) {
    return runOnceFailureResult(envelope, error, options.reportDiagnostic);
  }
  if (events.length === 0) return emptyResult(envelope, "no-match");

  let host: RunOnceHost | undefined;
  let result: RunOnceResult;
  try {
    host = await options.boot();
    await options.activate(host);
    for (const event of events) await acceptEvent(host, event);
    let drainedToIdle = false;
    try {
      const drained = await host.drain({
        maxDurationMs: options.maxDurationMs,
        maxRuns: options.maxWork,
      });
      drainedToIdle = drained.idle;
    } catch {
      // Projection and runs state remain readable when an adapter reports a retryable failure.
    }
    result = await projectResult(host, envelope, options.artifactExport, drainedToIdle);
  } catch (error) {
    result = runOnceFailureResult(envelope, error, options.reportDiagnostic);
  }
  if (host !== undefined) {
    try {
      await host.close();
    } catch (error) {
      options.reportDiagnostic?.(`run-once: ${safeErrorCode(error)}`);
      result = emptyResult(envelope, "retryable-infrastructure-failure");
    }
  }
  return result;
}

export function runOnceFailureResult(
  envelope: RunOnceInvocationEnvelope,
  error: unknown,
  reportDiagnostic?: (message: string) => void,
): RunOnceResult {
  reportDiagnostic?.(`run-once: ${safeErrorCode(error)}`);
  return emptyResult(envelope, failureResultClass(error));
}

async function acceptEvent(host: RunOnceHost, event: FactoryEvent): Promise<void> {
  const cursor = (
    await host.executeAction("intake/getSourceCursor@v1", { sourceId: event.sourceId })
  ).result as { readonly cursor: string } | null;
  await host.executeAction("intake/acceptSourceEventV2@v1", {
    event,
    expectedCursor: cursor?.cursor ?? null,
    nextCursor: cursor?.cursor ?? event.sourceRevision,
  });
}

async function collectMatchingRuns(
  host: RunOnceHost,
  envelope: RunOnceInvocationEnvelope,
): Promise<{ readonly items: ProjectedRun[]; readonly omitted: number }> {
  const items: ProjectedRun[] = [];
  const seenCursors = new Set<string>();
  let after: string | null | undefined;
  let omitted = 0;
  while (after !== null) {
    const page = (
      await host.executeAction("operations/listRunsV2@v1", {
        ...(after === undefined ? {} : { after }),
        limit: RUN_ONCE_MAX_OUTPUT_ITEMS,
      })
    ).result as {
      readonly items: ReadonlyArray<ProjectedRun>;
      readonly nextCursor: string | null;
    };
    for (const run of page.items) {
      if (
        run.sourceEvent?.correlationId !== semanticCorrelation(envelope) &&
        run.sourceEvent?.deliveryId !== envelope.deliveryId
      )
        continue;
      if (items.length < RUN_ONCE_MAX_OUTPUT_ITEMS) items.push(run);
      else omitted += 1;
    }
    if (page.nextCursor !== null) {
      if (seenCursors.has(page.nextCursor))
        throw new Error("operations_cursor_conflict: repeated listRuns cursor");
      seenCursors.add(page.nextCursor);
    }
    after = page.nextCursor;
  }
  return { items, omitted };
}

async function projectResult(
  host: RunOnceHost,
  envelope: RunOnceInvocationEnvelope,
  artifactExport: string,
  drainedToIdle: boolean,
): Promise<RunOnceResult> {
  const collection = await collectMatchingRuns(host, envelope);
  const projected = collection.items.sort((left, right) => left.runId.localeCompare(right.runId));
  const matched = await Promise.all(
    projected.map(async (run) => ({
      ...run,
      ...((await host.executeAction("runs/getRunV4@v1", { runId: run.runId }))
        .result as Partial<ProjectedRun>),
    })),
  );
  if (matched.length === 0) return emptyResult(envelope, "no-match");

  const transitions: Array<Readonly<Record<string, unknown>>> = [];
  const effectIntents: Array<Readonly<Record<string, unknown>>> = [];
  const artifacts: RunOnceArtifactReference[] = [];
  const receipts: RunOnceEffectReceipt[] = [];
  let transitionsOmitted = 0;
  let effectsOmitted = 0;
  let artifactsOmitted = 0;
  let receiptsOmitted = 0;
  let artifactExportFailed = false;
  for (const run of matched) {
    const details = (await host.executeAction("operations/showRunV2@v1", { runId: run.runId }))
      .result as { readonly timeline: readonly TimelineEntry[] } | null;
    for (const entry of details?.timeline ?? []) {
      if (entry.kind === "run.state") {
        if (transitions.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) transitionsOmitted += 1;
        else
          transitions.push({
            auditSequence: safeInteger(entry.payload.auditSequence),
            outcome: safeString(entry.payload.outcome),
            runId: run.runId,
            stateId: safeString(entry.payload.stateId),
            status: safeString(entry.payload.status),
          });
      } else if (entry.kind === "effect.requested") {
        if (effectIntents.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) effectsOmitted += 1;
        else
          effectIntents.push({
            capability: safeString(entry.payload.capability),
            idempotencyKey: safeString(entry.payload.idempotencyKey),
            kind: safeString(
              (entry.payload.operation as Record<string, unknown> | undefined)?.kind,
            ),
            runId: run.runId,
            target: safeString(entry.payload.target),
          });
      }
    }
    if (
      !transitions.some(
        (transition) =>
          transition.runId === run.runId && transition.auditSequence === run.auditSequence,
      )
    ) {
      if (transitions.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) transitionsOmitted += 1;
      else
        transitions.push({
          auditSequence: run.auditSequence,
          outcome: run.outcome,
          runId: run.runId,
          stateId: run.stateId,
          status: run.status,
        });
    }
    if (
      run.currentEffectKey !== null &&
      !effectIntents.some((intent) => intent.idempotencyKey === run.currentEffectKey)
    ) {
      const audit = (await host.executeAction("runs/getRunAudit@v1", { runId: run.runId }))
        .result as ReadonlyArray<{ readonly kind: string; readonly payloadJson: string }>;
      const requested = audit
        .filter((entry) => entry.kind === "effect.requested")
        .map((entry) => JSON.parse(entry.payloadJson) as Record<string, unknown>)
        .find((entry) => entry.idempotencyKey === run.currentEffectKey);
      if (requested !== undefined) {
        if (effectIntents.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) effectsOmitted += 1;
        else
          effectIntents.push({
            idempotencyKey: run.currentEffectKey,
            kind: "pending",
            runId: run.runId,
            stepId: safeString(requested.stepId),
          });
      }
    }
    const runArtifacts = (
      await host.executeAction("assets/listRunArtifactsV2@v1", { runId: run.runId })
    ).result as ReadonlyArray<{
      readonly classification: "private" | "public";
      readonly digest: string;
      readonly kind: string;
      readonly mediaType: string;
      readonly name: string;
      readonly runId: string;
      readonly size: number;
    }>;
    for (const artifact of runArtifacts) {
      if (artifact.classification !== "public") {
        artifactsOmitted += 1;
        continue;
      }
      if (artifacts.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) {
        artifactsOmitted += 1;
        continue;
      }
      try {
        await exportPublicArtifact(host, artifact.digest, artifactExport);
        artifacts.push({
          digest: artifact.digest,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          name: bounded(artifact.name),
          reference: `artifact://${artifact.digest}`,
          runId: artifact.runId,
          size: artifact.size,
        });
      } catch {
        artifactExportFailed = true;
        artifactsOmitted += 1;
      }
    }
    const effectPage = (
      await host.executeAction("operations/listEffectsV2@v1", {
        limit: RUN_ONCE_MAX_OUTPUT_ITEMS,
        runId: run.runId,
      })
    ).result as {
      readonly items: readonly RunOnceEffectReceipt[];
      readonly nextCursor: string | null;
    };
    for (const receipt of effectPage.items) {
      if (receipts.length >= RUN_ONCE_MAX_OUTPUT_ITEMS) receiptsOmitted += 1;
      else
        receipts.push({
          externalId: nullableBounded(receipt.externalId),
          externalRevision: nullableBounded(receipt.externalRevision),
          externalUrl: nullableBounded(receipt.externalUrl),
          failureCategory: nullableBounded(receipt.failureCategory),
          idempotencyKey: bounded(receipt.idempotencyKey),
          outcome: nullableBounded(receipt.outcome),
          runId: receipt.runId,
          status: receipt.status,
        });
    }
    if (effectPage.nextCursor !== null) receiptsOmitted += 1;
  }

  const resultClass = classify(matched, receipts, drainedToIdle, artifactExportFailed);
  const flowIds = [...new Set(matched.map((run) => run.flowId))].sort();
  const outcomes = [...new Set(matched.map((run) => run.outcome))].sort();
  const pending = {
    effects: matched
      .filter((run) => run.currentEffectKey !== null)
      .map((run) => ({
        idempotencyKey: bounded(run.currentEffectKey ?? ""),
        runId: run.runId,
        stepId: bounded(run.currentStepId ?? "unknown"),
      })),
    gates: matched
      .filter((run) => run.currentGateId !== null)
      .map((run) => ({
        gateId: bounded(run.currentGateId ?? ""),
        runId: run.runId,
        status: bounded(run.currentGateStatus ?? "pending"),
      })),
    retries: matched
      .filter((run) => run.status === "retrying")
      .map((run) => ({
        attemptId: bounded(run.currentAttemptId ?? "pending"),
        runId: run.runId,
        stepId: bounded(run.currentStepId ?? "unknown"),
      })),
  };
  const result: RunOnceResult = {
    artifacts,
    concurrencyKey:
      flowIds.length === 1
        ? factoryConcurrencyKey(
            envelope.repository.fullName,
            `issue:${envelope.subject.id}`,
            flowIds[0] ?? "unknown",
          )
        : factoryConcurrencyKey(
            envelope.repository.fullName,
            `issue:${envelope.subject.id}`,
            "multiple",
          ),
    effectIntents,
    effectReceipts: receipts,
    exitCode: RUN_ONCE_EXIT_CODES[resultClass],
    invocation: invocationMetadata(envelope),
    outcome: outcomes.length === 1 ? (outcomes[0] ?? null) : outcomes.length === 0 ? null : "mixed",
    pending,
    resultClass,
    runIds: matched.map((run) => run.runId),
    schemaVersion: 1,
    transitions,
    truncation: {
      artifactsOmitted,
      bytes: 0,
      effectsOmitted,
      receiptsOmitted,
      runsOmitted: collection.omitted,
      transitionsOmitted,
      truncated:
        collection.omitted > 0 ||
        artifactsOmitted + effectsOmitted + receiptsOmitted + transitionsOmitted > 0,
    },
  };
  return boundAndValidate(result);
}

function classify(
  runs: readonly ProjectedRun[],
  receipts: readonly RunOnceEffectReceipt[],
  drainedToIdle: boolean,
  infrastructureFailure: boolean,
): RunOnceResultClass {
  if (
    receipts.some(
      (receipt) => receipt.outcome === "rejected" || receipt.failureCategory === "policy",
    )
  )
    return "policy-rejection";
  if (infrastructureFailure) return "retryable-infrastructure-failure";
  if (runs.some((run) => run.status === "retrying")) return "waiting";
  if (runs.some((run) => run.failureCategory !== null && !run.terminal))
    return "retryable-infrastructure-failure";
  if (
    runs.some(
      (run) =>
        run.status === "waiting" ||
        run.status === "paused" ||
        run.currentGateId !== null ||
        run.currentEffectKey !== null,
    )
  )
    return "waiting";
  if (runs.every((run) => run.status === "succeeded")) return "completed";
  if (runs.some((run) => run.status === "failed" || run.status === "cancelled"))
    return "terminal-failure";
  return drainedToIdle ? "waiting" : "retryable-infrastructure-failure";
}

function failureResultClass(error: unknown): RunOnceResultClass {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/(?:policy|permission|capability|rejected)/.test(message)) return "policy-rejection";
  if (
    /(?:adapter_unavailable|connection|database|econn|infrastructure|postgres|sqlite|storage|timeout|unavailable|worker)/.test(
      message,
    )
  )
    return "retryable-infrastructure-failure";
  return "terminal-failure";
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("skill digest mismatch")) return "skill_digest_mismatch";
  if (normalized.includes("definition digest")) return "definition_digest_mismatch";
  return message.match(/^[A-Za-z][A-Za-z0-9_.-]*/)?.[0] ?? "terminal_failure";
}

async function exportPublicArtifact(
  host: RunOnceHost,
  digest: string,
  artifactExport: string,
): Promise<void> {
  const envelope = (await host.executeAction("assets/getPublicArtifactV2@v1", { digest }))
    .result as { readonly contentBase64: string } | null;
  if (envelope === null) return;
  await mkdir(resolve(artifactExport), { recursive: true });
  await writeFile(resolve(artifactExport, digest), Buffer.from(envelope.contentBase64, "base64"));
}

function emptyResult(
  envelope: RunOnceInvocationEnvelope,
  resultClass: RunOnceResultClass,
): RunOnceResult {
  return parseRunOnceResult({
    artifacts: [],
    concurrencyKey: factoryConcurrencyKey(
      envelope.repository.fullName,
      `issue:${envelope.subject.id}`,
      "unmatched",
    ),
    effectIntents: [],
    effectReceipts: [],
    exitCode: RUN_ONCE_EXIT_CODES[resultClass],
    invocation: invocationMetadata(envelope),
    outcome: null,
    pending: { effects: [], gates: [], retries: [] },
    resultClass,
    runIds: [],
    schemaVersion: 1,
    transitions: [],
    truncation: {
      artifactsOmitted: 0,
      bytes: 0,
      effectsOmitted: 0,
      receiptsOmitted: 0,
      runsOmitted: 0,
      transitionsOmitted: 0,
      truncated: false,
    },
  });
}

function invocationMetadata(envelope: RunOnceInvocationEnvelope) {
  return {
    correlationId: envelope.correlationId,
    definitionRevision: envelope.definitionRevision,
    deliveryId: envelope.deliveryId,
    event: envelope.event,
    repository: envelope.repository.fullName,
    source: envelope.source,
    subject: `issue:${envelope.subject.id}`,
  };
}

function semanticCorrelation(envelope: RunOnceInvocationEnvelope): string {
  return `github:${envelope.repository.fullName}:issue:${envelope.subject.id}`;
}

function boundAndValidate(input: RunOnceResult): RunOnceResult {
  type MutableResult = Omit<
    RunOnceResult,
    "artifacts" | "effectIntents" | "effectReceipts" | "transitions" | "truncation"
  > & {
    artifacts: RunOnceArtifactReference[];
    effectIntents: Array<Readonly<Record<string, unknown>>>;
    effectReceipts: RunOnceEffectReceipt[];
    transitions: Array<Readonly<Record<string, unknown>>>;
    truncation: RunOnceResult["truncation"];
  };
  const result = input as MutableResult;
  const collections = [
    result.transitions,
    result.effectIntents,
    result.effectReceipts,
    result.artifacts,
  ];
  while (Buffer.byteLength(canonicalJson(result)) > RUN_ONCE_MAX_OUTPUT_BYTES) {
    const selected = collections.find((entries) => entries.length > 0);
    if (selected === undefined) throw new Error("run_once_output_unrepresentable");
    selected.pop();
    result.truncation = {
      ...result.truncation,
      transitionsOmitted:
        result.truncation.transitionsOmitted + (selected === result.transitions ? 1 : 0),
      effectsOmitted:
        result.truncation.effectsOmitted + (selected === result.effectIntents ? 1 : 0),
      receiptsOmitted:
        result.truncation.receiptsOmitted + (selected === result.effectReceipts ? 1 : 0),
      artifactsOmitted:
        result.truncation.artifactsOmitted + (selected === result.artifacts ? 1 : 0),
      truncated: true,
    };
  }
  result.truncation = {
    ...result.truncation,
    bytes: Buffer.byteLength(canonicalJson(result)),
  };
  return parseRunOnceResult(result);
}

function bounded(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}

function nullableBounded(value: string | null): string | null {
  return value === null ? null : bounded(value);
}

function safeString(value: unknown): string {
  return bounded(typeof value === "string" ? value : "unknown");
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`run_once_invalid: ${name} must be a positive safe integer`);
}
