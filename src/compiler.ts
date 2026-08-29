import { createHash } from "node:crypto";
import { posix } from "node:path";

import { parseDocument } from "yaml";

import {
  CAPABILITY_OWNERS,
  type DefinitionRevision,
  type ExecutionPlan,
  type ExecutionPlanV2,
  isDataRecord,
  type PinnedAgentProfile,
} from "./contracts/index.ts";

export interface DefinitionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly remediation: string;
}

export class DefinitionCompileError extends Error {
  readonly diagnostics: readonly DefinitionDiagnostic[];

  constructor(diagnostics: readonly DefinitionDiagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
    this.name = "DefinitionCompileError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface CompileOptions {
  readonly allowUnpinnedSkills?: boolean;
  readonly skillRoots?: readonly string[];
  readonly sourceName?: string;
}

export interface RepositoryDefinition {
  readonly defaultBranch: string;
  readonly id: string;
  readonly localPath?: string;
  readonly name: string;
  readonly owner: string;
}

export interface SourceDefinition {
  readonly events?: readonly string[];
  readonly id: string;
  readonly repository?: string;
  readonly schedule?: string;
  readonly type: "github" | "manual" | "schedule";
}

export interface SkillDefinition {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
}

export interface AgentProfileDefinition {
  readonly capabilities: readonly string[];
  readonly command: readonly string[];
  readonly id: string;
  readonly instructions: string;
  readonly limits: { readonly maxOutputBytes: number; readonly timeoutMs: number };
  readonly model: string;
  readonly skills: readonly string[];
}

export interface ResultContractDefinition {
  readonly dataTypes: Readonly<Record<string, "boolean" | "number" | "string" | "unknown">>;
  readonly outcome: string;
  readonly requiredArtifactCount: number;
  readonly requiredData: readonly string[];
}

export interface StepDefinition {
  readonly agentProfile?: string;
  readonly capabilities: readonly string[];
  readonly deterministicOutcome?: string;
  readonly effectCapability?: string;
  readonly effectPayloadDigest?: string;
  readonly effectTarget?: string;
  readonly id: string;
  readonly kind: "agent" | "deterministic" | "effect";
  readonly resultContracts: readonly ResultContractDefinition[];
  readonly retry: { readonly backoffMs: number; readonly maxAttempts: number };
  readonly skill?: string;
}

export interface GateDefinition {
  readonly accepted: readonly string[];
  readonly id: string;
  readonly kind: "approval" | "event" | "signal";
  readonly requiredArtifactCount: number;
  readonly requiredArtifactSteps: readonly string[];
  readonly requiredOutcome?: string;
  readonly timeoutMs?: number;
  readonly timeoutOutcome?: string;
}

export interface StateDefinition {
  readonly gate?: string;
  readonly id: string;
  readonly step?: string;
  readonly terminal?: "success" | "failure";
  readonly terminalOutcome?:
    | "not_actionable"
    | "needs_reproduction"
    | "unable_to_reproduce"
    | "unable_to_fix"
    | "failed"
    | "waiting"
    | "completed"
    | "cancelled";
}

export interface TransitionDefinition {
  readonly from: string;
  readonly mode: "immediate" | "signal";
  readonly on: string;
  readonly to: string;
}

export interface TriggerPredicateDefinition {
  readonly field: string;
  readonly operator: "equals" | "not_equals" | "in" | "not_in" | "exists";
  readonly value?: string;
  readonly values?: readonly string[];
}

export interface FlowDefinition {
  readonly artifactHandoffs: readonly { readonly fromStep: string; readonly toStep: string }[];
  readonly concurrency: { readonly key: string; readonly limit: number };
  readonly gates: readonly GateDefinition[];
  readonly id: string;
  readonly initialState: string;
  readonly states: readonly StateDefinition[];
  readonly steps: readonly StepDefinition[];
  readonly transitions: readonly TransitionDefinition[];
  readonly triggers: readonly {
    readonly predicates: readonly TriggerPredicateDefinition[];
    readonly source: string;
  }[];
}

export interface EffectPermissionDefinition {
  readonly agentProfiles?: readonly string[];
  readonly capability: string;
  readonly effects?: readonly string[];
  readonly flows?: readonly string[];
  readonly targets: readonly string[];
}

export interface FactoryDefinition {
  readonly agentProfiles: readonly AgentProfileDefinition[];
  readonly capabilities: readonly { readonly description: string; readonly id: string }[];
  readonly dryRun?: boolean;
  readonly effectPermissions: readonly EffectPermissionDefinition[];
  readonly flows: readonly FlowDefinition[];
  readonly repositories: readonly RepositoryDefinition[];
  readonly skills: readonly SkillDefinition[];
  readonly sources: readonly SourceDefinition[];
  readonly version: 1;
}

export interface CompiledDefinition {
  readonly definition: FactoryDefinition;
  readonly plans: Readonly<Record<string, ExecutionPlan>>;
  readonly plansV2: Readonly<Record<string, ExecutionPlanV2>>;
  readonly revision: DefinitionRevision;
}

type DataRecord = Record<string, unknown>;

const EFFECT_KIND_NAMES: Readonly<Record<string, true>> = {
  "add-label": true,
  "remove-label": true,
  "create-comment": true,
  "update-comment": true,
  "create-branch": true,
  "delete-branch": true,
  "push-verified-commit": true,
  "create-pull-request": true,
  "update-pull-request": true,
};

export function compileFactoryDefinition(
  source: string,
  options: CompileOptions = {},
): CompiledDefinition {
  const sourceName = options.sourceName ?? "factory.yaml";
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  const yamlProblems = [...document.errors, ...document.warnings];
  if (yamlProblems.length > 0) {
    fail(
      "$",
      `invalid or unsafe YAML: ${yamlProblems.map((entry) => entry.message).join("; ")}`,
      "use plain data-only YAML with unique keys and no custom tags, aliases, or module directives",
      "invalid_yaml",
    );
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(
      "$",
      `invalid or unsafe YAML: ${error instanceof Error ? error.message : String(error)}`,
      "remove YAML aliases and keep the file data-only",
      "invalid_yaml",
    );
  }

  const definition = deepFreeze(
    parseDefinition(raw, options.skillRoots ?? ["skills"], options.allowUnpinnedSkills === true),
  );
  validateDefinition(definition);
  const normalizedJson = canonicalJson(definition);
  const definitionDigest = sha256(normalizedJson);
  const flowDigests = Object.fromEntries(
    definition.flows.map((flow) => [flow.id, sha256(canonicalJson(flow))]),
  );
  const plans = Object.fromEntries(
    definition.flows.map((flow) => {
      const pinnedProfiles: Array<[string, PinnedAgentProfile]> = definition.agentProfiles
        .filter((profile) => flow.steps.some((step) => step.agentProfile === profile.id))
        .map((profile) => {
          const profileDigest = sha256(canonicalJson(profile));
          return [
            profile.id,
            {
              capabilities: [...profile.capabilities],
              command: [...profile.command],
              digest: profileDigest,
              instructions: profile.instructions,
              limits: { ...profile.limits },
              model: profile.model,
              skills: [...profile.skills],
            },
          ];
        });
      const plan = deepFreeze({
        agentProfileDigests: Object.fromEntries(
          pinnedProfiles.map(([id, profile]) => [id, profile.digest]),
        ),
        agentProfiles: Object.fromEntries(pinnedProfiles),
        calls: moduleCallsFor(flow),
        concurrency: { ...flow.concurrency },
        definitionDigest,
        effectPermissions: definition.effectPermissions
          .filter((permission) =>
            flow.steps.some(
              (step) => step.kind === "effect" && step.capabilities.includes(permission.capability),
            ),
          )
          .map((permission) => ({
            capability: permission.capability,
            targets: [...permission.targets],
          })),
        events: moduleEventsFor(flow),
        flowDigest: flowDigests[flow.id] ?? "",
        flowId: flow.id,
        gates: flow.gates.map((gate) => ({
          accepted: [...gate.accepted],
          id: gate.id,
          kind: gate.kind,
        })),
        initialState: flow.initialState,
        normalizedJson: canonicalJson(flow),
        skillRevisions: Object.fromEntries(
          definition.skills
            .filter((skill) => flow.steps.some((step) => step.skill === skill.id))
            .map((skill) => [skill.id, skill.revision]),
        ),
        states: flow.states.map((state) => ({
          ...(state.gate === undefined ? {} : { gate: state.gate }),
          id: state.id,
          ...(state.step === undefined ? {} : { step: state.step }),
          ...(state.terminal === undefined ? {} : { terminal: state.terminal }),
        })),
        steps: flow.steps.map((step) => ({
          ...(step.agentProfile === undefined ? {} : { agentProfile: step.agentProfile }),
          capabilities: [...step.capabilities],
          id: step.id,
          kind: step.kind === "deterministic" ? "agent" : step.kind,
          retry: { ...step.retry },
          ...(step.skill === undefined ? {} : { skill: step.skill }),
        })),
        transitions: flow.transitions.map((transition) => ({ ...transition })),
      });
      return [flow.id, plan];
    }),
  );
  const plansV2 = Object.fromEntries(
    definition.flows.map((flow) => {
      const legacy = plans[flow.id];
      if (legacy === undefined) throw new Error(`compiled plan missing for ${flow.id}`);
      return [
        flow.id,
        deepFreeze({
          ...legacy,
          calls: moduleCallsForV2(flow),
          events: moduleEventsForV2(flow),
          artifactHandoffs: flow.artifactHandoffs.map((edge) => ({ ...edge })),
          gates: flow.gates.map((gate) => ({
            accepted: [...gate.accepted],
            id: gate.id,
            kind: gate.kind,
            requiredArtifactCount: gate.requiredArtifactCount,
            requiredArtifactSteps: [...gate.requiredArtifactSteps],
            ...(gate.requiredOutcome === undefined
              ? {}
              : { requiredOutcome: gate.requiredOutcome }),
            ...(gate.timeoutMs === undefined ? {} : { timeoutMs: gate.timeoutMs }),
            ...(gate.timeoutOutcome === undefined ? {} : { timeoutOutcome: gate.timeoutOutcome }),
          })),
          states: flow.states.map((state) => ({
            ...(state.gate === undefined ? {} : { gate: state.gate }),
            id: state.id,
            ...(state.step === undefined ? {} : { step: state.step }),
            ...(state.terminal === undefined ? {} : { terminal: state.terminal }),
            ...(state.terminalOutcome === undefined
              ? {}
              : { terminalOutcome: state.terminalOutcome }),
          })),
          steps: flow.steps.map((step) => ({
            ...(step.agentProfile === undefined ? {} : { agentProfile: step.agentProfile }),
            capabilities: [...step.capabilities],
            ...(step.deterministicOutcome === undefined
              ? {}
              : { deterministicOutcome: step.deterministicOutcome }),
            ...(step.effectCapability === undefined
              ? {}
              : { effectCapability: step.effectCapability }),
            ...(step.effectPayloadDigest === undefined
              ? {}
              : { effectPayloadDigest: step.effectPayloadDigest }),
            ...(step.effectTarget === undefined ? {} : { effectTarget: step.effectTarget }),
            id: step.id,
            kind: step.kind,
            resultContracts: step.resultContracts.map((contract) => ({
              dataTypes: { ...contract.dataTypes },
              outcome: contract.outcome,
              requiredArtifactCount: contract.requiredArtifactCount,
              requiredData: [...contract.requiredData],
            })),
            retry: { ...step.retry },
            ...(step.skill === undefined ? {} : { skill: step.skill }),
          })),
          triggers: flow.triggers.map((trigger) => {
            const source = definition.sources.find((candidate) => candidate.id === trigger.source);
            if (source === undefined)
              throw new Error(`compiled source missing for ${trigger.source}`);
            return {
              predicates: trigger.predicates.map((predicate) => ({
                field: predicate.field,
                operator: predicate.operator,
                ...(predicate.value === undefined ? {} : { value: predicate.value }),
                ...(predicate.values === undefined ? {} : { values: [...predicate.values] }),
              })),
              source: trigger.source,
              sourceId:
                source.type === "github" && source.repository !== undefined
                  ? `github:${source.repository}`
                  : source.id,
            };
          }),
        }),
      ];
    }),
  );
  const revision = deepFreeze({
    definitionDigest,
    flowDigests,
    normalizedJson,
    sourceName,
  });
  return Object.freeze({
    definition,
    plans: deepFreeze(plans),
    plansV2: deepFreeze(plansV2),
    revision,
  });
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new TypeError("value is not JSON-serializable");
  return serialized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isDataRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    Object.freeze(value);
  } else if (isDataRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseDefinition(
  value: unknown,
  skillRoots: readonly string[],
  allowUnpinnedSkills: boolean,
): FactoryDefinition {
  const record = objectAt(value, "$", [
    "version",
    "repositories",
    "sources",
    "flows",
    "agentProfiles",
    "skills",
    "capabilities",
    "effectPermissions",
    "dryRun",
  ]);
  const version = integerAt(record.version, "$.version");
  if (version !== 1)
    fail(
      "$.version",
      `unsupported definition version ${version}`,
      "set version to 1",
      "unsupported_version",
    );
  return Object.freeze({
    agentProfiles: listAt(record.agentProfiles, "$.agentProfiles").map(parseAgentProfile),
    capabilities: listAt(record.capabilities, "$.capabilities").map(parseCapability),
    ...(record.dryRun === undefined ? {} : { dryRun: booleanAt(record.dryRun, "$.dryRun") }),
    effectPermissions: listAt(record.effectPermissions, "$.effectPermissions").map(parsePermission),
    flows: listAt(record.flows, "$.flows").map(parseFlow),
    repositories: listAt(record.repositories, "$.repositories").map(parseRepository),
    skills: listAt(record.skills, "$.skills").map((entry, index) =>
      parseSkill(entry, index, skillRoots, allowUnpinnedSkills),
    ),
    sources: listAt(record.sources, "$.sources").map(parseSource),
    version: 1,
  });
}

function parseRepository(value: unknown, index: number): RepositoryDefinition {
  const path = `$.repositories[${index}]`;
  const record = objectAt(value, path, ["id", "owner", "name", "defaultBranch", "localPath"]);
  return Object.freeze({
    defaultBranch: stringAt(record.defaultBranch, `${path}.defaultBranch`),
    id: idAt(record.id, `${path}.id`),
    ...(record.localPath === undefined
      ? {}
      : { localPath: stringAt(record.localPath, `${path}.localPath`) }),
    name: stringAt(record.name, `${path}.name`),
    owner: stringAt(record.owner, `${path}.owner`),
  });
}

function parseSource(value: unknown, index: number): SourceDefinition {
  const path = `$.sources[${index}]`;
  const record = objectAt(value, path, ["id", "type", "repository", "events", "schedule"]);
  const type = enumAt(record.type, `${path}.type`, ["github", "manual", "schedule"] as const);
  const repository = optionalString(record.repository, `${path}.repository`);
  const events =
    record.events === undefined ? undefined : stringListAt(record.events, `${path}.events`);
  const schedule = optionalString(record.schedule, `${path}.schedule`);
  if (type === "github" && repository === undefined) {
    fail(
      `${path}.repository`,
      "GitHub source requires a repository",
      "set repository to a declared repository id",
      "missing_value",
    );
  }
  if (type === "github" && (events === undefined || events.length === 0)) {
    fail(
      `${path}.events`,
      "GitHub source requires at least one event",
      "list accepted GitHub event names",
      "missing_value",
    );
  }
  if (type === "schedule" && schedule === undefined) {
    fail(
      `${path}.schedule`,
      "schedule source requires a cron expression",
      "set a data-only cron expression",
      "missing_value",
    );
  }
  return Object.freeze({
    ...(events === undefined ? {} : { events: Object.freeze(events) }),
    id: idAt(record.id, `${path}.id`),
    ...(repository === undefined ? {} : { repository }),
    ...(schedule === undefined ? {} : { schedule }),
    type,
  });
}

function parseCapability(
  value: unknown,
  index: number,
): { readonly description: string; readonly id: string } {
  const path = `$.capabilities[${index}]`;
  const record = objectAt(value, path, ["id", "description"]);
  return Object.freeze({
    description: stringAt(record.description, `${path}.description`),
    id: idAt(record.id, `${path}.id`),
  });
}

function parsePermission(value: unknown, index: number): EffectPermissionDefinition {
  const path = `$.effectPermissions[${index}]`;
  const record = objectAt(value, path, [
    "capability",
    "targets",
    "flows",
    "agentProfiles",
    "effects",
  ]);
  return Object.freeze({
    ...(record.agentProfiles === undefined
      ? {}
      : {
          agentProfiles: Object.freeze(stringListAt(record.agentProfiles, `${path}.agentProfiles`)),
        }),
    capability: idAt(record.capability, `${path}.capability`),
    ...(record.effects === undefined
      ? {}
      : { effects: Object.freeze(stringListAt(record.effects, `${path}.effects`)) }),
    ...(record.flows === undefined
      ? {}
      : { flows: Object.freeze(stringListAt(record.flows, `${path}.flows`)) }),
    targets: Object.freeze(stringListAt(record.targets, `${path}.targets`)),
  });
}

function parseSkill(
  value: unknown,
  index: number,
  skillRoots: readonly string[],
  allowUnpinnedSkills: boolean,
): SkillDefinition {
  const path = `$.skills[${index}]`;
  const record = objectAt(value, path, ["id", "path", "revision"]);
  const skillPath = stringAt(record.path, `${path}.path`);
  const normalized = posix.normalize(skillPath.replaceAll("\\", "/"));
  const revision = stringAt(record.revision, `${path}.revision`);
  if (
    (!allowUnpinnedSkills || revision !== "unpinned") &&
    !/^sha256:[a-f0-9]{64}$/.test(revision)
  ) {
    fail(
      `${path}.revision`,
      `skill revision ${JSON.stringify(revision)} is neither a SHA-256 digest nor the explicit unpinned marker`,
      'pin the skill as sha256:<64 lowercase hexadecimal characters> or set exactly "unpinned"',
      "invalid_skill_revision",
    );
  }
  const insideRoot = skillRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
  if (
    skillPath.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !insideRoot
  ) {
    fail(
      `${path}.path`,
      `skill path ${JSON.stringify(skillPath)} escapes configured skill roots`,
      `place the skill under one of: ${skillRoots.join(", ")}`,
      "skill_root_escape",
    );
  }
  return Object.freeze({
    id: idAt(record.id, `${path}.id`),
    path: normalized,
    revision,
  });
}

function parseAgentProfile(value: unknown, index: number): AgentProfileDefinition {
  const path = `$.agentProfiles[${index}]`;
  const record = objectAt(value, path, [
    "id",
    "model",
    "command",
    "instructions",
    "limits",
    "skills",
    "capabilities",
  ]);
  const command = stringListAt(record.command, `${path}.command`);
  if (command.length === 0) {
    fail(
      `${path}.command`,
      "agent profile command cannot be empty",
      "declare the trusted executable and its fixed arguments",
      "invalid_agent_profile",
    );
  }
  if (command[0]?.startsWith("/") !== true) {
    fail(
      `${path}.command[0]`,
      "agent profile executable must be an absolute trusted path",
      "resolve the executable through trusted composition before compiling the definition",
      "invalid_agent_profile",
    );
  }
  const limits = objectAt(record.limits, `${path}.limits`, ["timeoutMs", "maxOutputBytes"]);
  const timeoutMs = integerAt(limits.timeoutMs, `${path}.limits.timeoutMs`);
  const maxOutputBytes = integerAt(limits.maxOutputBytes, `${path}.limits.maxOutputBytes`);
  if (timeoutMs < 1 || maxOutputBytes < 1) {
    fail(
      `${path}.limits`,
      "agent profile limits must be positive",
      "set timeoutMs and maxOutputBytes to positive integers",
      "invalid_agent_profile",
    );
  }
  return Object.freeze({
    capabilities: Object.freeze(stringListAt(record.capabilities, `${path}.capabilities`)),
    command: Object.freeze(command),
    id: idAt(record.id, `${path}.id`),
    instructions: stringAt(record.instructions, `${path}.instructions`),
    limits: Object.freeze({ maxOutputBytes, timeoutMs }),
    model: stringAt(record.model, `${path}.model`),
    skills: Object.freeze(stringListAt(record.skills, `${path}.skills`)),
  });
}

function parseFlow(value: unknown, index: number): FlowDefinition {
  const path = `$.flows[${index}]`;
  const record = objectAt(value, path, [
    "id",
    "initialState",
    "triggers",
    "concurrency",
    "steps",
    "gates",
    "states",
    "transitions",
    "artifactHandoffs",
  ]);
  const concurrencyRecord = objectAt(record.concurrency, `${path}.concurrency`, ["key", "limit"]);
  const limit = integerAt(concurrencyRecord.limit, `${path}.concurrency.limit`);
  if (limit < 1)
    fail(
      `${path}.concurrency.limit`,
      "concurrency limit must be positive",
      "set limit to at least 1",
      "invalid_value",
    );
  return Object.freeze({
    artifactHandoffs: (record.artifactHandoffs === undefined
      ? []
      : listAt(record.artifactHandoffs, `${path}.artifactHandoffs`).map((entry, child) => {
          const edgePath = `${path}.artifactHandoffs[${child}]`;
          const edge = objectAt(entry, edgePath, ["fromStep", "toStep"]);
          return Object.freeze({
            fromStep: idAt(edge.fromStep, `${edgePath}.fromStep`),
            toStep: idAt(edge.toStep, `${edgePath}.toStep`),
          });
        })) as readonly { readonly fromStep: string; readonly toStep: string }[],
    concurrency: Object.freeze({
      key: stringAt(concurrencyRecord.key, `${path}.concurrency.key`),
      limit,
    }),
    gates: listAt(record.gates, `${path}.gates`).map((entry, child) =>
      parseGate(entry, index, child),
    ),
    id: idAt(record.id, `${path}.id`),
    initialState: idAt(record.initialState, `${path}.initialState`),
    states: listAt(record.states, `${path}.states`).map((entry, child) =>
      parseState(entry, index, child),
    ),
    steps: listAt(record.steps, `${path}.steps`).map((entry, child) =>
      parseStep(entry, index, child),
    ),
    transitions: listAt(record.transitions, `${path}.transitions`).map((entry, child) =>
      parseTransition(entry, index, child),
    ),
    triggers: listAt(record.triggers, `${path}.triggers`).map((entry, child) => {
      const triggerPath = `${path}.triggers[${child}]`;
      const trigger = objectAt(entry, triggerPath, ["source", "predicates"]);
      const predicates =
        trigger.predicates === undefined
          ? []
          : listAt(trigger.predicates, `${triggerPath}.predicates`).map((raw, predicateIndex) => {
              const predicatePath = `${triggerPath}.predicates[${predicateIndex}]`;
              const predicate = objectAt(raw, predicatePath, [
                "field",
                "operator",
                "value",
                "values",
              ]);
              const field = stringAt(predicate.field, `${predicatePath}.field`);
              if (
                !/^(actor|eventType|repository|sourceId|sourceRevision|subject|payload(?:\.[A-Za-z0-9_-]+)*)$/.test(
                  field,
                )
              ) {
                fail(
                  `${predicatePath}.field`,
                  `unsupported predicate field ${JSON.stringify(field)}`,
                  "use a declared event field or a dotted payload field",
                  "invalid_trigger_predicate",
                );
              }
              const operator = enumAt(predicate.operator, `${predicatePath}.operator`, [
                "equals",
                "not_equals",
                "in",
                "not_in",
                "exists",
              ] as const);
              const value = optionalString(predicate.value, `${predicatePath}.value`);
              const values =
                predicate.values === undefined
                  ? undefined
                  : stringListAt(predicate.values, `${predicatePath}.values`);
              if (
                (operator === "exists" && (value !== undefined || values !== undefined)) ||
                (["equals", "not_equals"].includes(operator) &&
                  (value === undefined || values !== undefined)) ||
                (["in", "not_in"].includes(operator) &&
                  (values === undefined || values.length === 0 || value !== undefined))
              ) {
                fail(
                  predicatePath,
                  `operator ${operator} has an invalid value shape`,
                  "use value for equals/not_equals, values for in/not_in, and neither for exists",
                  "invalid_trigger_predicate",
                );
              }
              return Object.freeze({
                field,
                operator,
                ...(value === undefined ? {} : { value }),
                ...(values === undefined ? {} : { values: Object.freeze(values) }),
              });
            });
      return Object.freeze({
        predicates: Object.freeze(predicates),
        source: idAt(trigger.source, `${triggerPath}.source`),
      });
    }),
  });
}

function parseStep(value: unknown, flowIndex: number, index: number): StepDefinition {
  const path = `$.flows[${flowIndex}].steps[${index}]`;
  const record = objectAt(value, path, [
    "id",
    "kind",
    "agentProfile",
    "skill",
    "capabilities",
    "retry",
    "results",
    "outcome",
    "effectCapability",
    "effectTarget",
    "effectPayloadDigest",
  ]);
  const kind = enumAt(record.kind, `${path}.kind`, ["agent", "deterministic", "effect"] as const);
  const retryRecord = objectAt(record.retry, `${path}.retry`, ["maxAttempts", "backoffMs"]);
  const maxAttempts = integerAt(retryRecord.maxAttempts, `${path}.retry.maxAttempts`);
  const backoffMs = integerAt(retryRecord.backoffMs, `${path}.retry.backoffMs`);
  if (maxAttempts < 1)
    fail(
      `${path}.retry.maxAttempts`,
      "retry attempts must be positive",
      "set maxAttempts to at least 1",
      "invalid_value",
    );
  if (backoffMs < 0)
    fail(
      `${path}.retry.backoffMs`,
      "retry backoff cannot be negative",
      "set backoffMs to zero or greater",
      "invalid_value",
    );
  const agentProfile = optionalString(record.agentProfile, `${path}.agentProfile`);
  const skill = optionalString(record.skill, `${path}.skill`);
  const deterministicOutcome = optionalString(record.outcome, `${path}.outcome`);
  const effectCapability = optionalString(record.effectCapability, `${path}.effectCapability`);
  const effectTarget = optionalString(record.effectTarget, `${path}.effectTarget`);
  const effectPayloadDigest = optionalString(
    record.effectPayloadDigest,
    `${path}.effectPayloadDigest`,
  );
  const resultContracts =
    record.results === undefined
      ? []
      : listAt(record.results, `${path}.results`).map((entry, child) => {
          const resultPath = `${path}.results[${child}]`;
          const result = objectAt(entry, resultPath, [
            "outcome",
            "requiredData",
            "requiredArtifactCount",
            "dataTypes",
          ]);
          const requiredArtifactCount =
            optionalInteger(result.requiredArtifactCount, `${resultPath}.requiredArtifactCount`) ??
            0;
          if (requiredArtifactCount < 0) {
            fail(
              `${resultPath}.requiredArtifactCount`,
              "artifact count cannot be negative",
              "use zero or greater",
              "invalid_result_contract",
            );
          }
          const dataTypes =
            result.dataTypes === undefined
              ? {}
              : Object.fromEntries(
                  Object.entries(
                    objectAt(
                      result.dataTypes,
                      `${resultPath}.dataTypes`,
                      Object.keys(result.dataTypes as object),
                    ),
                  ).map(([key, value]) => [
                    key,
                    enumAt(value, `${resultPath}.dataTypes.${key}`, [
                      "boolean",
                      "number",
                      "string",
                      "unknown",
                    ] as const),
                  ]),
                );
          return Object.freeze({
            dataTypes: Object.freeze(dataTypes),
            outcome: stringAt(result.outcome, `${resultPath}.outcome`),
            requiredArtifactCount,
            requiredData:
              result.requiredData === undefined
                ? Object.freeze([] as string[])
                : Object.freeze(stringListAt(result.requiredData, `${resultPath}.requiredData`)),
          });
        });
  if (kind === "deterministic" && deterministicOutcome === undefined) {
    fail(
      `${path}.outcome`,
      "deterministic step requires an outcome",
      "declare its fixed outcome",
      "missing_value",
    );
  }
  if (
    kind === "effect" &&
    (effectCapability === undefined ||
      effectTarget === undefined ||
      effectPayloadDigest === undefined)
  ) {
    fail(
      path,
      "effect step requires effectCapability, effectTarget, and effectPayloadDigest",
      "declare the deterministic effect intent data",
      "missing_value",
    );
  }
  if (
    effectPayloadDigest !== undefined &&
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(effectPayloadDigest)
  ) {
    fail(
      `${path}.effectPayloadDigest`,
      "effect payload digest is not SHA-256",
      "pin 64 lowercase hexadecimal characters, optionally prefixed with sha256:",
      "invalid_digest",
    );
  }
  if (kind === "agent" && agentProfile === undefined) {
    fail(
      `${path}.agentProfile`,
      "agent step requires an agent profile",
      "reference a declared agent profile",
      "missing_value",
    );
  }
  return Object.freeze({
    ...(agentProfile === undefined ? {} : { agentProfile }),
    capabilities: Object.freeze(stringListAt(record.capabilities, `${path}.capabilities`)),
    ...(deterministicOutcome === undefined ? {} : { deterministicOutcome }),
    ...(effectCapability === undefined ? {} : { effectCapability }),
    ...(effectPayloadDigest === undefined
      ? {}
      : { effectPayloadDigest: effectPayloadDigest.replace(/^sha256:/, "") }),
    ...(effectTarget === undefined ? {} : { effectTarget }),
    id: idAt(record.id, `${path}.id`),
    kind,
    resultContracts: Object.freeze(resultContracts),
    retry: Object.freeze({ backoffMs, maxAttempts }),
    ...(skill === undefined ? {} : { skill }),
  });
}

function parseGate(value: unknown, flowIndex: number, index: number): GateDefinition {
  const path = `$.flows[${flowIndex}].gates[${index}]`;
  const record = objectAt(value, path, [
    "id",
    "kind",
    "accepted",
    "timeoutMs",
    "timeoutOutcome",
    "requiredArtifactCount",
    "requiredArtifactSteps",
    "requiredOutcome",
  ]);
  const accepted = stringListAt(record.accepted, `${path}.accepted`);
  if (accepted.length === 0)
    fail(
      `${path}.accepted`,
      "gate accepts no inputs",
      "declare at least one accepted event, operator command, or signal",
      "invalid_gate",
    );
  const timeoutMs = optionalInteger(record.timeoutMs, `${path}.timeoutMs`);
  const timeoutOutcome = optionalString(record.timeoutOutcome, `${path}.timeoutOutcome`);
  const requiredArtifactCount =
    optionalInteger(record.requiredArtifactCount, `${path}.requiredArtifactCount`) ?? 0;
  const requiredArtifactSteps =
    record.requiredArtifactSteps === undefined
      ? []
      : stringListAt(record.requiredArtifactSteps, `${path}.requiredArtifactSteps`);
  const requiredOutcome = optionalString(record.requiredOutcome, `${path}.requiredOutcome`);
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutOutcome === undefined)) {
    fail(
      path,
      "gate timeout requires positive timeoutMs and timeoutOutcome",
      "declare both timeout fields",
      "invalid_gate",
    );
  }
  if (requiredArtifactCount < 0) {
    fail(
      `${path}.requiredArtifactCount`,
      "artifact count cannot be negative",
      "use zero or greater",
      "invalid_gate",
    );
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    id: idAt(record.id, `${path}.id`),
    kind: enumAt(record.kind, `${path}.kind`, ["approval", "event", "signal"] as const),
    requiredArtifactCount,
    requiredArtifactSteps: Object.freeze(requiredArtifactSteps),
    ...(requiredOutcome === undefined ? {} : { requiredOutcome }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(timeoutOutcome === undefined ? {} : { timeoutOutcome }),
  });
}

