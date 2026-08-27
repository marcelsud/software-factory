import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { acceptedFactoryEvent, factoryEvent, sourceCursor } from "../../contracts/index.ts";
import type { IntakeDatabase } from "../../storage/intake-database.ts";

const calls = {
  acceptSourceEvent: {
    input: factoryEvent,
    output: factoryEvent,
    errors: ["module_unavailable", "duplicate_delivery", "invalid_source_event"],
    guarantees: ["acceptance is idempotent by source and delivery identity"],
  },
  acceptSourceEventV2: {
    input: v.object({
      event: factoryEvent,
      expectedCursor: v.string().nullable(),
      nextCursor: v.string(),
    }),
    output: acceptedFactoryEvent,
    errors: ["module_unavailable", "cursor_conflict", "delivery_conflict", "invalid_source_event"],
    guarantees: [
      "atomically compares the committed cursor and advances to the supplied next position",
    ],
  },
  getSourceCursor: {
    input: v.object({ sourceId: v.string() }),
    output: sourceCursor,
    errors: ["module_unavailable"],
    guarantees: ["returns only a cursor advanced by committed event acceptance"],
  },
  pollRepository: {
    input: v.object({ observedAt: v.string(), sourceId: v.string() }),
    output: v.object({ accepted: v.integer(), cursor: sourceCursor }),
    errors: ["module_unavailable", "source_not_found", "transport_failure"],
    guarantees: ["never advances a cursor past an uncommitted event"],
  },
} as const;

const events = {
  factoryEventAcceptedV1: {
    name: "factoryEventAccepted",
    payload: factoryEvent,
    version: 1,
  },
  factoryEventAcceptedV2: {
    name: "factoryEventAccepted",
    payload: acceptedFactoryEvent,
    version: 2,
  },
} as const;

export const intake = defineChimpbaseModuleInterface<IntakeDatabase, typeof calls, typeof events>({
  calls,
  dependencies: ["definitions"],
  events,
  name: "intake",
  version: 1,
});
