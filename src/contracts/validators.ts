import { createHash } from "node:crypto";
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

export const triggerPredicate = v.object({
  field: v.string(),
  operator: v.enum(["equals", "not_equals", "in", "not_in", "exists"]),
  value: v.string().optional(),
  values: v.array(v.string()).optional(),
});

export const executionTriggerV2 = v.object({
  predicates: v.array(triggerPredicate),
  source: identifier,
  sourceId: v.string(),
});
export const artifactHandoff = v.object({
  fromStep: identifier,
  toStep: identifier,
});

export const resultContract = v.object({
  dataTypes: v.record(v.enum(["boolean", "number", "string", "unknown"])),
  outcome: v.string(),
  requiredArtifactCount: v.integer(),
  requiredData: v.array(v.string()),
});

export const executionStepV2 = v.object({
  agentProfile: v.string().optional(),
  capabilities: v.array(v.string()),
  deterministicOutcome: v.string().optional(),
  effectCapability: v.string().optional(),
  effectPayloadDigest: digest.optional(),
  effectTarget: v.string().optional(),
  id: identifier,
  kind: v.enum(["agent", "deterministic", "effect"]),
  resultContracts: v.array(resultContract),
  retry: retryPolicy,
  skill: v.string().optional(),
});

export const executionGateV2 = v.object({
  accepted: v.array(v.string()),
  id: identifier,
  kind: v.enum(["approval", "event", "signal"]),
  requiredArtifactCount: v.integer(),
  requiredArtifactSteps: v.array(identifier),
  requiredOutcome: v.string().optional(),
  timeoutMs: v.integer().optional(),
  timeoutOutcome: v.string().optional(),
});

export const executionStateV2 = v.object({
  gate: v.string().optional(),
  id: identifier,
  step: v.string().optional(),
  terminal: v.enum(["success", "failure"]).optional(),
  terminalOutcome: v
    .enum([
      "not_actionable",
      "needs_reproduction",
      "unable_to_reproduce",
      "unable_to_fix",
      "failed",
      "waiting",
      "completed",
      "cancelled",
    ])
    .optional(),
});