function parseState(value: unknown, flowIndex: number, index: number): StateDefinition {
  const path = `$.flows[${flowIndex}].states[${index}]`;
  const record = objectAt(value, path, ["id", "step", "gate", "terminal", "outcome"]);
  const step = optionalString(record.step, `${path}.step`);
  const gate = optionalString(record.gate, `${path}.gate`);
  const terminal = optionalEnum(record.terminal, `${path}.terminal`, [
    "success",
    "failure",
  ] as const);
  const terminalOutcome = optionalEnum(record.outcome, `${path}.outcome`, [
    "not_actionable",
    "needs_reproduction",
    "unable_to_reproduce",
    "unable_to_fix",
    "failed",
    "waiting",
    "completed",
    "cancelled",
  ] as const);
  const choices = [step, gate, terminal].filter((entry) => entry !== undefined).length;
  if (choices !== 1) {
    fail(
      path,
      "state must declare exactly one of step, gate, or terminal",
      "remove competing fields or add the missing state behavior",
      "invalid_state",
    );
  }
  return Object.freeze({
    ...(gate === undefined ? {} : { gate }),
    id: idAt(record.id, `${path}.id`),
    ...(step === undefined ? {} : { step }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(terminalOutcome === undefined
      ? terminal === undefined
        ? {}
        : { terminalOutcome: terminal === "success" ? ("completed" as const) : ("failed" as const) }
      : { terminalOutcome }),
  });
}

function parseTransition(value: unknown, flowIndex: number, index: number): TransitionDefinition {
  const path = `$.flows[${flowIndex}].transitions[${index}]`;
  const record = objectAt(value, path, ["from", "to", "on", "mode"]);
  return Object.freeze({
    from: idAt(record.from, `${path}.from`),
    mode:
      optionalEnum(record.mode, `${path}.mode`, ["immediate", "signal"] as const) ?? "immediate",
    on: stringAt(record.on, `${path}.on`),
    to: idAt(record.to, `${path}.to`),
  });
}

function validateDefinition(definition: FactoryDefinition): void {
  const repositories = uniqueIds(definition.repositories, "$.repositories");
  const sources = uniqueIds(definition.sources, "$.sources");
  const skills = uniqueIds(definition.skills, "$.skills");
  const profiles = uniqueIds(definition.agentProfiles, "$.agentProfiles");
  const capabilities = uniqueIds(definition.capabilities, "$.capabilities");
  const flows = uniqueIds(definition.flows, "$.flows");
  definition.capabilities.forEach((capability, index) => {
    requireCapabilityOwner(capability.id, `$.capabilities[${index}].id`);
  });
  const profileById = new Map(definition.agentProfiles.map((profile) => [profile.id, profile]));
  const githubSourceByRepository = new Map<string, number>();

  definition.sources.forEach((source, index) => {
    if (source.repository !== undefined && !repositories.has(source.repository)) {
      missingRef(`$.sources[${index}].repository`, "repository", source.repository);
    }
    if (source.type === "github" && source.repository !== undefined) {
      const previous = githubSourceByRepository.get(source.repository);
      if (previous !== undefined) {
        fail(
          `$.sources[${index}].repository`,
          `GitHub source duplicates repository identity from $.sources[${previous}]`,
          "declare at most one GitHub source per repository",
          "ambiguous_source_identity",
        );
      }
      githubSourceByRepository.set(source.repository, index);
    }
  });
  definition.agentProfiles.forEach((profile, index) => {
    profile.skills.forEach((skill, child) => {
      if (!skills.has(skill))
        missingRef(`$.agentProfiles[${index}].skills[${child}]`, "skill", skill);
    });
    profile.capabilities.forEach((capability, child) => {
      if (!capabilities.has(capability))
        missingRef(`$.agentProfiles[${index}].capabilities[${child}]`, "capability", capability);
      const owner = requireCapabilityOwner(
        capability,
        `$.agentProfiles[${index}].capabilities[${child}]`,
      );
      if (owner !== "execution" && owner !== "agent-runtime") {
        fail(
          `$.agentProfiles[${index}].capabilities[${child}]`,
          `capability ${JSON.stringify(capability)} is owned by ${JSON.stringify(owner)} and cannot be granted to an agent`,
          "grant only execution-owned or agent-runtime capabilities to agent profiles",
          "invalid_capability_owner",
        );
      }
    });
  });
  const permittedCapabilities = new Set<string>();
  definition.effectPermissions.forEach((permission, index) => {
    if (!capabilities.has(permission.capability)) {
      missingRef(`$.effectPermissions[${index}].capability`, "capability", permission.capability);
    }
    const owner = requireCapabilityOwner(
      permission.capability,
      `$.effectPermissions[${index}].capability`,
    );
    if (owner !== "effects" && owner !== "git-publisher") {
      fail(
        `$.effectPermissions[${index}].capability`,
        `capability ${JSON.stringify(permission.capability)} is owned by ${JSON.stringify(owner)} and cannot be used as an effect`,
        "declare effect permissions only for effects or trusted publisher capabilities",
        "invalid_capability_owner",
      );
    }
    permission.targets.forEach((target, child) => {
      if (!repositories.has(target)) {
        missingRef(`$.effectPermissions[${index}].targets[${child}]`, "repository", target);
      }
    });
    permission.flows?.forEach((flow, child) => {
      if (!flows.has(flow))
        missingRef(`$.effectPermissions[${index}].flows[${child}]`, "flow", flow);
    });
    permission.agentProfiles?.forEach((profile, child) => {
      if (!profiles.has(profile))
        missingRef(
          `$.effectPermissions[${index}].agentProfiles[${child}]`,
          "agent profile",
          profile,
        );
    });
    permission.effects?.forEach((effect, child) => {
      if (EFFECT_KIND_NAMES[effect] !== true)
        fail(
          `$.effectPermissions[${index}].effects[${child}]`,
          `unknown effect kind ${JSON.stringify(effect)}`,
          "use a supported strict effect kind",
          "invalid_effect_kind",
        );
    });
    permittedCapabilities.add(permission.capability);
  });
  definition.flows.forEach((flow, flowIndex) => {
    const path = `$.flows[${flowIndex}]`;
    const states = uniqueIds(flow.states, `${path}.states`);
    const steps = uniqueIds(flow.steps, `${path}.steps`);
    const gates = uniqueIds(flow.gates, `${path}.gates`);
    if (
      !["repository", "subject", "flow", "agent-profile", "repository-and-subject"].includes(
        flow.concurrency.key,
      )
    ) {
      fail(
        `${path}.concurrency.key`,
        `unsupported concurrency scope ${JSON.stringify(flow.concurrency.key)}`,
        "use repository, subject, flow, agent-profile, or repository-and-subject",
        "invalid_concurrency_scope",
      );
    }
    if (flow.concurrency.key === "agent-profile") {
      const flowProfiles = new Set(
        flow.steps.flatMap((step) => (step.agentProfile === undefined ? [] : [step.agentProfile])),
      );
      if (flowProfiles.size > 1) {
        fail(
          `${path}.concurrency.key`,
          "agent-profile concurrency is a run-level policy and the flow uses multiple profiles",
          "use one agent profile or select another concurrency scope",
          "ambiguous_agent_profile_scope",
        );
      }
    }
    if (!states.has(flow.initialState))
      missingRef(`${path}.initialState`, "state", flow.initialState);
    flow.triggers.forEach((trigger, index) => {
      if (!sources.has(trigger.source))
        missingRef(`${path}.triggers[${index}].source`, "source", trigger.source);
    });
    flow.artifactHandoffs.forEach((edge, index) => {
      if (!steps.has(edge.fromStep)) {
        missingRef(`${path}.artifactHandoffs[${index}].fromStep`, "step", edge.fromStep);
      }
      if (!steps.has(edge.toStep)) {
        missingRef(`${path}.artifactHandoffs[${index}].toStep`, "step", edge.toStep);
      }
      if (edge.fromStep === edge.toStep) {
        fail(
          `${path}.artifactHandoffs[${index}]`,
          "artifact handoff cannot target its source step",
          "declare a downstream consumer step",
          "invalid_artifact_handoff",
        );
      }
    });
    flow.steps.forEach((step, index) => {
      if (step.agentProfile !== undefined && !profiles.has(step.agentProfile)) {
        missingRef(`${path}.steps[${index}].agentProfile`, "agent profile", step.agentProfile);
      }
      if (step.skill !== undefined && !skills.has(step.skill)) {
        missingRef(`${path}.steps[${index}].skill`, "skill", step.skill);
      }
      const profile =
        step.agentProfile === undefined ? undefined : profileById.get(step.agentProfile);
      const resultOutcomes = uniqueIds(
        step.resultContracts.map((contract) => ({ id: contract.outcome })),
        `${path}.steps[${index}].results`,
      );
      if (step.kind !== "deterministic" && resultOutcomes.size === 0) {
        fail(
          `${path}.steps[${index}].results`,
          `${step.kind} step has no declared result contracts`,
          "declare every accepted result outcome and its required data fields",
          "missing_result_contract",
        );
      }
      if (
        step.kind === "deterministic" &&
        step.deterministicOutcome !== undefined &&
        step.resultContracts.length > 0
      ) {
        fail(
          `${path}.steps[${index}].results`,
          "deterministic steps cannot accept external results",
          "remove results and keep the fixed outcome",
          "invalid_result_contract",
        );
      }
      if (
        step.kind === "effect" &&
        (step.effectCapability === undefined || !step.capabilities.includes(step.effectCapability))
      ) {
        fail(
          `${path}.steps[${index}].effectCapability`,
          "effect capability must be listed in step capabilities",
          "add the declared effect capability to capabilities",
          "undeclared_capability",
        );
      }
      if (step.kind === "effect" && step.effectCapability !== undefined) {
        const permission = definition.effectPermissions.find(
          (entry) => entry.capability === step.effectCapability,
        );
        if (
          permission === undefined ||
          step.effectTarget === undefined ||
          !permission.targets.includes(step.effectTarget)
        ) {
          fail(
            `${path}.steps[${index}].effectTarget`,
            "effect target is not allowed by the matching permission",
            "use a declared permission target",
            "undeclared_permission",
          );
        }
      }
      if (
        step.skill !== undefined &&
        profile !== undefined &&
        !profile.skills.includes(step.skill)
      ) {
        fail(
          `${path}.steps[${index}].skill`,
          `skill ${JSON.stringify(step.skill)} is not allowed by agent profile ${JSON.stringify(profile.id)}`,
          "add the skill to the agent profile or select an allowed skill",
          "undeclared_skill",
        );
      }
      step.capabilities.forEach((capability, child) => {
        if (!capabilities.has(capability))
          missingRef(`${path}.steps[${index}].capabilities[${child}]`, "capability", capability);
        const owner = requireCapabilityOwner(
          capability,
          `${path}.steps[${index}].capabilities[${child}]`,
        );
        const allowedForKind =
          step.kind === "deterministic"
            ? false
            : step.kind === "agent"
              ? owner === "execution" || owner === "agent-runtime"
              : owner === "effects" || owner === "git-publisher";
        if (!allowedForKind) {
          fail(
            `${path}.steps[${index}].capabilities[${child}]`,
            `capability ${JSON.stringify(capability)} is owned by ${JSON.stringify(owner)} and cannot be used by a ${step.kind} step`,
            `use a capability owned by the ${step.kind} execution boundary`,
            "invalid_capability_owner",
          );
        }
        if (
          step.kind === "agent" &&
          profile !== undefined &&
          !profile.capabilities.includes(capability)
        ) {
          fail(
            `${path}.steps[${index}].capabilities[${child}]`,
            `capability ${JSON.stringify(capability)} is not allowed by agent profile ${JSON.stringify(profile.id)}`,
            "add the capability to the agent profile or remove it from the step",
            "undeclared_capability",
          );
        }
        if (step.kind === "effect" && !permittedCapabilities.has(capability)) {
          fail(
            `${path}.steps[${index}].capabilities[${child}]`,
            `effect capability ${JSON.stringify(capability)} has no permission`,
            "declare a matching effectPermissions entry with allowed targets",
            "undeclared_permission",
          );
        }
      });
      if (step.kind === "deterministic" && step.capabilities.length > 0) {
        fail(
          `${path}.steps[${index}].capabilities`,
          "deterministic steps cannot invoke capabilities",
          "use an empty capability list",
          "invalid_deterministic_step",
        );
      }
    });
    flow.states.forEach((state, index) => {
      if (state.step !== undefined && !steps.has(state.step))
        missingRef(`${path}.states[${index}].step`, "step", state.step);
      if (state.gate !== undefined && !gates.has(state.gate))
        missingRef(`${path}.states[${index}].gate`, "gate", state.gate);
      if (
        state.terminal !== undefined &&
        flow.transitions.some((transition) => transition.from === state.id)
      ) {
        fail(
          `${path}.states[${index}].terminal`,
          "terminal state has outgoing transitions",
          "remove the outgoing transition or terminal marker",
          "invalid_terminal",
        );
      }
    });
    if (!flow.states.some((state) => state.terminal !== undefined)) {
      fail(
        `${path}.states`,
        "flow has no terminal state",
        "add a state with terminal: success or terminal: failure",
        "invalid_terminal",
      );
    }
    const transitionKeys = new Map<string, number>();
    flow.transitions.forEach((transition, index) => {
      if (!states.has(transition.from))
        missingRef(`${path}.transitions[${index}].from`, "state", transition.from);
      if (!states.has(transition.to))
        missingRef(`${path}.transitions[${index}].to`, "state", transition.to);
      const fromState = flow.states.find((state) => state.id === transition.from);
      if (transition.mode === "signal" && fromState?.gate === undefined) {
        fail(
          `${path}.transitions[${index}].mode`,
          "signal transition originates from a state without a gate",
          "use immediate mode for step outcomes or add an explicit gate state",
          "invalid_signal_transition",
        );
      }
      if (fromState?.gate !== undefined) {
        if (transition.mode !== "signal") {
          fail(
            `${path}.transitions[${index}].mode`,
            "gate transition must declare signal mode",
            "set mode: signal on every transition from a gate-backed state",
            "invalid_gate_transition_mode",
          );
        }
        const gate = flow.gates.find((entry) => entry.id === fromState.gate);
        if (gate !== undefined && !gate.accepted.includes(transition.on)) {
          fail(
            `${path}.transitions[${index}].on`,
            `gate ${JSON.stringify(gate.id)} does not accept ${JSON.stringify(transition.on)}`,
            "add the input kind to the gate accepted list or use a declared kind",
            "invalid_gate_transition",
          );
        }
      }
      if (fromState?.step !== undefined) {
        const step = flow.steps.find((entry) => entry.id === fromState.step);
        const declared =
          step?.kind === "deterministic"
            ? step.deterministicOutcome === transition.on
            : step?.resultContracts.some((contract) => contract.outcome === transition.on);
        if (!declared) {
          fail(
            `${path}.transitions[${index}].on`,
            `outcome ${JSON.stringify(transition.on)} is not declared by step ${JSON.stringify(fromState.step)}`,
            "add a matching result contract or use a declared outcome",
            "invalid_result_reference",
          );
        }
      }
      const key = `${transition.from}\0${transition.on}`;
      const previous = transitionKeys.get(key);
      if (previous !== undefined) {
        fail(
          `${path}.transitions[${index}].on`,
          `ambiguous transition duplicates ${path}.transitions[${previous}] for state ${JSON.stringify(transition.from)} and outcome ${JSON.stringify(transition.on)}`,
          "combine the branches or give each transition a distinct outcome",
          "ambiguous_transition",
        );
      }
      transitionKeys.set(key, index);
    });
    flow.states.forEach((state, index) => {
      if (
        state.terminal === undefined &&
        !flow.transitions.some((transition) => transition.from === state.id)
      ) {
        fail(
          `${path}.states[${index}].id`,
          `nonterminal state ${JSON.stringify(state.id)} has no outgoing transition`,
          "add an outgoing transition or mark the state terminal",
          "dead_end_state",
        );
      }
    });
    flow.states.forEach((state) => {
      if (state.gate === undefined) return;
      const gateIndex = flow.gates.findIndex((gate) => gate.id === state.gate);
      const gate = flow.gates[gateIndex];
      if (gate === undefined) return;
      gate.requiredArtifactSteps.forEach((stepId, artifactIndex) => {
        if (!steps.has(stepId)) {
          missingRef(
            `${path}.gates[${gateIndex}].requiredArtifactSteps[${artifactIndex}]`,
            "step",
            stepId,
          );
        }
      });
      gate.accepted.forEach((accepted, acceptedIndex) => {
        if (
          !flow.transitions.some(
            (transition) => transition.from === state.id && transition.on === accepted,
          )
        ) {
          fail(
            `${path}.gates[${gateIndex}].accepted[${acceptedIndex}]`,
            `accepted gate input ${JSON.stringify(accepted)} has no transition from state ${JSON.stringify(state.id)}`,
            "add exactly one transition for every accepted gate input",
            "incomplete_gate",
          );
        }
      });
      if (
        gate.timeoutOutcome !== undefined &&
        !flow.transitions.some(
          (transition) => transition.from === state.id && transition.on === gate.timeoutOutcome,
        )
      ) {
        fail(
          `${path}.gates[${gateIndex}].timeoutOutcome`,
          `timeout outcome ${JSON.stringify(gate.timeoutOutcome)} has no transition`,
          "add exactly one transition for the timeout outcome",
          "invalid_gate_transition",
        );
      }
    });
    validateReachability(flow, flowIndex);
    validateSynchronousCycles(flow, flowIndex);
  });
}

function validateReachability(flow: FlowDefinition, flowIndex: number): void {
  const reachable = new Set([flow.initialState]);
  const queue = [flow.initialState];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const transition of flow.transitions) {
      if (transition.from === current && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        queue.push(transition.to);
      }
    }
  }
  flow.states.forEach((state, index) => {
    if (!reachable.has(state.id)) {
      fail(
        `$.flows[${flowIndex}].states[${index}].id`,
        `state ${JSON.stringify(state.id)} is unreachable from ${JSON.stringify(flow.initialState)}`,
        "add a transition from a reachable state or remove the state",
        "unreachable_state",
      );
    }
  });
}

