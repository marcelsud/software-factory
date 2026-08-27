import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  effectReceipt,
  eventRecord,
  health,
  operationsEffectPage,
  operationsEventPage,
  operationsHealth,
  operationsRebuildResult,
  operationsRunDetails,
  operationsRunPage,
  operatorCommandAudit,
  operatorCommandRequest,
  run,
} from "../../contracts/index.ts";
import type { OperationsDatabase } from "../../storage/operations-database.ts";

const calls = {
  listRuns: {
    input: v.object({ limit: v.integer(), status: v.string().optional() }),
    output: run.array(),
    errors: ["module_unavailable", "invalid_limit"],
    guarantees: ["projection results are ordered deterministically"],
  },
  showRun: {
    input: v.object({ runId: v.string() }),
    output: run.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["reads event-fed projections without querying another module's storage"],
  },
  getHealth: {
    input: v.object({}),
    output: health,
    errors: ["module_unavailable"],
    guarantees: ["reports readiness without changing domain state"],
  },
  listEvents: {
    input: v.object({
      after: v.string().optional(),
      limit: v.integer(),
      runId: v.string().optional(),
    }),
    output: eventRecord.array(),
    errors: ["module_unavailable", "invalid_limit"],
    guarantees: ["returns redaction-safe projection records in event order"],
  },
  listEffects: {
    input: v.object({ limit: v.integer(), runId: v.string().optional() }),
    output: effectReceipt.array(),
    errors: ["module_unavailable", "invalid_limit"],
    guarantees: ["returns committed effect receipts in deterministic order"],
  },
  listRunsV2: {
    input: v.object({
      after: v.string().optional(),
      limit: v.integer(),
      status: v.string().optional(),
    }),
    output: operationsRunPage,
    errors: ["module_unavailable", "invalid_limit", "invalid_cursor"],
    guarantees: [
      "projection results are ordered deterministically and use stable cursor pagination",
    ],
  },
  showRunV2: {
    input: v.object({ runId: v.string() }),
    output: operationsRunDetails.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns a redaction-safe event-fed timeline"],
  },
  getHealthV2: {
    input: v.object({}),
    output: operationsHealth,
    errors: ["module_unavailable"],
    guarantees: ["reports detailed readiness without changing domain state"],
  },
  listEventsV2: {
    input: v.object({
      after: v.string().optional(),
      limit: v.integer(),
      runId: v.string().optional(),
    }),
    output: operationsEventPage,
    errors: ["module_unavailable", "invalid_limit", "invalid_cursor"],
    guarantees: ["returns redaction-safe projection records in stable event order"],
  },
  listEffectsV2: {
    input: v.object({
      after: v.string().optional(),
      limit: v.integer(),
      runId: v.string().optional(),
    }),
    output: operationsEffectPage,
    errors: ["module_unavailable", "invalid_limit", "invalid_cursor"],
    guarantees: ["returns committed effect receipts in deterministic order"],
  },
  applyOperatorCommand: {
    input: operatorCommandRequest,
    output: operatorCommandAudit,
    errors: ["module_unavailable", "run_not_found", "command_not_allowed", "command_conflict"],
    guarantees: [
      "audits successful routing atomically; after a routing error the caller must invoke recordOperatorCommandRejection in a separate root action",
    ],
  },
  recordOperatorCommandRejection: {
    input: v.object({ error: v.string(), request: operatorCommandRequest }),
    output: operatorCommandAudit,
    errors: ["module_unavailable", "command_conflict"],
    guarantees: ["records a rejected command only after the failed routing transaction unwinds"],
  },
  getOperatorCommand: {
    input: v.object({ commandKey: v.string() }),
    output: operatorCommandAudit.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns the durable operations-owned command audit record"],
  },
  rebuildProjections: {
    input: v.object({}),
    output: operationsRebuildResult,
    errors: ["module_unavailable"],
    guarantees: ["rebuilds byte-identical projections solely from stored versioned event facts"],
  },
} as const;
const events = {} as const;

export const operations = defineChimpbaseModuleInterface<
  OperationsDatabase,
  typeof calls,
  typeof events
>({
  calls,
  dependencies: ["assets", "definitions", "effects", "execution", "intake", "runs"],
  events,
  name: "operations",
  version: 1,
});
