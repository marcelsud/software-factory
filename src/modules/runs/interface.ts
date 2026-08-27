import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  effectIntent,
  effectIntentV2,
  operatorCommand,
  operatorCommandV2,
  run,
  runFinished,
  runFinishedV2,
  runFinishedV3,
  runV2,
  runV3,
} from "../../contracts/index.ts";
import type { RunsDatabase } from "../../storage/runs-database.ts";

const stepRequest = v.object({
  correlationToken: v.string(),
  runId: v.string(),
  stepId: v.string(),
});

const stepRequestV2 = v.object({
  agentProfileDigest: v.string(),
  attemptId: v.string(),
  correlationToken: v.string(),
  inputArtifactDigests: v.array(v.string()),
  runId: v.string(),
  skillDigests: v.record(v.string()),
  stepId: v.string(),
});

const runCorrelation = v.object({
  attemptId: v.string().optional(),
  correlationToken: v.string(),
  effectKey: v.string().optional(),
  gateId: v.string().optional(),
  stepId: v.string().optional(),
});

const startRunInput = v.object({
  agentProfileDigests: v.record(v.string()),
  definitionDigest: v.string(),
  factoryEventId: v.string(),
  flowDigest: v.string(),
  flowId: v.string(),
  moduleManifestDigest: v.string(),
  runId: v.string(),
  skillDigests: v.record(v.string()),
  startedAt: v.string(),
  workflowVersionDigest: v.string(),
});

const startRunInputV2 = v.object({
  agentProfileDigests: v.record(v.string()),
  correlation: runCorrelation.optional(),
  definitionDigest: v.string(),
  factoryEventId: v.string(),
  flowDigest: v.string(),
  flowId: v.string(),
  moduleManifestDigest: v.string(),
  runId: v.string(),
  skillDigests: v.record(v.string()),
  startedAt: v.string(),
  workflowId: v.string(),
  workflowVersion: v.integer(),
  workflowVersionDigest: v.string(),
});

const startRunInputV3 = v.object({
  definitionDigest: v.string(),
  factoryEventId: v.string(),
  flowId: v.string(),
  moduleManifestDigest: v.string(),
  repository: v.string(),
  repositorySha: v.string().optional(),
  runId: v.string(),
  startedAt: v.string(),
  subject: v.string(),
  workflowId: v.string(),
  taskPayload: v.unknown().optional(),
  workflowVersionDigest: v.string(),
});

const workflowDriveResult = v.object({
  delayMs: v.integer().optional(),
  kind: v.enum(["complete", "sleep", "wait"]),
  signal: v.string().optional(),
  timeoutMs: v.integer().optional(),
});

const calls = {
  startRun: {
    input: startRunInput,
    output: run,
    errors: ["module_unavailable", "run_exists", "invalid_revision_pin"],
    guarantees: ["all definition and execution pins are immutable after creation"],
  },
  startRunV2: {
    input: startRunInputV2,
    output: runV2,
    errors: ["module_unavailable", "run_exists", "invalid_revision_pin"],
    guarantees: ["persists strict workflow and correlation pins"],
  },
  startRunV3: {
    input: startRunInputV3,
    output: runV3,
    errors: ["module_unavailable", "run_exists", "invalid_revision_pin", "admission_failed"],
    guarantees: [
      "pins the active strict plan and trusted composition digests before workflow execution",
    ],
  },
  getRun: {
    input: v.object({ runId: v.string() }),
    output: run.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns committed run state"],
  },
  getRunV2: {
    input: v.object({ runId: v.string() }),
    output: runV2.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns committed workflow correlation and audit state"],
  },
  getRunV3: {
    input: v.object({ runId: v.string() }),
    output: runV3.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns strict orchestration phase and terminal outcome"],
  },
  getRunAudit: {
    input: v.object({ runId: v.string() }),
    output: v.array(
      v.object({
        kind: v.string(),
        occurredAt: v.string(),
        payloadJson: v.string(),
        sequence: v.integer(),
      }),
    ),
    errors: ["module_unavailable"],
    guarantees: ["returns the immutable deterministic sequence in ascending order"],
  },
  applyOperatorCommand: {
    input: operatorCommand,
    output: run,
    errors: ["module_unavailable", "run_not_found", "command_not_allowed"],
    guarantees: ["command application is idempotent by command id"],
  },
  applyOperatorCommandV2: {
    input: operatorCommandV2,
    output: runV2,
    errors: ["module_unavailable", "run_not_found", "command_not_allowed"],
    guarantees: [
      "applies correlated pause, resume, gate, retry, and terminal commands idempotently",
    ],
  },
  signalRun: {
    input: v.object({
      correlationToken: v.string(),
      gateId: v.string(),
      identity: v.string(),
      occurredAt: v.string(),
      runId: v.string(),
      signal: v.string(),
    }),
    output: runV3,
    errors: ["module_unavailable", "run_not_found", "signal_not_allowed"],
    guarantees: ["only the current declared gate correlation advances and identity is idempotent"],
  },
  driveRun: {
    input: v.object({
      now: v.string(),
      runId: v.string(),
      wakeKind: v.string().optional(),
    }),
    output: workflowDriveResult,
    errors: ["module_unavailable", "run_not_found", "invalid_revision_pin"],
    guarantees: ["advances only the pinned declarative state machine"],
  },
} as const;

const events = {
  runStateChangedV1: { name: "runStateChanged", payload: run, version: 1 },
  runStateChangedV2: { name: "runStateChanged", payload: runV2, version: 2 },
  runStateChangedV3: { name: "runStateChanged", payload: runV3, version: 3 },
  stepRequestedV1: { name: "stepRequested", payload: stepRequest, version: 1 },
  stepRequestedV2: { name: "stepRequested", payload: stepRequestV2, version: 2 },
  effectRequestedV1: { name: "effectRequested", payload: effectIntent, version: 1 },
  effectRequestedV2: { name: "effectRequested", payload: effectIntentV2, version: 2 },
  runFinishedV1: { name: "runFinished", payload: runFinished, version: 1 },
  runFinishedV2: { name: "runFinished", payload: runFinishedV2, version: 2 },
  runFinishedV3: { name: "runFinished", payload: runFinishedV3, version: 3 },
} as const;

export const runs = defineChimpbaseModuleInterface<RunsDatabase, typeof calls, typeof events>({
  calls,
  dependencies: ["assets", "definitions", "effects", "execution", "intake"],
  events,
  name: "runs",
  version: 1,
});
