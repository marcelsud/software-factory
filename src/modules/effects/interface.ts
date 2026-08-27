import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { effectFinished, effectIntent, effectReceipt } from "../../contracts/index.ts";

export const effects = defineChimpbaseModuleInterface({
  name: "effects",
  version: 1,
  dependencies: ["assets", "definitions"],
  calls: {
    requestEffect: {
      input: effectIntent,
      output: effectReceipt,
      errors: ["module_unavailable", "effect_forbidden", "stale_external_revision"],
      guarantees: [
        "checks declared permission before adapter invocation and is idempotent by intent key",
      ],
    },
    getReceipt: {
      input: v.object({ idempotencyKey: v.string() }),
      output: effectReceipt.nullable(),
      errors: ["module_unavailable"],
      guarantees: ["returns only committed receipts"],
    },
    reconcileEffect: {
      input: v.object({ idempotencyKey: v.string(), observedAt: v.string() }),
      output: effectReceipt,
      errors: ["module_unavailable", "receipt_not_found", "reconciliation_failed"],
      guarantees: ["does not repeat an externally confirmed write"],
    },
  },
  events: {
    effectFinishedV1: {
      name: "effectFinished",
      payload: effectFinished,
      version: 1,
    },
  },
});
