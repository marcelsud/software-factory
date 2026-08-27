import { type Infer, v } from "chimpbase/runtime";

export const emptyInput = v.object({});
export const identifier = v.string();
export const digest = v.string();
export const isoTimestamp = v.string();
export const stringMap = v.record(v.string());

export const definitionRevision = v.object({
  definitionDigest: digest,
  flowDigests: v.record(digest),
  normalizedJson: v.string(),
  sourceName: v.string(),
});

export const executionPlan = v.object({
  agentProfileDigests: v.record(digest),
  calls: v.array(v.string()),
  definitionDigest: digest,
  events: v.array(v.string()),
  flowDigest: digest,
  flowId: identifier,
  normalizedJson: v.string(),
  skillRevisions: v.record(v.string()),
  states: v.array(identifier),
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

export const stepAttempt = v.object({
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp.optional(),
  outcome: v.enum(["pending", "succeeded", "failed"]),
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
  idempotencyKey: identifier,
  outcome: v.enum(["pending", "applied", "rejected", "ambiguous"]),
  recordedAt: isoTimestamp,
  runId: identifier,
});

export const run = v.object({
  agentProfileDigest: digest,
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
export type FactoryEvent = Infer<typeof factoryEvent>;
export type Artifact = Infer<typeof artifact>;
export type StepAttempt = Infer<typeof stepAttempt>;
export type EffectIntent = Infer<typeof effectIntent>;
export type EffectReceipt = Infer<typeof effectReceipt>;
export type Run = Infer<typeof run>;
