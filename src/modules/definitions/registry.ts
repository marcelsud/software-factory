import { compileFactoryDefinition } from "../../compiler.ts";
import type { DefinitionRevision, ExecutionPlan } from "../../contracts/index.ts";

export class DefinitionRegistry {
  readonly #plans = new Map<string, Readonly<Record<string, ExecutionPlan>>>();
  readonly #revisions = new Map<string, DefinitionRevision>();

  compile(source: string, sourceName = "factory.yaml"): DefinitionRevision {
    const compiled = compileFactoryDefinition(source, { sourceName });
    const existing = this.#revisions.get(compiled.revision.definitionDigest);
    if (existing !== undefined) return existing;
    this.#revisions.set(compiled.revision.definitionDigest, compiled.revision);
    this.#plans.set(compiled.revision.definitionDigest, compiled.plans);
    return compiled.revision;
  }

  resolve(definitionDigest: string): DefinitionRevision | null {
    return this.#revisions.get(definitionDigest) ?? null;
  }

  getExecutionPlan(definitionDigest: string, flowId: string): ExecutionPlan | null {
    return this.#plans.get(definitionDigest)?.[flowId] ?? null;
  }
}
