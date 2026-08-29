import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  effectDryRunV3,
  effectFinished,
  effectFinishedV2,
  effectFinishedV3,
  effectIntent,
  effectIntentV2,
  effectIntentV3,
  effectReceipt,
  effectReceiptV2,
  effectReceiptV3,
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
  requestEffectV3: {
    input: effectIntentV3,
    output: effectReceiptV3,
    errors: [
      "module_unavailable",
      "effect_forbidden",
      "stale_external_revision",
      "payload_digest_mismatch",
    ],
    guarantees: [
      "persists strict intent, precondition, and receipt before durable execution",
      "never accepts executable credentials",
    ],
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
  getReceiptV3: {
    input: v.object({ idempotencyKey: v.string() }),
    output: effectReceiptV3.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns the sole strict committed receipt"],
  },
  getDryRunV3: {
    input: v.object({ idempotencyKey: v.string() }),
    output: effectDryRunV3.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns the exact persisted no-write plan"],
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
  reconcileEffectV3: {
    input: v.object({ idempotencyKey: v.string(), observedAt: v.string() }),
    output: effectReceiptV3,
    errors: ["module_unavailable", "receipt_not_found", "reconciliation_failed"],
    guarantees: ["probes the idempotency marker without repeating the external write"],
  },
  correlateBotEventV3: {
    input: v.object({
      actorType: v.enum(["bot", "unknown", "user"]),
      body: v.string(),
      externalId: v.string(),
      observedAt: v.string(),
    }),
    output: effectReceiptV3.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["correlates only factory-marked bot events to a committed receipt"],
  },
} as const;

const events = {
  effectQueuedV1: { name: "effectQueued", payload: effectIntentV2, version: 1 },
  effectFinishedV1: { name: "effectFinished", payload: effectFinished, version: 1 },
  effectFinishedV2: { name: "effectFinished", payload: effectFinishedV2, version: 2 },
  effectQueuedV2: { name: "effectQueued", payload: effectIntentV3, version: 2 },
  effectFinishedV3: { name: "effectFinished", payload: effectFinishedV3, version: 3 },
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
