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

export const RESOURCE_OWNERS = {
  artifacts: "assets",
  attempts: "execution",
  "definition-revisions": "definitions",
  "effect-receipts": "effects",
  "event-delivery": "chimpbase",
  "operations-projections": "operations",
  runs: "runs",
  "source-events": "intake",
  workflows: "chimpbase",
} as const;

export type ModuleName = keyof typeof MODULE_DEPENDENCIES;