export const executionPlanV2 = v.object({
  agentProfileDigests: v.record(digest),
  agentProfiles: v.record(pinnedAgentProfile),
  artifactHandoffs: v.array(artifactHandoff),
  calls: v.array(v.string()),
  concurrency: concurrencyPolicy,
  definitionDigest: digest,
  effectPermissions: v.array(executionEffectPermission),
  events: v.array(v.string()),
  flowDigest: digest,
  flowId: identifier,
  gates: v.array(executionGateV2),
  initialState: identifier,
  normalizedJson: v.string(),
  skillRevisions: v.record(v.string()),
  states: v.array(executionStateV2),
  steps: v.array(executionStepV2),
  transitions: v.array(executionTransition),
  triggers: v.array(executionTriggerV2),
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

export const acceptedFactoryEvent = v.object({
  event: factoryEvent,
  idempotent: v.boolean(),
  payloadDigest: digest,
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

export const artifactKind = v.enum([
  "result.json",
  "report.md",
  "log",
  "patch",
  "test-result",
  "reproduction",
  "metadata",
]);

export const artifactV2 = v.object({
  attemptId: identifier.optional(),
  classification: v.enum(["public", "private"]),
  createdAt: isoTimestamp,
  digest,
  kind: artifactKind,
  mediaType: v.string(),
  name: v.string(),
  redaction: v.enum(["not-required", "raw-private", "redacted-public"]),
  retention: v.enum(["ephemeral", "retained"]),
  runId: identifier,
  size: v.integer(),
  sourceDigest: digest.optional(),
});

export const skillResultProperty = v.object({
  type: v.enum(["boolean", "number", "string", "string-array"]),
});

export const skillResultSchema = v.object({
  additionalProperties: v.boolean(),
  properties: v.record(skillResultProperty),
  required: v.string().array(),
  type: v.enum(["object"]),
});

export const skillRevisionV2 = v.object({
  capabilities: v.string().array(),
  compatibility: v.integer(),
  customizable: v.boolean(),
  digest,
  id: identifier,
  inputArtifactKinds: artifactKind.array(),
  resultSchema: skillResultSchema,
  source: v.string(),
  version: v.integer(),
});

export const stepResultDocument = v.object({
  data: v.record(v.unknown()),
  outcome: v.string(),
  outputArtifactDigests: v.array(digest),
  summary: v.string(),
});

export const capabilityPreset = v.enum(["read-only", "patch", "test", "release"]);

export const CAPABILITY_PRESETS = {
  "read-only": ["repository.read"],
  patch: ["repository.read", "repository.patch"],
  test: ["repository.read", "repository.patch", "process.test"],
  release: ["repository.read", "repository.patch", "process.test", "repository.release"],
} as const;

export const agentMaterialization = v.object({
  contentBase64: v.string().optional(),
  digest,
  kind: v.enum(["artifact", "skill", "task"]),
  path: v.string(),
  size: v.integer(),
});

export const pinnedSkillBundle = v.object({
  digest,
  files: v.array(agentMaterialization),
  id: identifier,
  instructions: v.string(),
});

export const pinnedSkillBundleV2 = v.object({
  capabilities: v.string().array(),
  compatibility: v.integer(),
  customizable: v.boolean(),
  digest,
  files: v.array(agentMaterialization),
  id: identifier,
  inputArtifactKinds: artifactKind.array(),
  instructions: v.string(),
  instructionPath: v.string(),
  resultSchema: skillResultSchema,
  version: v.integer(),
});

export const strictAgentProfile = v.object({
  capabilities: v.array(v.string()),
  capabilityPreset,
  command: v.array(v.string()),
  digest,
  environment: v.record(v.string()),
  instructions: v.string(),
  limits: v.object({
    cpuSeconds: v.integer(),
    maxFileBytes: v.integer(),
    maxInputBytes: v.integer(),
    maxLogBytes: v.integer(),
    maxOutputBytes: v.integer(),
    maxPatchBytes: v.integer(),
    maxPids: v.integer(),
    maxWorkspaceBytes: v.integer(),
    maxWorkspaceFiles: v.integer(),
    memoryBytes: v.integer(),
    timeoutMs: v.integer(),
  }),
  model: v.string(),
  skills: v.array(v.string()),
});

export const agentRequest = v.object({
  agentProfile: strictAgentProfile,
  attemptId: identifier,
  budget: v.object({
    maxDurationMs: v.integer(),
    maxInputBytes: v.integer(),
    maxOutputBytes: v.integer(),
  }),
  correlationToken: identifier,
  declaredOutputPaths: v.array(v.string()),
  inputArtifacts: v.array(agentMaterialization),
  repository: v.object({
    id: identifier,
    sha: digest,
  }),
  runId: identifier,
  skills: v.array(pinnedSkillBundle),
  startedAt: isoTimestamp,
  stepId: identifier,
  task: v.object({
    mediaType: v.string(),
    payload: v.unknown(),
  }),
});

export const agentRequestV2 = v.object({
  agentProfile: strictAgentProfile,
  attemptId: identifier,
  budget: v.object({
    maxDurationMs: v.integer(),
    maxInputBytes: v.integer(),
    maxOutputBytes: v.integer(),
  }),
  correlationToken: identifier,
  declaredOutputPaths: v.array(v.string()),
  inputArtifacts: v.array(agentMaterialization),
  repository: v.object({
    id: identifier,
    sha: digest,
  }),
  runId: identifier,
  skills: v.array(pinnedSkillBundleV2),
  startedAt: isoTimestamp,
  stepId: identifier,
  task: v.object({
    mediaType: v.string(),
    payload: v.unknown(),
  }),
});

export const agentFailure = v.object({
  category: v.enum([
    "timeout",
    "cancel",
    "result-invalid",
    "process",
    "sandbox",
    "adapter",
    "workspace-limit",
  ]),
  message: v.string(),
  retriable: v.boolean(),
});

export const agentChangedFile = v.object({
  digest,
  contentBase64: v.string().optional(),
  path: v.string(),
  size: v.integer(),
});

export const agentResult = v.object({
  attemptId: identifier,
  changedFiles: v.array(agentChangedFile),
  commit: v
    .object({
      sha: digest,
    })
    .optional(),
  failure: agentFailure.optional(),
  logs: v.object({
    stderrBytes: v.integer(),
    stderrDigest: digest,
    stderrTruncated: v.boolean(),
    stdoutBytes: v.integer(),
    stdoutDigest: digest,
  }),
  outcome: stepResultDocument.optional(),
  patch: v
    .object({
      digest,
      size: v.integer(),
    })
    .optional(),
  resources: v.object({
    cpuMs: v.integer(),
    maxRssBytes: v.integer(),
  }),
  status: v.enum(["succeeded", "failed"]),
  tests: v.array(
    v.object({
      command: v.array(v.string()),
      durationMs: v.integer(),
      exitCode: v.integer(),
    }),
  ),
  timing: v.object({
    durationMs: v.integer(),
    finishedAt: isoTimestamp,
    startedAt: isoTimestamp,
  }),
});

export const attemptFinishedV2 = v.object({
  agentProfileDigest: digest,
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp,
  result: agentResult,
  runId: identifier,
  startedAt: isoTimestamp,
  stepId: identifier,
});

function isCapabilityPreset(value: string): value is keyof typeof CAPABILITY_PRESETS {
  return Object.hasOwn(CAPABILITY_PRESETS, value);
}

export function parseAgentRequest(value: unknown): Infer<typeof agentRequest> {
  const request = agentRequest.parse(value);
  const preset = request.agentProfile.capabilityPreset;
  if (!isCapabilityPreset(preset)) throw new Error("agent request capability preset is invalid");
  const expected = CAPABILITY_PRESETS[preset];
  if (
    request.agentProfile.capabilities.length !== expected.length ||
    request.agentProfile.capabilities.some((capability, index) => capability !== expected[index])
  )
    throw new Error("agent request capabilities do not match the pinned preset");
  const profileSkillIds = [...request.agentProfile.skills].sort();
  const bundleSkillIds = request.skills.map(({ id }) => id).sort();
  if (
    new Set(profileSkillIds).size !== profileSkillIds.length ||
    new Set(bundleSkillIds).size !== bundleSkillIds.length ||
    profileSkillIds.length !== bundleSkillIds.length ||
    profileSkillIds.some((id, index) => id !== bundleSkillIds[index])
  )
    throw new Error("agent request skill bundles must match the pinned profile skills one-to-one");
  for (const bundle of request.skills) {
    if (!bundle.digest.startsWith("sha256:")) continue;
    const canonical = JSON.stringify({
      files: [...bundle.files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ contentBase64, digest: fileDigest, kind, path, size }) => ({
          contentBase64: contentBase64 ?? null,
          digest: fileDigest,
          kind,
          path,
          size,
        })),
      instructions: bundle.instructions,
    });
    const actual = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    if (actual !== bundle.digest)
      throw new Error(`agent skill bundle digest mismatch: ${bundle.id}`);
  }
  if (
    request.agentProfile.command.length === 0 ||
    request.agentProfile.limits.timeoutMs <= 0 ||
    request.agentProfile.limits.cpuSeconds <= 0 ||
    request.agentProfile.limits.maxFileBytes <= 0 ||
    request.agentProfile.limits.maxInputBytes <= 0 ||
    request.agentProfile.limits.maxOutputBytes <= 0 ||
    request.agentProfile.limits.maxLogBytes <= 0 ||
    request.agentProfile.limits.maxPatchBytes <= 0 ||
    request.agentProfile.limits.maxPids <= 0 ||
    request.agentProfile.limits.maxWorkspaceBytes <= 0 ||
    request.agentProfile.limits.maxWorkspaceFiles <= 0 ||
    request.agentProfile.limits.memoryBytes <= 0 ||
    request.budget.maxDurationMs <= 0 ||
    request.budget.maxInputBytes <= 0 ||
    request.budget.maxOutputBytes <= 0
  )
    throw new Error("agent request limits and command must be non-empty and positive");
  return request;
}

export function parseAgentRequestV2(value: unknown): Infer<typeof agentRequestV2> {
  const request = agentRequestV2.parse(value);
  parseAgentRequest({
    ...request,
    skills: request.skills.map(({ digest: bundleDigest, files, id, instructions }) => ({
      digest: `strict:${bundleDigest}`,
      files,
      id,
      instructions,
    })),
  });
  for (const bundle of request.skills) {
    const canonical = JSON.stringify(
      [...bundle.files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ contentBase64, path }) => [path, contentBase64 ?? ""]),
    );
    const actual = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    if (actual !== bundle.digest)
      throw new Error(`agent skill bundle digest mismatch: ${bundle.id}`);
  }
  return request;
}

