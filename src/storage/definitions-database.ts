export interface DefinitionRevisionRow {
  definition_digest: string;
  normalized_json: string;
  source_name: string;
}

export interface ExecutionPlanRow {
  definition_digest: string;
  flow_digest: string;
  flow_id: string;
  plan_json: string;
}

export interface ExecutionPlanV2Row extends ExecutionPlanRow {}
export interface ExecutionPlanV3Row extends ExecutionPlanRow {}

export interface ActiveDefinitionRow {
  definition_digest: string;
  singleton: number;
}

export interface AgentProfileRevisionRow {
  digest: string;
  profile_json: string;
}

export interface FlowRevisionRow {
  definition_digest: string;
  flow_digest: string;
  flow_id: string;
  normalized_json: string;
}

export interface DefinitionsDatabase {
  active_definition: ActiveDefinitionRow;
  agent_profile_revisions: AgentProfileRevisionRow;
  definition_revisions: DefinitionRevisionRow;
  execution_plans: ExecutionPlanRow;
  execution_plans_v2: ExecutionPlanV2Row;
  execution_plans_v3: ExecutionPlanV3Row;
  flow_revisions: FlowRevisionRow;
}

export const definitionsMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS definition_revisions (
          definition_digest TEXT PRIMARY KEY,
          normalized_json TEXT NOT NULL,
          source_name TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_compiled_metadata",
      sql: `
        CREATE TABLE IF NOT EXISTS execution_plans (
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id),
          FOREIGN KEY (definition_digest) REFERENCES definition_revisions(definition_digest)
        );
        CREATE TABLE IF NOT EXISTS agent_profile_revisions (
          digest TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flow_revisions (
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          normalized_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id),
          FOREIGN KEY (definition_digest) REFERENCES definition_revisions(definition_digest)
        );
      `,
    },
    {
      name: "003_active_v2_plans",
      sql: `
        CREATE TABLE IF NOT EXISTS execution_plans_v2 (
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id),
          FOREIGN KEY (definition_digest) REFERENCES definition_revisions(definition_digest)
        );
        CREATE TABLE IF NOT EXISTS active_definition (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          definition_digest TEXT NOT NULL,
          FOREIGN KEY (definition_digest) REFERENCES definition_revisions(definition_digest)
        );
      `,
    },
    {
      name: "004_v3_plans",
      sql: `
        CREATE TABLE IF NOT EXISTS execution_plans_v3 (
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id),
          FOREIGN KEY (definition_digest) REFERENCES definition_revisions(definition_digest)
        );
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.definition_revisions (
          definition_digest TEXT PRIMARY KEY,
          normalized_json TEXT NOT NULL,
          source_name TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_compiled_metadata",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.execution_plans (
          definition_digest TEXT NOT NULL REFERENCES chimpbase_definitions.definition_revisions(definition_digest),
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.agent_profile_revisions (
          digest TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.flow_revisions (
          definition_digest TEXT NOT NULL REFERENCES chimpbase_definitions.definition_revisions(definition_digest),
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          normalized_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id)
        );
      `,
    },
    {
      name: "003_active_v2_plans",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.execution_plans_v2 (
          definition_digest TEXT NOT NULL REFERENCES chimpbase_definitions.definition_revisions(definition_digest),
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.active_definition (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          definition_digest TEXT NOT NULL REFERENCES chimpbase_definitions.definition_revisions(definition_digest)
        );
      `,
    },
    {
      name: "004_v3_plans",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_definitions.execution_plans_v3 (
          definition_digest TEXT NOT NULL REFERENCES chimpbase_definitions.definition_revisions(definition_digest),
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY (definition_digest, flow_id)
        );
      `,
    },
  ],
} as const;
