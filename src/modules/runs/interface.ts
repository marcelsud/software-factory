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
  runV2,
} from "../../contracts/index.ts";
import type { RunsDatabase } from "../../storage/runs-database.ts";

const stepRequest = v.object({
  correlationToken: v.string(),
  runId: v.string(),
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
} as const;

const events = {
  runStateChangedV1: { name: "runStateChanged", payload: run, version: 1 },
  runStateChangedV2: { name: "runStateChanged", payload: runV2, version: 2 },
  stepRequestedV1: { name: "stepRequested", payload: stepRequest, version: 1 },
  effectRequestedV1: { name: "effectRequested", payload: effectIntent, version: 1 },
  effectRequestedV2: { name: "effectRequested", payload: effectIntentV2, version: 2 },
  runFinishedV1: { name: "runFinished", payload: runFinished, version: 1 },
  runFinishedV2: { name: "runFinished", payload: runFinishedV2, version: 2 },
} as const;

export const runs = defineChimpbaseModuleInterface<RunsDatabase, typeof calls, typeof events>({
  calls,
  dependencies: ["assets", "definitions", "effects", "execution"],
  events,
  name: "runs",
  version: 1,
});