export function parseAgentResult(value: unknown): Infer<typeof agentResult> {
  const result = agentResult.parse(value);
  const hasOutcome = result.outcome !== undefined;
  const hasFailure = result.failure !== undefined;
  if (hasOutcome === hasFailure)
    throw new Error(
      "agent result must contain exactly one domain outcome or infrastructure failure",
    );
  if (result.status === "succeeded" && !hasOutcome)
    throw new Error("successful agent result must contain a domain outcome");
  if (result.status === "failed" && !hasOutcome && !hasFailure)
    throw new Error("failed agent result must contain an outcome or failure");
  return result;
}

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

export const stepAttemptV2 = v.object({
  agentProfileDigest: digest,
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp.optional(),
  outcome: v.enum(["pending", "succeeded", "failed"]),
  result: stepResultDocument.optional(),
  runId: identifier,
  startedAt: isoTimestamp,
  stepId: identifier,
  workspaceStatus: v.enum(["queued", "ready", "finished"]),
});

export const stepAttemptV3 = v.object({
  agentProfileDigest: digest,
  attemptId: identifier,
  correlationToken: identifier,
  finishedAt: isoTimestamp.optional(),
  outcome: v.enum(["pending", "succeeded", "failed"]),
  result: agentResult.optional(),
  runId: identifier,
  startedAt: isoTimestamp,
  stepId: identifier,
  workspaceStatus: v.enum(["queued", "ready", "finished"]),
});

