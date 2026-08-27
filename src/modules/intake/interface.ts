import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { factoryEvent, sourceCursor } from "../../contracts/index.ts";

export const intake = defineChimpbaseModuleInterface({
  name: "intake",
  version: 1,
  dependencies: ["definitions"],
  calls: {
    acceptSourceEvent: {
      input: factoryEvent,
      output: factoryEvent,
      errors: ["module_unavailable", "duplicate_delivery", "invalid_source_event"],
      guarantees: ["acceptance is idempotent by source and delivery identity"],
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
  },
  events: {
    factoryEventAcceptedV1: {
      name: "factoryEventAccepted",
      payload: factoryEvent,
      version: 1,
    },
  },
});
