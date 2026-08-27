export interface StepAttemptRow {
  agent_profile_digest: string;
  attempt_id: string;
  correlation_token: string;
  finished_at: string | null;
  input_artifact_digests_json: string;
  outcome: string;
  run_id: string;
  skill_digests_json: string;
  started_at: string;
  step_id: string;
}

export interface WorkspaceRow {
  attempt_id: string;
  created_at: string;
  status: string;
  workspace_id: string;
}

export interface AttemptResultRow {
  attempt_id: string;
  finished_at: string;
  result_json: string;
}

export interface AttemptRequestRow {
  attempt_id: string;
  protocol_version: number;
  request_digest: string;
  request_json: string;
}

export interface WorkspaceLifecycleRow {
  attempt_id: string;
  cleaned_at: string | null;
  debug_retained: number;
  finished_at: string | null;
  path: string | null;
  ready_at: string | null;
}

export interface AttemptResultMetadataRow {
  attempt_id: string;
  changed_files_json: string;
  commit_json: string | null;
  failure_category: string | null;
  logs_json: string;
  patch_json: string | null;
  resources_json: string;
  tests_json: string;
  timing_json: string;
}

export interface ExecutionDatabase {
  attempt_requests: AttemptRequestRow;
  attempt_result_metadata: AttemptResultMetadataRow;
  attempt_results: AttemptResultRow;
  step_attempts: StepAttemptRow;
  workspace_lifecycle: WorkspaceLifecycleRow;
  workspaces: WorkspaceRow;
}

export const executionMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS step_attempts (
          attempt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          agent_profile_digest TEXT NOT NULL,
          skill_digests_json TEXT NOT NULL,
          input_artifact_digests_json TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_workspace_results",
      sql: `
        CREATE TABLE IF NOT EXISTS workspaces (
          workspace_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES step_attempts(attempt_id)
        );
        CREATE TABLE IF NOT EXISTS attempt_results (
          attempt_id TEXT PRIMARY KEY,
          finished_at TEXT NOT NULL,
          result_json TEXT NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES step_attempts(attempt_id)
        );
      `,
    },
    {
      name: "003_strict_execution_protocol",
      sql: `
        CREATE TABLE IF NOT EXISTS attempt_requests (
          attempt_id TEXT PRIMARY KEY,
          protocol_version INTEGER NOT NULL,
          request_digest TEXT NOT NULL,
          request_json TEXT NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES step_attempts(attempt_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_lifecycle (
          attempt_id TEXT PRIMARY KEY,
          path TEXT,
          ready_at TEXT,
          finished_at TEXT,
          cleaned_at TEXT,
          debug_retained INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (attempt_id) REFERENCES step_attempts(attempt_id)
        );
        CREATE TABLE IF NOT EXISTS attempt_result_metadata (
          attempt_id TEXT PRIMARY KEY,
          failure_category TEXT,
          logs_json TEXT NOT NULL,
          patch_json TEXT,
          commit_json TEXT,
          changed_files_json TEXT NOT NULL,
          tests_json TEXT NOT NULL,
          timing_json TEXT NOT NULL,
          resources_json TEXT NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES step_attempts(attempt_id)
        );
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_execution.step_attempts (
          attempt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          agent_profile_digest TEXT NOT NULL,
          skill_digests_json TEXT NOT NULL,
          input_artifact_digests_json TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_workspace_results",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_execution.workspaces (
          workspace_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE REFERENCES chimpbase_execution.step_attempts(attempt_id),
          created_at TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_execution.attempt_results (
          attempt_id TEXT PRIMARY KEY REFERENCES chimpbase_execution.step_attempts(attempt_id),
          finished_at TEXT NOT NULL,
          result_json TEXT NOT NULL
        );
      `,
    },
    {
      name: "003_strict_execution_protocol",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_execution.attempt_requests (
          attempt_id TEXT PRIMARY KEY REFERENCES chimpbase_execution.step_attempts(attempt_id),
          protocol_version INTEGER NOT NULL,
          request_digest TEXT NOT NULL,
          request_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_execution.workspace_lifecycle (
          attempt_id TEXT PRIMARY KEY REFERENCES chimpbase_execution.step_attempts(attempt_id),
          path TEXT,
          ready_at TEXT,
          finished_at TEXT,
          cleaned_at TEXT,
          debug_retained INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chimpbase_execution.attempt_result_metadata (
          attempt_id TEXT PRIMARY KEY REFERENCES chimpbase_execution.step_attempts(attempt_id),
          failure_category TEXT,
          logs_json TEXT NOT NULL,
          patch_json TEXT,
          commit_json TEXT,
          changed_files_json TEXT NOT NULL,
          tests_json TEXT NOT NULL,
          timing_json TEXT NOT NULL,
          resources_json TEXT NOT NULL
        );
      `,
    },
  ],
} as const;
