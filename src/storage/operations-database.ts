export interface OperationHealthProjectionRow {
  id: string;
  last_sequence: number;
  updated_at: string;
}

export interface OperationRunProjectionRow {
  finished_at: string | null;
  projection_json: string;
  run_id: string;
  source_key: string | null;
  started_at: string;
  status: string;
  updated_at: string;
}

export interface OperationTimelineProjectionRow {
  event_id: string;
  kind: string;
  occurred_at: string;
  payload_json: string;
  run_id: string;
  sequence: number;
}

export interface OperationEventProjectionRow {
  event_id: string;
  kind: string;
  occurred_at: string;
  payload_json: string;
  run_id: string | null;
  sequence: number;
  source_key: string | null;
}

export interface OperationEffectProjectionRow {
  effect_id: string;
  finished_at: string | null;
  idempotency_key: string;
  projection_json: string;
  requested_at: string;
  run_id: string;
  status: string;
}

export interface OperatorCommandAuditRow {
  actor: string;
  applied_at: string | null;
  command_key: string;
  command_json: string;
  error: string | null;
  kind: string;
  outcome: string;
  requested_at: string;
  result_json: string | null;
  run_id: string;
}

export interface OperationsDatabase {
  effect_projections: OperationEffectProjectionRow;
  event_projections: OperationEventProjectionRow;
  operator_command_audit: OperatorCommandAuditRow;
  run_projections: OperationRunProjectionRow;
  timeline_projections: OperationTimelineProjectionRow;
  health_projection: OperationHealthProjectionRow;
}

export const operationsMigrations = {
  sqlite: [
    {
      name: "001_projections",
      sql: `
        CREATE TABLE IF NOT EXISTS event_projections (
          event_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          run_id TEXT,
          source_key TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_events_order
          ON event_projections(sequence, event_id);
        CREATE INDEX IF NOT EXISTS operations_events_run_order
          ON event_projections(run_id, sequence, event_id);

        CREATE TABLE IF NOT EXISTS run_projections (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          source_key TEXT,
          projection_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_runs_order
          ON run_projections(started_at DESC, run_id);
        CREATE INDEX IF NOT EXISTS operations_runs_source
          ON run_projections(source_key, run_id);

        CREATE TABLE IF NOT EXISTS timeline_projections (
          run_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (run_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS operations_timeline_order
          ON timeline_projections(run_id, sequence, event_id);

        CREATE TABLE IF NOT EXISTS effect_projections (
          idempotency_key TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          status TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          finished_at TEXT,
          projection_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_effects_order
          ON effect_projections(requested_at DESC, idempotency_key);

        CREATE TABLE IF NOT EXISTS operator_command_audit (
          command_key TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          applied_at TEXT,
          outcome TEXT NOT NULL,
          error TEXT,
          command_json TEXT NOT NULL,
          result_json TEXT
        );
        CREATE TABLE IF NOT EXISTS health_projection (
          id TEXT PRIMARY KEY,
          last_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_commands_run_order
          ON operator_command_audit(run_id, requested_at, command_key);
      `,
    },
  ],
  postgres: [
    {
      name: "001_projections",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_operations.event_projections (
          event_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          run_id TEXT,
          source_key TEXT,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chimpbase_operations.run_projections (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          source_key TEXT,
          projection_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chimpbase_operations.timeline_projections (
          run_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (run_id, event_id)
        );

        CREATE TABLE IF NOT EXISTS chimpbase_operations.effect_projections (
          idempotency_key TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          status TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          finished_at TEXT,
          projection_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chimpbase_operations.operator_command_audit (
          command_key TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          applied_at TEXT,
          outcome TEXT NOT NULL,
          error TEXT,
          command_json TEXT NOT NULL,
          result_json TEXT
        );
        CREATE TABLE IF NOT EXISTS chimpbase_operations.health_projection (
          id TEXT PRIMARY KEY,
          last_sequence BIGINT NOT NULL,
          updated_at TEXT NOT NULL
        );

      `,
    },
  ],
} as const;
