import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { definitionRevision, executionPlan, executionPlanV2 } from "../../contracts/index.ts";
import type { DefinitionsDatabase } from "../../storage/definitions-database.ts";

const calls = {
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
  getExecutionPlanV2: {
    input: v.object({ definitionDigest: v.string(), flowId: v.string() }),
    output: executionPlanV2.nullable(),
    errors: [],
    guarantees: ["returns the strict orchestration plan pinned to the requested revisions"],
  },
  activateDefinition: {
    input: v.object({ definitionDigest: v.string() }),
    output: definitionRevision,
    errors: ["definition_not_found"],
    guarantees: ["atomically replaces the singleton active-definition pointer"],
  },
  getActiveDefinition: {
    input: v.object({}),
    output: definitionRevision.nullable(),
    errors: [],
    guarantees: ["returns the persisted active definition pointer"],
  },
} as const;

const events = {
  definitionPublishedV1: {
    name: "definitionPublished",
    payload: definitionRevision,
    version: 1,
  },
} as const;

export const definitions = defineChimpbaseModuleInterface<
  DefinitionsDatabase,
  typeof calls,
  typeof events
>({ calls, events, name: "definitions", version: 1 });
