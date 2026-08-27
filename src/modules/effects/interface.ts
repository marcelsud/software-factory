import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  effectFinished,
  effectFinishedV2,
  effectIntent,
  effectIntentV2,
  effectReceipt,
  effectReceiptV2,
} from "../../contracts/index.ts";
import type { EffectsDatabase } from "../../storage/effects-database.ts";

const calls = {
  requestEffect: {
    input: effectIntent,
    output: effectReceipt,
    errors: ["module_unavailable", "effect_forbidden", "stale_external_revision"],
    guarantees: [
      "checks declared permission before adapter invocation and is idempotent by intent key",
    ],
  },
  requestEffectV2: {
    input: effectIntentV2,
    output: effectReceiptV2,
    errors: ["module_unavailable", "effect_forbidden", "stale_external_revision"],
    guarantees: ["persists strict request time and correlation before durable execution"],
  },
  getReceipt: {
    input: v.object({ idempotencyKey: v.string() }),
    output: effectReceipt.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns only committed receipts"],
  },
  getReceiptV2: {
    input: v.object({ idempotencyKey: v.string() }),
    output: effectReceiptV2.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns committed receipt correlation"],
  },
  reconcileEffect: {
    input: v.object({ idempotencyKey: v.string(), observedAt: v.string() }),
    output: effectReceipt,
    errors: ["module_unavailable", "receipt_not_found", "reconciliation_failed"],
    guarantees: ["does not repeat an externally confirmed write"],
  },
  reconcileEffectV2: {
    input: v.object({ idempotencyKey: v.string(), observedAt: v.string() }),
    output: effectReceiptV2,
    errors: ["module_unavailable", "receipt_not_found", "reconciliation_failed"],
    guarantees: ["returns committed reconciliation correlation"],
  },
} as const;

const events = {
  effectQueuedV1: { name: "effectQueued", payload: effectIntentV2, version: 1 },
  effectFinishedV1: { name: "effectFinished", payload: effectFinished, version: 1 },
  effectFinishedV2: { name: "effectFinished", payload: effectFinishedV2, version: 2 },
} as const;

export const effects = defineChimpbaseModuleInterface<EffectsDatabase, typeof calls, typeof events>(
  {
    calls,
    dependencies: ["assets", "definitions"],
    events,
    name: "effects",
    version: 1,
  },
);
