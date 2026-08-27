import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  agentRequest,
  attemptFinished,
  attemptFinishedV2,
  pinnedAgentProfile,
  stepAttempt,
  stepAttemptV2,
  stepAttemptV3,
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
  requestAttemptV2: {
    input: agentRequest,
    output: stepAttemptV3,
    errors: ["module_unavailable", "attempt_exists", "invalid_pin"],
    guarantees: ["request is idempotent by attempt id and compares every immutable execution pin"],
  },
  cancelAttempt: {
    input: v.object({ attemptId: v.string(), cancelledAt: v.string() }),
    output: v.boolean(),
    errors: ["module_unavailable"],
    guarantees: ["cancellation is idempotent and terminates the active runtime attempt"],
  },
  getAttemptProtocol: {
    input: v.object({ attemptId: v.string() }),
    output: v.enum(["v1", "v2"]).nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns the persisted request protocol; pre-migration attempts are v1"],
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
  getAttemptV3: {
    input: v.object({ attemptId: v.string() }),
    output: stepAttemptV3.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns the strict committed workspace and complete runtime result metadata"],
  },
} as const;

const events = {
  attemptQueuedV1: { name: "attemptQueued", payload: stepAttemptV2, version: 1 },
  attemptQueuedV2: { name: "attemptQueued", payload: agentRequest, version: 2 },
  attemptFinishedV1: { name: "attemptFinished", payload: attemptFinished, version: 1 },
  attemptFinishedV2: { name: "attemptFinished", payload: attemptFinishedV2, version: 2 },
} as const;

export const execution = defineChimpbaseModuleInterface<
  ExecutionDatabase,
  typeof calls,
  typeof events
>({ calls, dependencies: ["assets"], events, name: "execution", version: 1 });
