import {
  type ChimpbaseModuleContext,
  type ChimpbaseModuleInterface,
  defineChimpbaseModuleImplementation,
} from "chimpbase/core";
import { action, worker } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import {
  type EffectFinishedV2,
  type EffectIntentV2,
  type EffectOutcome,
  type EffectReceipt,
  type EffectReceiptV2,
  effectFinished,
  effectFinishedV2,
  effectOutcome,
  effectReceipt,
  effectReceiptV2,
} from "../../contracts/index.ts";
import {
  type EffectReceiptRow,
  type EffectsDatabase,
  effectsMigrations,
} from "../../storage/effects-database.ts";
import { effects } from "./interface.ts";

const implementationInterface = effects as unknown as ChimpbaseModuleInterface<
  typeof effects.calls,
  typeof effects.events
>;
const legacyRequestedAt = "1970-01-01T00:00:00.000Z";

function receiptV2FromRow(row: EffectReceiptRow): EffectReceiptV2 {
  return effectReceiptV2.parse({
    correlationToken: row.correlation_token,
    effectId: row.effect_id,
    externalRevision: row.external_revision,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome,
    recordedAt: row.recorded_at,
    runId: row.run_id,
  });
}

function receiptV1FromV2(receipt: EffectReceiptV2): EffectReceipt {
  return effectReceipt.parse({
    effectId: receipt.effectId,
    externalRevision: receipt.externalRevision,
    ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
    idempotencyKey: receipt.idempotencyKey,
    outcome: receipt.outcome,
    recordedAt: receipt.recordedAt,
    runId: receipt.runId,
  });
}

async function loadReceipt(db: Kysely<EffectsDatabase>, idempotencyKey: string) {
  const row = await db
    .selectFrom("effect_receipts")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : receiptV2FromRow(row);
}

async function requestDurably(
  ctx: ChimpbaseModuleContext<EffectsDatabase>,
  input: EffectIntentV2,
): Promise<EffectReceiptV2> {
  const db = ctx.db.kysely();
  const existingIntent = await db
    .selectFrom("effect_intents")
    .selectAll()
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirst();
  if (existingIntent !== undefined) {
    const same =
      existingIntent.run_id === input.runId &&
      existingIntent.correlation_token === input.correlationToken &&
      existingIntent.provenance === input.provenance &&
      existingIntent.capability === input.capability &&
      existingIntent.target === input.target &&
      existingIntent.expected_external_revision === input.expectedExternalRevision &&
      existingIntent.payload_digest === input.payloadDigest &&
      existingIntent.requested_at === input.requestedAt;
    if (!same) throw new Error("effect_forbidden: idempotency key already has a different intent");
    const receipt = await loadReceipt(db, input.idempotencyKey);
    if (receipt === null) throw new Error("receipt_not_found");
    return receipt;
  }
  await db
    .insertInto("effect_intents")
    .values({
      capability: input.capability,
      correlation_token: input.correlationToken,
      expected_external_revision: input.expectedExternalRevision,
      idempotency_key: input.idempotencyKey,
      payload_digest: input.payloadDigest,
      provenance: input.provenance,
      requested_at: input.requestedAt,
      run_id: input.runId,
      target: input.target,
    })
    .execute();
  await db
    .insertInto("effect_preconditions")
    .values({
      expected_external_revision: input.expectedExternalRevision,
      idempotency_key: input.idempotencyKey,
      payload_digest: input.payloadDigest,
      target: input.target,
    })
    .execute();
  const row: EffectReceiptRow = {
    correlation_token: input.correlationToken,
    effect_id: `effect:${input.idempotencyKey}`,
    external_revision: null,
    finished_at: null,
    idempotency_key: input.idempotencyKey,
    outcome: "pending",
    recorded_at: input.requestedAt,
    run_id: input.runId,
  };
  await db.insertInto("effect_receipts").values(row).execute();
  await ctx.enqueue("effect-workers", { idempotencyKey: input.idempotencyKey });
  ctx.publish(effects.events.effectQueuedV1, input);
  return receiptV2FromRow(row);
}

