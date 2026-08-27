import { createHash } from "node:crypto";
import {
  type ChimpbaseModuleContext,
  type ChimpbaseModuleInterface,
  defineChimpbaseModuleImplementation,
} from "chimpbase/core";
import type { Kysely } from "kysely";

import {
  type AcceptedFactoryEvent,
  type FactoryEvent,
  factoryEvent,
} from "../../contracts/index.ts";
import { type IntakeDatabase, intakeMigrations } from "../../storage/intake-database.ts";
import { intake } from "./interface.ts";

const implementationInterface = intake as unknown as ChimpbaseModuleInterface<
  typeof intake.calls,
  typeof intake.events
>;

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("invalid_source_event: cyclic payload");
    ancestors.add(value);
    const result = `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new Error("invalid_source_event: cyclic payload");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const result = `{${Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) throw new Error("invalid_source_event: undefined payload value");
        return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`;
      })
      .join(",")}}`;
    ancestors.delete(value);
    return result;
  }
  throw new Error(`invalid_source_event: unsupported payload value ${typeof value}`);
}
interface CursorAdvance {
  expectedCursor: string | null;
  nextCursor: string;
}

async function acceptDurably(
  ctx: ChimpbaseModuleContext<IntakeDatabase>,
  input: FactoryEvent,
  cursorAdvance?: CursorAdvance,
): Promise<AcceptedFactoryEvent> {
  const event = factoryEvent.parse(input);
  const payloadJson = canonicalJson(event.payload);
  const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
  const db: Kysely<IntakeDatabase> = ctx.db.kysely();
  const existing = await db
    .selectFrom("delivery_deduplication")
    .select("payload_digest")
    .where("source_id", "=", event.sourceId)
    .where("delivery_id", "=", event.deliveryId)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.payload_digest !== payloadDigest) {
      throw new Error("delivery_conflict: source delivery identity has a different payload digest");
    }
    const accepted = await db
      .selectFrom("factory_events")
      .select("event_json")
      .where("source_id", "=", event.sourceId)
      .where("delivery_id", "=", event.deliveryId)
      .executeTakeFirstOrThrow();
    return {
      event: factoryEvent.parse(JSON.parse(accepted.event_json)),
      idempotent: true,
      payloadDigest,
    };
  }

  await db
    .insertInto("event_sources")
    .values({
      created_at: event.observedAt,
      source_id: event.sourceId,
    })
    .onConflict((conflict) => conflict.column("source_id").doNothing())
    .execute();
  await db
    .insertInto("delivery_deduplication")
    .values({
      accepted_at: event.observedAt,
      delivery_id: event.deliveryId,
      payload_digest: payloadDigest,
      source_id: event.sourceId,
    })
    .execute();
  await db
    .insertInto("factory_events")
    .values({
      delivery_id: event.deliveryId,
      event_json: canonicalJson(event),
      event_type: event.eventType,
      observed_at: event.observedAt,
      payload_digest: payloadDigest,
      repository: event.repository,
      source_id: event.sourceId,
      source_revision: event.sourceRevision,
      subject: event.subject,
    })
    .execute();
  await db
    .insertInto("source_payload_snapshots")
    .values({
      delivery_id: event.deliveryId,
      observed_at: event.observedAt,
      payload_digest: payloadDigest,
      payload_json: payloadJson,
      source_id: event.sourceId,
    })
    .execute();
  const cursor = await db
    .selectFrom("source_cursors")
    .selectAll()
    .where("source_id", "=", event.sourceId)
    .executeTakeFirst();
  if (cursorAdvance !== undefined) {
    if ((cursor?.cursor ?? null) !== cursorAdvance.expectedCursor) {
      throw new Error("cursor_conflict: committed source cursor does not match expected cursor");
    }
    if (cursor === undefined) {
      const inserted = await db
        .insertInto("source_cursors")
        .values({
          cursor: cursorAdvance.nextCursor,
          source_id: event.sourceId,
          updated_at: event.observedAt,
        })
        .onConflict((conflict) => conflict.column("source_id").doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows !== 1n) {
        throw new Error("cursor_conflict: source cursor changed during acceptance");
      }
    } else {
      const updated = await db
        .updateTable("source_cursors")
        .set({
          cursor: cursorAdvance.nextCursor,
          updated_at: event.observedAt,
        })
        .where("source_id", "=", event.sourceId)
        .where("cursor", "=", cursorAdvance.expectedCursor ?? "")
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new Error("cursor_conflict: source cursor changed during acceptance");
      }
    }
  } else if (cursor === undefined) {
    await db
      .insertInto("source_cursors")
      .values({
        cursor: event.sourceRevision,
        source_id: event.sourceId,
        updated_at: event.observedAt,
      })
      .execute();
  }
  const accepted = { event, idempotent: false, payloadDigest };
  ctx.publish(intake.events.factoryEventAcceptedV1, event);
  ctx.publish(intake.events.factoryEventAcceptedV2, accepted);
  return accepted;
}

export const intakeImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: intakeMigrations,
  resources: {
    collections: [
      "delivery-deduplication",
      "event-sources",
      "factory-events",
      "source-cursors",
      "source-payload-snapshots",
    ],
    tables: [
      "delivery_deduplication",
      "event_sources",
      "factory_events",
      "source_cursors",
      "source_payload_snapshots",
    ],
  },
  calls: {
    async acceptSourceEvent(ctx, input) {
      try {
        return (
          await acceptDurably(ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>, input)
        ).event;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("delivery_conflict:")) {
          throw new Error(error.message.replace("delivery_conflict:", "duplicate_delivery:"));
        }
        throw error;
      }
    },
    async acceptSourceEventV2(ctx, input) {
      return await acceptDurably(
        ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>,
        input.event,
        { expectedCursor: input.expectedCursor, nextCursor: input.nextCursor },
      );
    },
    async getSourceCursor(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<IntakeDatabase>;
      const row = await db
        .selectFrom("source_cursors")
        .selectAll()
        .where("source_id", "=", input.sourceId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { cursor: row.cursor, sourceId: row.source_id, updatedAt: row.updated_at };
    },
    pollRepository() {
      throw new Error("module_unavailable: intake.pollRepository requires a leaf-03 transport");
    },
  },
});
