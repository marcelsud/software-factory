import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { effectReceipt, eventRecord, health, run } from "../../contracts/index.ts";

export const operations = defineChimpbaseModuleInterface({
  name: "operations",
  version: 1,
  dependencies: ["assets", "definitions", "effects", "execution", "intake", "runs"],
  calls: {
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
  },
  events: {},
});