async function reconcileDurably(
  db: Kysely<EffectsDatabase>,
  idempotencyKey: string,
  observedAt: string,
) {
  const receipt = await loadReceipt(db, idempotencyKey);
  if (receipt === null) throw new Error("receipt_not_found");
  await db
    .insertInto("effect_reconciliation")
    .values({
      idempotency_key: idempotencyKey,
      observed_at: observedAt,
      outcome: receipt.outcome,
    })
    .onConflict((conflict) => conflict.columns(["idempotency_key", "observed_at"]).doNothing())
    .execute();
  return receipt;
}

export const recordEffectOutcome = action({
  name: "effects.recordEffectOutcome",
  args: effectOutcome,
  result: effectFinishedV2,
  async handler(ctx, input): Promise<EffectFinishedV2> {
    const db = ctx.db.kysely<EffectsDatabase>();
    const row = await db
      .selectFrom("effect_receipts")
      .selectAll()
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) throw new Error("receipt_not_found");
    if (row.outcome !== "pending") {
      if (
        row.outcome === input.outcome &&
        row.finished_at === input.finishedAt &&
        row.external_revision === input.externalRevision
      ) {
        return effectFinishedV2.parse(receiptV2FromRow(row));
      }
      throw new Error("effect_already_finished");
    }
    await db
      .updateTable("effect_receipts")
      .set({
        external_revision: input.externalRevision,
        finished_at: input.finishedAt,
        outcome: input.outcome,
      })
      .where("idempotency_key", "=", input.idempotencyKey)
      .execute();
    const finished = effectFinishedV2.parse({
      correlationToken: row.correlation_token,
      effectId: row.effect_id,
      externalRevision: input.externalRevision,
      finishedAt: input.finishedAt,
      idempotencyKey: row.idempotency_key,
      outcome: input.outcome,
      recordedAt: row.recorded_at,
      runId: row.run_id,
    });
    ctx.publish(
      effects.events.effectFinishedV1,
      effectFinished.parse({
        effectId: finished.effectId,
        externalRevision: finished.externalRevision,
        finishedAt: finished.finishedAt,
        idempotencyKey: finished.idempotencyKey,
        outcome: finished.outcome,
        recordedAt: finished.recordedAt,
        runId: finished.runId,
      }),
    );
    ctx.publish(effects.events.effectFinishedV2, finished);
    return finished;
  },
});

const effectWorker = worker(
  "effect-workers",
  async (ctx, payload: { idempotencyKey: string; outcome?: EffectOutcome }) => {
    if (payload.outcome === undefined) {
      const receipt = await loadReceipt(ctx.db.kysely<EffectsDatabase>(), payload.idempotencyKey);
      if (receipt !== null && receipt.outcome !== "pending") return;
      throw new Error(
        `effect_adapter_unavailable: no trusted adapter configured for ${payload.idempotencyKey}`,
      );
    }
    await ctx.action(recordEffectOutcome, payload.outcome);
  },
);

export const effectsImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: effectsMigrations,
  registrations: [recordEffectOutcome, effectWorker],
  resources: {
    collections: ["effect-intents", "effect-receipts", "effect-reconciliation"],
    queues: ["effect-workers"],
    tables: ["effect_intents", "effect_preconditions", "effect_receipts", "effect_reconciliation"],
  },
  calls: {
    async requestEffect(ctx, input) {
      const receipt = await requestDurably(
        ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>,
        { ...input, requestedAt: legacyRequestedAt },
      );
      return receiptV1FromV2(receipt);
    },
    async requestEffectV2(ctx, input) {
      return await requestDurably(ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>, input);
    },
    async getReceipt(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
      const receipt = await loadReceipt(db, input.idempotencyKey);
      return receipt === null ? null : receiptV1FromV2(receipt);
    },
    async getReceiptV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
      return await loadReceipt(db, input.idempotencyKey);
    },
    async reconcileEffect(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
      return receiptV1FromV2(await reconcileDurably(db, input.idempotencyKey, input.observedAt));
    },
    async reconcileEffectV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
      return await reconcileDurably(db, input.idempotencyKey, input.observedAt);
    },
  },
});
