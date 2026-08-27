import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  attemptFinished,
  pinnedAgentProfile,
  stepAttempt,
  stepAttemptV2,
} from "../../contracts/index.ts";
import type { ExecutionDatabase } from "../../storage/execution-database.ts";

const calls = {
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
  getAttemptV2: {
    input: v.object({ attemptId: v.string() }),
    output: stepAttemptV2.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns committed workspace and result metadata"],
  },
} as const;

const events = {
  attemptQueuedV1: { name: "attemptQueued", payload: stepAttemptV2, version: 1 },
  attemptFinishedV1: { name: "attemptFinished", payload: attemptFinished, version: 1 },
} as const;

export const execution = defineChimpbaseModuleInterface<
  ExecutionDatabase,
  typeof calls,
  typeof events
>({ calls, dependencies: ["assets"], events, name: "execution", version: 1 });