function validateSynchronousCycles(flow: FlowDefinition, flowIndex: number): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (state: string): void => {
    if (visiting.has(state)) {
      const stateIndex = flow.states.findIndex((entry) => entry.id === state);
      fail(
        `$.flows[${flowIndex}].states[${stateIndex}].id`,
        `synchronous transition cycle includes ${JSON.stringify(state)}`,
        "insert a signal or gate boundary, or remove the cycle",
        "synchronous_cycle",
      );
    }
    if (visited.has(state)) return;
    visiting.add(state);
    for (const transition of flow.transitions) {
      if (transition.from === state && transition.mode === "immediate") visit(transition.to);
    }
    visiting.delete(state);
    visited.add(state);
  };
  for (const state of flow.states) visit(state.id);
}

function moduleCallsFor(flow: FlowDefinition): string[] {
  const calls = new Set(["definitions.compileDefinition", "definitions.getExecutionPlan"]);
  if (flow.triggers.length > 0) calls.add("intake.acceptSourceEvent");
  if (flow.steps.some((step) => step.kind === "agent")) calls.add("execution.requestAttempt");
  if (flow.steps.some((step) => step.kind === "effect")) calls.add("effects.requestEffect");
  if (flow.steps.some((step) => step.skill !== undefined)) calls.add("assets.resolveSkill");
  calls.add("runs.startRun");
  return [...calls].sort();
}

