export const CAPABILITY_OWNERS = {
  "agent.execute": "agent-runtime",
  "artifact.bytes": "artifact-byte-driver",
  "definition.compile": "definitions",
  "git.publish": "git-publisher",
  "github.transport": "github-transport",
  "issue.comment": "effects",
  "repository.read": "execution",
  "repository.write": "effects",
  "run.coordinate": "runs",
  "source.accept": "intake",
} as const;

export const MODULE_DEPENDENCIES = {
  assets: [],
  definitions: [],
  effects: ["assets", "definitions"],
  execution: ["assets"],
  intake: ["definitions"],
  operations: ["assets", "definitions", "effects", "execution", "intake", "runs"],
  runs: ["assets", "definitions", "effects", "execution"],
} as const;

export type ModuleName = keyof typeof MODULE_DEPENDENCIES;

export const MODULE_RESOURCES = {
  assets: {
    collections: ["artifacts", "skill-revisions"],
    kvPrefixes: ["artifact-bytes", "artifact-materializations"],
  },
  definitions: {
    collections: [
      "agent-profile-revisions",
      "definition-revisions",
      "execution-plans",
      "flow-revisions",
    ],
  },
  effects: {
    collections: ["effect-intents", "effect-receipts", "effect-reconciliation"],
    queues: ["effect-workers"],
  },
  execution: {
    collections: ["step-attempts", "workspaces"],
    queues: ["agent-workers"],
  },
  intake: {
    collections: [
      "delivery-deduplication",
      "event-sources",
      "factory-events",
      "source-cursors",
      "source-payload-snapshots",
    ],
  },
  operations: {
    projections: ["effect-projections", "event-projections", "run-projections"],
  },
  runs: {
    collections: ["operator-commands", "run-gates", "runs", "workflow-signals"],
    workflows: ["factory-runs"],
  },
} as const;

export const RESOURCE_OWNERS = {
  "agent-profile-revisions": "definitions",
  "agent-workers": "execution",
  "artifact-bytes": "assets",
  "artifact-materializations": "assets",
  artifacts: "assets",
  "definition-revisions": "definitions",
  "delivery-deduplication": "intake",
  "effect-intents": "effects",
  "effect-projections": "operations",
  "effect-receipts": "effects",
  "effect-reconciliation": "effects",
  "effect-workers": "effects",
  "event-delivery": "chimpbase",
  "event:ArtifactStored.v1": "assets",
  "event:AttemptFinished.v1": "execution",
  "event:DefinitionPublished.v1": "definitions",
  "event:EffectFinished.v1": "effects",
  "event:EffectRequested.v1": "runs",
  "event:FactoryEventAccepted.v1": "intake",
  "event:RunFinished.v1": "runs",
  "event:RunStateChanged.v1": "runs",
  "event:SkillRevisionPinned.v1": "assets",
  "event:StepRequested.v1": "runs",
  "event-projections": "operations",
  "event-sources": "intake",
  "execution-plans": "definitions",
  "factory-events": "intake",
  "factory-runs": "runs",
  "flow-revisions": "definitions",
  "health-routes": "operations",
  "module-manifest": "chimpbase",
  namespaces: "chimpbase",
  "operator-commands": "runs",
  "operator-routes": "operations",
  "repository-poll-crons": "intake",
  "run-gates": "runs",
  "run-projections": "operations",
  runs: "runs",
  "skill-revisions": "assets",
  "source-cursors": "intake",
  "source-payload-snapshots": "intake",
  "step-attempts": "execution",
  telemetry: "chimpbase",
  "workflow-engine": "chimpbase",
  "workflow-signals": "runs",
  workspaces: "execution",
} as const;
