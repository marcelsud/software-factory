import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { attemptFinished, pinnedAgentProfile, stepAttempt } from "../../contracts/index.ts";

export const execution = defineChimpbaseModuleInterface({
  name: "execution",
  version: 1,
  dependencies: ["assets"],
  calls: {
    requestAttempt: {
      input: v.object({
        agentProfile: pinnedAgentProfile,
        attemptId: v.string(),
        correlationToken: v.string(),
        inputArtifactDigests: v.string().array(),
        runId: v.string(),
        skillDigests: v.record(v.string()),
        startedAt: v.string(),
        stepId: v.string(),
      }),
      output: stepAttempt,
      errors: ["module_unavailable", "attempt_exists", "invalid_pin"],
      guarantees: ["request is idempotent by attempt id and preserves the correlation token"],
    },
    getAttempt: {
      input: v.object({ attemptId: v.string() }),
      output: stepAttempt.nullable(),
      errors: ["module_unavailable"],
      guarantees: ["returns committed attempt state"],
    },
  },
  events: {
    attemptFinishedV1: {
      name: "attemptFinished",
      payload: attemptFinished,
      version: 1,
    },
  },
});