function moduleEventsFor(flow: FlowDefinition): string[] {
  const events = new Set([
    "DefinitionPublished.v1",
    "FactoryEventAccepted.v1",
    "RunFinished.v1",
    "RunStateChanged.v1",
  ]);
  if (flow.steps.some((step) => step.kind === "agent")) {
    events.add("ArtifactStored.v1");
    events.add("AttemptFinished.v1");
    events.add("StepRequested.v1");
  }
  if (flow.steps.some((step) => step.kind === "effect")) {
    events.add("EffectFinished.v1");
    events.add("EffectRequested.v1");
  }
  if (flow.steps.some((step) => step.skill !== undefined)) events.add("SkillRevisionPinned.v1");
  return [...events].sort();
}

function moduleCallsForV2(flow: FlowDefinition): string[] {
  const calls = new Set([
    "definitions.getActiveDefinition",
    "definitions.getExecutionPlanV2",
    "runs.applyOperatorCommandV2",
    "runs.driveRun",
    "runs.signalRun",
    "runs.startRunV3",
  ]);
  if (flow.triggers.length > 0) calls.add("intake.acceptSourceEventV2");
  if (flow.steps.some((step) => step.kind === "agent")) calls.add("execution.requestAttemptV3");
  if (flow.steps.some((step) => step.kind === "effect")) calls.add("effects.requestEffectV2");
  if (flow.steps.some((step) => step.skill !== undefined)) calls.add("assets.resolveSkillV2");
  return [...calls].sort();
}

