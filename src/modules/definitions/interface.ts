import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { definitionRevision, executionPlan } from "../../contracts/index.ts";

export const definitions = defineChimpbaseModuleInterface({
  name: "definitions",
  version: 1,
  calls: {
    compileDefinition: {
      input: v.object({ source: v.string(), sourceName: v.string() }),
      output: definitionRevision,
      errors: ["invalid_definition"],
      guarantees: ["returns a byte-stable immutable revision for equivalent input"],
    },
    resolveRevision: {
      input: v.object({ definitionDigest: v.string() }),
      output: definitionRevision.nullable(),
      errors: [],
      guarantees: ["never mutates a published revision"],
    },
    getExecutionPlan: {
      input: v.object({ definitionDigest: v.string(), flowId: v.string() }),
      output: executionPlan.nullable(),
      errors: [],
      guarantees: ["returns the plan pinned to the requested definition and flow digests"],
    },
  },
  events: {
    definitionPublishedV1: {
      name: "definitionPublished",
      payload: definitionRevision,
      version: 1,
    },
  },
});
