import { type Infer, v } from "chimpbase/runtime";

export const emptyInput = v.object({});
export const identifier = v.string();
export const digest = v.string();
export const isoTimestamp = v.string();
export const stringMap = v.record(v.string());

export const retryPolicy = v.object({
  backoffMs: v.integer(),
  maxAttempts: v.integer(),
});

export const concurrencyPolicy = v.object({
  key: v.string(),
  limit: v.integer(),
});

export const pinnedAgentProfile = v.object({
  capabilities: v.array(v.string()),
  command: v.array(v.string()),
  digest,
  instructions: v.string(),
  limits: v.object({
    maxOutputBytes: v.integer(),
    timeoutMs: v.integer(),
  }),
  model: v.string(),
  skills: v.array(v.string()),
});

export const executionStep = v.object({
  agentProfile: v.string().optional(),
  capabilities: v.array(v.string()),
  id: identifier,
  kind: v.enum(["agent", "effect"]),
  retry: retryPolicy,
  skill: v.string().optional(),
});

export const executionGate = v.object({
  accepted: v.array(v.string()),
  id: identifier,
  kind: v.enum(["approval", "event", "signal"]),
});

export const executionState = v.object({
  gate: v.string().optional(),
  id: identifier,
  step: v.string().optional(),
  terminal: v.enum(["success", "failure"]).optional(),
});

export const executionTransition = v.object({
  from: identifier,
  mode: v.enum(["immediate", "signal"]),
  on: v.string(),
  to: identifier,
});

export const executionEffectPermission = v.object({
  capability: v.string(),
  targets: v.array(v.string()),
});

export const definitionRevision = v.object({
  definitionDigest: digest,
  flowDigests: v.record(digest),
  normalizedJson: v.string(),
  sourceName: v.string(),
});

export const executionPlan = v.object({
  agentProfileDigests: v.record(digest),
  agentProfiles: v.record(pinnedAgentProfile),
  calls: v.array(v.string()),
  concurrency: concurrencyPolicy,
  definitionDigest: digest,
  effectPermissions: v.array(executionEffectPermission),
  events: v.array(v.string()),
  flowDigest: digest,
  flowId: identifier,
  gates: v.array(executionGate),
  initialState: identifier,
  normalizedJson: v.string(),
  skillRevisions: v.record(v.string()),
  states: v.array(executionState),
  steps: v.array(executionStep),
  transitions: v.array(executionTransition),
});

export const factoryEvent = v.object({
  actor: v.string(),
  correlationId: identifier,
  deliveryId: identifier,
  eventType: v.string(),
  observedAt: isoTimestamp,
  occurredAt: isoTimestamp,
  payload: v.unknown(),
  repository: v.string(),
  sourceId: identifier,
  sourceRevision: v.string(),
  subject: v.string(),
});

export const sourceCursor = v
  .object({
    cursor: v.string(),
    sourceId: identifier,
    updatedAt: isoTimestamp,
  })
  .nullable();

export const skillRevision = v.object({
  digest,
  reference: v.string(),
});

export const artifact = v.object({
  classification: v.enum(["public", "private"]),
  digest,
  mediaType: v.string(),
  name: v.string(),
  runId: identifier,
  size: v.integer(),
});

export const stepResultDocument = v.object({
  data: v.record(v.unknown()),
  outcome: v.string(),
  outputArtifactDigests: v.array(digest),
  summary: v.string(),
});

export const stepAttempt = v.object({
  agentProfileDigest: digest,
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp.optional(),
  outcome: v.enum(["pending", "succeeded", "failed"]),
  result: stepResultDocument.optional(),
  runId: identifier,
  startedAt: isoTimestamp,
  stepId: identifier,
});

export const attemptFinished = v.object({
  agentProfileDigest: digest,
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp,
  outcome: v.enum(["succeeded", "failed"]),
  result: stepResultDocument,
  runId: identifier,
  startedAt: isoTimestamp,
  stepId: identifier,
});

export const effectIntent = v.object({
  capability: v.string(),
  correlationToken: identifier,
  expectedExternalRevision: v.string().nullable(),
  idempotencyKey: identifier,
  payloadDigest: digest,
  provenance: v.string(),
  runId: identifier,
  target: v.string(),
});

export const effectReceipt = v.object({
  effectId: identifier,
  externalRevision: v.string().nullable(),
  finishedAt: isoTimestamp.optional(),
  idempotencyKey: identifier,
  outcome: v.enum(["pending", "applied", "rejected", "ambiguous"]),
  recordedAt: isoTimestamp,
  runId: identifier,
});

export const effectFinished = v.object({
  effectId: identifier,
  externalRevision: v.string().nullable(),
  finishedAt: isoTimestamp,
  idempotencyKey: identifier,
  outcome: v.enum(["applied", "rejected", "ambiguous"]),
  recordedAt: isoTimestamp,
  runId: identifier,
});

export const run = v.object({
  agentProfileDigests: v.record(digest),
  definitionDigest: digest,
  finishedAt: isoTimestamp.optional(),
  factoryEventId: identifier,
  flowDigest: digest,
  flowId: identifier,
  moduleManifestDigest: digest,
  runId: identifier,
  skillDigests: v.record(digest),
  startedAt: isoTimestamp,
  stateId: identifier,
  status: v.enum(["running", "waiting", "succeeded", "failed", "cancelled"]),
  workflowVersionDigest: digest,
});

export const runFinished = v.object({
  agentProfileDigests: v.record(digest),
  definitionDigest: digest,
  factoryEventId: identifier,
  finishedAt: isoTimestamp,
  flowDigest: digest,
  flowId: identifier,
  moduleManifestDigest: digest,
  runId: identifier,
  skillDigests: v.record(digest),
  startedAt: isoTimestamp,
  stateId: identifier,
  status: v.enum(["succeeded", "failed", "cancelled"]),
  workflowVersionDigest: digest,
});

export const operatorCommand = v.object({
  commandId: identifier,
  issuedAt: isoTimestamp,
  kind: v.enum(["approve", "reject", "cancel", "retry"]),
  runId: identifier,
});

export const health = v.object({
  modules: v.record(v.enum(["ready", "unavailable"])),
  status: v.enum(["ready", "degraded"]),
});

export const eventRecord = v.object({
  eventId: identifier,
  kind: v.string(),
  occurredAt: isoTimestamp,
  payload: v.unknown(),
});

export type DefinitionRevision = Infer<typeof definitionRevision>;
export type ExecutionPlan = Infer<typeof executionPlan>;
export type PinnedAgentProfile = Infer<typeof pinnedAgentProfile>;
export type FactoryEvent = Infer<typeof factoryEvent>;
export type Artifact = Infer<typeof artifact>;
export type StepResultDocument = Infer<typeof stepResultDocument>;
export type StepAttempt = Infer<typeof stepAttempt>;
export type AttemptFinished = Infer<typeof attemptFinished>;
export type EffectIntent = Infer<typeof effectIntent>;
export type EffectReceipt = Infer<typeof effectReceipt>;
export type EffectFinished = Infer<typeof effectFinished>;
export type Run = Infer<typeof run>;
export type RunFinished = Infer<typeof runFinished>;