function moduleEventsForV2(flow: FlowDefinition): string[] {
  const events = new Set([
    "DefinitionPublished.v1",
    "FactoryEventAccepted.v2",
    "RunFinished.v1",
    "RunFinished.v2",
    "RunFinished.v3",
    "RunStateChanged.v1",
    "RunStateChanged.v2",
    "RunStateChanged.v3",
  ]);
  if (flow.steps.some((step) => step.kind === "agent")) {
    events.add("ArtifactStored.v2");
    events.add("AttemptFinished.v1");
    events.add("StepRequested.v1");
    events.add("StepRequested.v2");
  }
  if (flow.steps.some((step) => step.kind === "effect")) {
    events.add("EffectFinished.v2");
    events.add("EffectRequested.v1");
    events.add("EffectRequested.v2");
  }
  if (flow.steps.some((step) => step.skill !== undefined)) events.add("SkillRevisionPinned.v2");
  return [...events].sort();
}

function uniqueIds(entries: readonly { readonly id: string }[], path: string): Set<string> {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      fail(
        `${path}[${index}].id`,
        `duplicate id ${JSON.stringify(entry.id)}`,
        "choose an id unique within this list",
        "duplicate_id",
      );
    }
    ids.add(entry.id);
  });
  return ids;
}

function requireCapabilityOwner(capability: string, path: string): string {
  const owner = CAPABILITY_OWNERS[capability as keyof typeof CAPABILITY_OWNERS];
  if (owner === undefined) {
    fail(
      path,
      `capability ${JSON.stringify(capability)} has no declared owner`,
      "use a capability from the ownership inventory or add its explicit trusted owner",
      "undeclared_capability_owner",
    );
  }
  return owner;
}

