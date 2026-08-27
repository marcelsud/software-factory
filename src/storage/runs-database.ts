export interface RunRow {
  agent_profile_digests_json: string;
  audit_sequence: number;
  current_attempt_id: string | null;
  current_correlation_token: string | null;
  current_effect_key: string | null;
  current_gate_id: string | null;
  current_gate_status: string | null;
  current_step_id: string | null;
  definition_digest: string;
  factory_event_id: string;
  finished_at: string | null;
  flow_digest: string;
  flow_id: string;
  module_manifest_digest: string;
  run_id: string;
  skill_digests_json: string;
  started_at: string;
  state_id: string;
  status: string;
  workflow_id: string;
  workflow_version: number;
  workflow_version_digest: string;
}
export const RUN_COLUMNS = [
  "agent_profile_digests_json",
  "audit_sequence",
  "current_attempt_id",
  "current_correlation_token",
  "current_effect_key",
  "current_gate_id",
  "current_gate_status",
  "current_step_id",
  "definition_digest",
  "factory_event_id",
  "finished_at",
  "flow_digest",
  "flow_id",
  "module_manifest_digest",
  "run_id",
  "skill_digests_json",
  "started_at",
  "state_id",
  "status",
  "workflow_id",
  "workflow_version",
  "workflow_version_digest",
] as const satisfies readonly (keyof RunRow)[];

export interface RunGateRow {
  accepted_json: string;
  correlation_token: string;
  gate_id: string;
  kind: string;
  run_id: string;
  satisfied_at: string | null;
  satisfied_by: string | null;
  status: string;
}

export interface OperatorCommandRow {
  command_id: string;
  command_json: string;
  issued_at: string;
  kind: string;
  run_id: string;
}

export interface RunAuditRow {
  audit_json: string;
  kind: string;
  occurred_at: string;
  run_id: string;
  sequence: number;
}
export interface RunIdentityRow {
  initial_correlation_json: string;
  run_id: string;
}

export interface WorkflowSignalRow {
  correlation_token: string;
  identity: string;
  payload_json: string;
  recorded_at: string;
  run_id: string;
  signal_kind: string;
}

export interface RunsDatabase {
  operator_commands: OperatorCommandRow;
  run_identities: RunIdentityRow;
  run_audit: RunAuditRow;
  run_gates: RunGateRow;
  runs: RunRow;
  workflow_signals: WorkflowSignalRow;
}

export const runsMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          factory_event_id TEXT NOT NULL UNIQUE,
          workflow_id TEXT NOT NULL UNIQUE,
          workflow_version INTEGER NOT NULL,
          workflow_version_digest TEXT NOT NULL,
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          agent_profile_digests_json TEXT NOT NULL,
          skill_digests_json TEXT NOT NULL,
          module_manifest_digest TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          state_id TEXT NOT NULL,
          status TEXT NOT NULL,
          audit_sequence INTEGER NOT NULL,
          current_step_id TEXT,
          current_attempt_id TEXT,
          current_effect_key TEXT,
          current_gate_id TEXT,
          current_gate_status TEXT,
          current_correlation_token TEXT
        );
      `,
    },
    {
      name: "002_audit_and_gates",
      sql: `
        CREATE TABLE IF NOT EXISTS run_identities (
          run_id TEXT PRIMARY KEY,
          initial_correlation_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
        CREATE TABLE IF NOT EXISTS run_gates (
          run_id TEXT NOT NULL,
          gate_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          accepted_json TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          status TEXT NOT NULL,
          satisfied_at TEXT,
          satisfied_by TEXT,
          PRIMARY KEY (run_id, gate_id, correlation_token),
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
        CREATE TABLE IF NOT EXISTS operator_commands (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          command_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
        CREATE TABLE IF NOT EXISTS run_audit (
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          audit_json TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence),
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
        CREATE TABLE IF NOT EXISTS workflow_signals (
          identity TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          signal_kind TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_runs.runs (
          run_id TEXT PRIMARY KEY,
          factory_event_id TEXT NOT NULL UNIQUE,
          workflow_id TEXT NOT NULL UNIQUE,
          workflow_version INTEGER NOT NULL,
          workflow_version_digest TEXT NOT NULL,
          definition_digest TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          flow_digest TEXT NOT NULL,
          agent_profile_digests_json TEXT NOT NULL,
          skill_digests_json TEXT NOT NULL,
          module_manifest_digest TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          state_id TEXT NOT NULL,
          status TEXT NOT NULL,
          audit_sequence INTEGER NOT NULL,
          current_step_id TEXT,
          current_attempt_id TEXT,
          current_effect_key TEXT,
          current_gate_id TEXT,
          current_gate_status TEXT,
          current_correlation_token TEXT
        );
      `,
    },
    {
      name: "002_audit_and_gates",
      sql: `
        ALTER TABLE chimpbase_runs.runs
          ADD COLUMN IF NOT EXISTS current_step_id TEXT;
        ALTER TABLE chimpbase_runs.runs
          DROP COLUMN IF EXISTS initial_correlation_json;
        CREATE TABLE IF NOT EXISTS chimpbase_runs.run_identities (
          run_id TEXT PRIMARY KEY REFERENCES chimpbase_runs.runs(run_id),
          initial_correlation_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_runs.run_gates (
          run_id TEXT NOT NULL REFERENCES chimpbase_runs.runs(run_id),
          gate_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          accepted_json TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          status TEXT NOT NULL,
          satisfied_at TEXT,
          satisfied_by TEXT,
          PRIMARY KEY (run_id, gate_id, correlation_token)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_runs.operator_commands (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES chimpbase_runs.runs(run_id),
          kind TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          command_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_runs.run_audit (
          run_id TEXT NOT NULL REFERENCES chimpbase_runs.runs(run_id),
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          audit_json TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_runs.workflow_signals (
          identity TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES chimpbase_runs.runs(run_id),
          signal_kind TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `,
    },
  ],
} as const;
