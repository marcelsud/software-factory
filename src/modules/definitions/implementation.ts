import { defineChimpbaseModuleImplementation } from "chimpbase/core";
import { definitions } from "./interface.ts";
import { DefinitionRegistry } from "./registry.ts";

export function createDefinitionsImplementation() {
  const registry = new DefinitionRegistry();
  return defineChimpbaseModuleImplementation({
    interface: definitions,
    calls: {
      compileDefinition(ctx, input) {
        const revision = registry.compile(input.source, input.sourceName);
        ctx.publish(definitions.events.definitionPublishedV1, revision);
        return revision;
      },
      resolveRevision(_ctx, input) {
        return registry.resolve(input.definitionDigest);
      },
      getExecutionPlan(_ctx, input) {
        return registry.getExecutionPlan(input.definitionDigest, input.flowId);
      },
    },
    resources: {},
  });
}

export const definitionsImplementation = createDefinitionsImplementation();