function missingRef(path: string, kind: string, reference: string): never {
  fail(
    path,
    `unknown ${kind} reference ${JSON.stringify(reference)}`,
    `declare ${JSON.stringify(reference)} or update the reference`,
    "missing_reference",
  );
}

function objectAt(value: unknown, path: string, allowedKeys: readonly string[]): DataRecord {
  if (!isDataRecord(value))
    fail(path, "expected an object", "replace this value with a YAML mapping", "invalid_type");
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      fail(
        `${path}.${key}`,
        `unknown key ${JSON.stringify(key)}`,
        `remove it; allowed keys are: ${allowedKeys.join(", ")}`,
        "unknown_key",
      );
    }
  }
  return value;
}

function listAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value))
    fail(path, "expected a list", "replace this value with a YAML sequence", "invalid_type");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(path, "expected a non-empty string", "set a non-empty string value", "invalid_type");
  return value;
}

function idAt(value: unknown, path: string): string {
  const id = stringAt(value, path);
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    fail(
      path,
      `invalid id ${JSON.stringify(id)}`,
      "use lowercase letters, digits, dots, underscores, or hyphens, starting with a letter",
      "invalid_id",
    );
  }
  return id;
}

function integerAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail(path, "expected a safe integer", "set an integer value", "invalid_type");
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    fail(path, "expected a boolean", "set true or false", "invalid_type");
  return value;
}

function stringListAt(value: unknown, path: string): string[] {
  return listAt(value, path).map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : stringAt(value, path);
}

function optionalInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : integerAt(value, path);
}

function enumAt<const T extends readonly [string, ...string[]]>(
  value: unknown,
  path: string,
  choices: T,
): T[number] {
  const entry = stringAt(value, path);
  if (!choices.includes(entry as T[number]))
    fail(
      path,
      `expected one of: ${choices.join(", ")}`,
      `set the value to one of: ${choices.join(", ")}`,
      "invalid_value",
    );
  return entry as T[number];
}

function optionalEnum<const T extends readonly [string, ...string[]]>(
  value: unknown,
  path: string,
  choices: T,
): T[number] | undefined {
  return value === undefined ? undefined : enumAt(value, path, choices);
}

function fail(path: string, message: string, remediation: string, code: string): never {
  throw new DefinitionCompileError([Object.freeze({ code, message, path, remediation })]);
}

function formatDiagnostic(diagnostic: DefinitionDiagnostic): string {
  return `${diagnostic.path}: ${diagnostic.message}. Remediation: ${diagnostic.remediation}`;
}