export const attemptOutcome = v.object({
  attemptId: identifier,
  finishedAt: isoTimestamp,
  outcome: v.enum(["succeeded", "failed"]),
  result: stepResultDocument,
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

export const effectIntentV2 = v.object({
  capability: v.string(),
  correlationToken: identifier,
  expectedExternalRevision: v.string().nullable(),
  idempotencyKey: identifier,
  payloadDigest: digest,
  provenance: v.string(),
  requestedAt: isoTimestamp,
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

export const effectReceiptV2 = v.object({
  correlationToken: identifier,
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

export const effectFinishedV2 = v.object({
  correlationToken: identifier,
  effectId: identifier,
  externalRevision: v.string().nullable(),
  finishedAt: isoTimestamp,
  idempotencyKey: identifier,
  outcome: v.enum(["applied", "rejected", "ambiguous"]),
  recordedAt: isoTimestamp,
  runId: identifier,
});

export const effectOutcome = v.object({
  externalRevision: v.string().nullable(),
  finishedAt: isoTimestamp,
  idempotencyKey: identifier,
  outcome: v.enum(["applied", "rejected", "ambiguous"]),
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

export const runV2 = v.object({
  agentProfileDigests: v.record(digest),
  auditSequence: v.integer(),
  currentAttemptId: identifier.optional(),
  currentCorrelationToken: identifier.optional(),
  currentEffectKey: identifier.optional(),
  currentGateId: identifier.optional(),
  currentGateStatus: v.enum(["pending", "approved", "rejected"]).optional(),
  currentStepId: identifier.optional(),
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
  status: v.enum(["running", "waiting", "paused", "succeeded", "failed", "cancelled"]),
  workflowId: identifier,
  workflowVersion: v.integer(),
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

export const runFinishedV2 = v.object({
  agentProfileDigests: v.record(digest),
  auditSequence: v.integer(),
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
  workflowId: identifier,
  workflowVersion: v.integer(),
  workflowVersionDigest: digest,
});

export const runOutcome = v.enum([
  "not_actionable",
  "needs_reproduction",
  "unable_to_reproduce",
  "unable_to_fix",
  "failed",
  "waiting",
  "completed",
  "cancelled",
]);

export const runV3 = v.object({
  agentProfileDigests: v.record(digest),
  auditSequence: v.integer(),
  currentAttemptId: identifier.optional(),
  currentCorrelationToken: identifier.optional(),
  currentEffectKey: identifier.optional(),
  currentGateId: identifier.optional(),
  currentGateStatus: v.enum(["pending", "approved", "rejected"]).optional(),
  currentStepId: identifier.optional(),
  definitionDigest: digest,
  factoryEventId: identifier,
  finishedAt: isoTimestamp.optional(),
  flowDigest: digest,
  flowId: identifier,
  moduleManifestDigest: digest,
  outcome: runOutcome,
  runId: identifier,
  skillDigests: v.record(digest),
  startedAt: isoTimestamp,
  stateId: identifier,
  status: v.enum([
    "queued",
    "running",
    "retrying",
    "waiting",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  workflowId: identifier,
  workflowVersion: v.integer(),
  workflowVersionDigest: digest,
});

export const runFinishedV3 = v.object({
  agentProfileDigests: v.record(digest),
  auditSequence: v.integer(),
  definitionDigest: digest,
  factoryEventId: identifier,
  finishedAt: isoTimestamp,
  flowDigest: digest,
  flowId: identifier,
  moduleManifestDigest: digest,
  outcome: runOutcome,
  runId: identifier,
  skillDigests: v.record(digest),
  startedAt: isoTimestamp,
  stateId: identifier,
  status: v.enum(["succeeded", "failed", "cancelled"]),
  workflowId: identifier,
  workflowVersion: v.integer(),
  workflowVersionDigest: digest,
});

export const operatorCommand = v.object({
  commandId: identifier,
  issuedAt: isoTimestamp,
  kind: v.enum(["approve", "reject", "cancel", "retry"]),
  runId: identifier,
});

export const operatorCommandV2 = v.object({
  commandId: identifier,
  correlationToken: identifier.optional(),
  gateId: identifier.optional(),
  issuedAt: isoTimestamp,
  kind: v.enum(["approve", "reject", "cancel", "retry", "pause", "resume"]),
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
export type PinnedSkillBundle = Infer<typeof pinnedSkillBundle>;
export type PinnedSkillBundleV2 = Infer<typeof pinnedSkillBundleV2>;
export type SkillResultSchema = Infer<typeof skillResultSchema>;
export type SkillRevisionV2 = Infer<typeof skillRevisionV2>;
export type ArtifactV2 = Infer<typeof artifactV2>;

export type DefinitionRevision = Infer<typeof definitionRevision>;
export type ExecutionPlan = Infer<typeof executionPlan>;
export type ExecutionPlanV2 = Infer<typeof executionPlanV2>;
export type PinnedAgentProfile = Infer<typeof pinnedAgentProfile>;
export type FactoryEvent = Infer<typeof factoryEvent>;
export type Artifact = Infer<typeof artifact>;
export type StepResultDocument = Infer<typeof stepResultDocument>;
export type AgentRequest = Infer<typeof agentRequest>;
export type AgentRequestV2 = Infer<typeof agentRequestV2>;
export type AgentResult = Infer<typeof agentResult>;
export type AgentFailure = Infer<typeof agentFailure>;
export type AgentMaterialization = Infer<typeof agentMaterialization>;
export type StepAttempt = Infer<typeof stepAttempt>;
export type StepAttemptV2 = Infer<typeof stepAttemptV2>;
export type StepAttemptV3 = Infer<typeof stepAttemptV3>;
export type AttemptFinished = Infer<typeof attemptFinished>;
export type AttemptFinishedV2 = Infer<typeof attemptFinishedV2>;
export type EffectIntent = Infer<typeof effectIntent>;
export type EffectIntentV2 = Infer<typeof effectIntentV2>;
export type EffectReceipt = Infer<typeof effectReceipt>;
export type EffectReceiptV2 = Infer<typeof effectReceiptV2>;
export type EffectFinished = Infer<typeof effectFinished>;
export type EffectFinishedV2 = Infer<typeof effectFinishedV2>;
export type Run = Infer<typeof run>;
export type RunV2 = Infer<typeof runV2>;
export type RunV3 = Infer<typeof runV3>;
export type RunFinished = Infer<typeof runFinished>;
export type RunFinishedV2 = Infer<typeof runFinishedV2>;
export type RunFinishedV3 = Infer<typeof runFinishedV3>;
export type AcceptedFactoryEvent = Infer<typeof acceptedFactoryEvent>;
export type AttemptOutcome = Infer<typeof attemptOutcome>;
export type EffectOutcome = Infer<typeof effectOutcome>;
