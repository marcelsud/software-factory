import { createHash } from "node:crypto";
import {
  type CompiledDefinition,
  canonicalJson,
  compileFactoryDefinition,
  type EffectPermissionDefinition,
  type FactoryDefinition,
} from "../compiler.ts";
import type { EffectIntentV3, EffectOperationV3 } from "../contracts/index.ts";
export interface CompiledEffectPolicyRule {
  readonly agentProfiles: readonly string[];
  readonly capability: string;
  readonly effectKinds: readonly EffectOperationV3["kind"][];
  readonly flowId: string;
  readonly stepIds: readonly string[];
  readonly targets: readonly string[];
}

export interface CompiledEffectPolicy {
  readonly definitionDigest: string;
  readonly globalDryRun: boolean;
  readonly repositories: readonly string[];
  readonly rules: readonly CompiledEffectPolicyRule[];
}

const DEFAULT_KINDS: Readonly<Record<string, readonly EffectOperationV3["kind"][]>> = {
  "issue.comment": ["create-comment", "update-comment"],
  "issue.label": ["add-label", "remove-label"],
  "pull-request.write": ["create-pull-request", "update-pull-request"],
  "repository.write": ["create-branch", "delete-branch", "push-verified-commit"],
};

export function effectPayloadDigest(operation: EffectOperationV3): string {
  return createHash("sha256").update(canonicalJson(operation), "utf8").digest("hex");
}

export function compileEffectPolicy(source: string): CompiledEffectPolicy {
  return effectPolicyFromDefinition(compileFactoryDefinition(source));
}

export function effectPolicyFromDefinition(compiled: CompiledDefinition): CompiledEffectPolicy {
  return buildEffectPolicy(compiled.definition, compiled.revision.definitionDigest);
}

export function effectPolicyFromPinnedDefinition(
  normalizedJson: string,
  definitionDigest: string,
): CompiledEffectPolicy {
  const definition = JSON.parse(normalizedJson) as FactoryDefinition;
  return buildEffectPolicy(definition, definitionDigest);
}

function buildEffectPolicy(
  definition: FactoryDefinition,
  definitionDigest: string,
): CompiledEffectPolicy {
  const rules: CompiledEffectPolicyRule[] = [];
  for (const permission of definition.effectPermissions) {
    const kinds = kindsFor(permission);
    for (const flow of definition.flows) {
      if (permission.flows !== undefined && !permission.flows.includes(flow.id)) continue;
      const stepIds = flow.steps
        .filter(
          (step) =>
            step.kind === "effect" &&
            (step.effectCapability === permission.capability ||
              step.capabilities.includes(permission.capability)),
        )
        .map((step) => step.id)
        .sort();
      if (stepIds.length === 0) continue;
      rules.push({
        agentProfiles: [...(permission.agentProfiles ?? [])].sort(),
        capability: permission.capability,
        effectKinds: [...kinds].sort(),
        flowId: flow.id,
        stepIds,
        targets: [...permission.targets].sort(),
      });
    }
  }
  return Object.freeze({
    definitionDigest,
    globalDryRun: definition.dryRun === true,
    repositories: definition.repositories.map(({ id }) => id).sort(),
    rules: rules.sort((left, right) =>
      `${left.flowId}\0${left.capability}`.localeCompare(`${right.flowId}\0${right.capability}`),
    ),
  });
}

export function authorizeEffect(
  policy: CompiledEffectPolicy,
  intent: EffectIntentV3,
): {
  readonly dryRun: boolean;
  readonly rule: CompiledEffectPolicyRule;
} {
  if (intent.provenance.definitionDigest !== policy.definitionDigest)
    throw new Error("effect_forbidden: definition policy revision does not match");
  if (!policy.repositories.includes(intent.target.repository))
    throw new Error("effect_forbidden: unknown target repository");
  const rule = policy.rules.find(
    (candidate) =>
      candidate.flowId === intent.provenance.flowId &&
      candidate.capability === intent.capability &&
      candidate.targets.includes(intent.target.repository) &&
      candidate.stepIds.includes(intent.provenance.stepId) &&
      candidate.effectKinds.includes(intent.operation.kind),
  );
  if (rule === undefined)
    throw new Error("effect_forbidden: undeclared capability or effect scope");
  if (
    intent.provenance.agentProfileId !== null &&
    !rule.agentProfiles.includes(intent.provenance.agentProfileId)
  )
    throw new Error("effect_forbidden: agent profile cannot invoke this effect");
  return { dryRun: policy.globalDryRun || intent.dryRun, rule };
}

function kindsFor(permission: EffectPermissionDefinition): readonly EffectOperationV3["kind"][] {
  const values = permission.effects ?? DEFAULT_KINDS[permission.capability] ?? [];
  return values as readonly EffectOperationV3["kind"][];
}
