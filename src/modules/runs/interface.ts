import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { effectIntent, operatorCommand, run } from "../../contracts/index.ts";

const stepRequest = v.object({
  correlationToken: v.string(),
  runId: v.string(),
  stepId: v.string(),
});

const startRunInput = v.object({
  agentProfileDigest: v.string(),
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

export const runs = defineChimpbaseModuleInterface({
  name: "runs",
  version: 1,
  dependencies: ["assets", "definitions", "effects", "execution"],
  calls: {
    startRun: {
      input: startRunInput,
      output: run,
      errors: ["module_unavailable", "run_exists", "invalid_revision_pin"],
      guarantees: ["all definition and execution pins are immutable after creation"],
    },
    getRun: {
      input: v.object({ runId: v.string() }),
      output: run.nullable(),
      errors: ["module_unavailable"],
      guarantees: ["returns committed run state"],
    },
    applyOperatorCommand: {
      input: operatorCommand,
      output: run,
      errors: ["module_unavailable", "run_not_found", "command_not_allowed"],
      guarantees: ["command application is idempotent by command id"],
    },
  },
  events: {
    runStateChangedV1: { name: "runStateChanged", payload: run, version: 1 },
    stepRequestedV1: { name: "stepRequested", payload: stepRequest, version: 1 },
    effectRequestedV1: { name: "effectRequested", payload: effectIntent, version: 1 },
    runFinishedV1: { name: "runFinished", payload: run, version: 1 },
  },
});
