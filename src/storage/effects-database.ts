export interface EffectIntentRow {
  capability: string;
  correlation_token: string;
  expected_external_revision: string | null;
  idempotency_key: string;
  payload_digest: string;
  provenance: string;
  requested_at: string;
  run_id: string;
  target: string;
}

export interface EffectReceiptRow {
  correlation_token: string;
  effect_id: string;
  external_revision: string | null;
  finished_at: string | null;
  idempotency_key: string;
  outcome: string;
  recorded_at: string;
  run_id: string;
}

export interface EffectPreconditionRow {
  expected_external_revision: string | null;
  idempotency_key: string;
  payload_digest: string;
  target: string;
}

export interface EffectReconciliationRow {
  idempotency_key: string;
  observed_at: string;
  outcome: string;
}

export interface EffectIntentV3Row {
  capability: string;
  correlation_token: string;
  dry_run: number;
  idempotency_key: string;
  intent_json: string;
  payload_digest: string;
  requested_at: string;
  run_id: string;
}

export interface EffectPreconditionV3Row {
  expected_external_revision: string | null;
  idempotency_key: string;
  observed_external_revision: string | null;
  checked_at: string | null;
}

export interface EffectReceiptV3Row {
  claimed_at: string | null;
  claim_token: string | null;
  correlation_token: string;
  effect_id: string;
  external_id: string | null;
  external_revision: string | null;
  external_url: string | null;
  failure_category: string | null;
  finished_at: string | null;
  idempotency_key: string;
  outcome: string | null;
  recorded_at: string;
  run_id: string;
  status: string;
}

export interface EffectReconciliationV3Row {
  idempotency_key: string;
  observed_at: string;
  result_json: string;
}

export interface EffectDryRunV3Row {
  idempotency_key: string;
  planned_at: string;
  planned_json: string;
}

export interface EffectBotCorrelationV3Row {
  external_id: string;
  idempotency_key: string;
  observed_at: string;
}

export interface EffectsDatabase {
  effect_bot_correlations_v3: EffectBotCorrelationV3Row;
  effect_dry_runs_v3: EffectDryRunV3Row;
  effect_intents: EffectIntentRow;
  effect_intents_v3: EffectIntentV3Row;
  effect_preconditions: EffectPreconditionRow;
  effect_preconditions_v3: EffectPreconditionV3Row;
  effect_receipts: EffectReceiptRow;
  effect_receipts_v3: EffectReceiptV3Row;
  effect_reconciliation: EffectReconciliationRow;
  effect_reconciliation_v3: EffectReconciliationV3Row;
}

export const effectsMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS effect_intents (
          idempotency_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          provenance TEXT NOT NULL,
          capability TEXT NOT NULL,
          target TEXT NOT NULL,
          expected_external_revision TEXT,
          payload_digest TEXT NOT NULL,
          requested_at TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_receipts",
      sql: `
        CREATE TABLE IF NOT EXISTS effect_receipts (
          idempotency_key TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          external_revision TEXT,
          outcome TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_preconditions (
          idempotency_key TEXT PRIMARY KEY,
          target TEXT NOT NULL,
          expected_external_revision TEXT,
          payload_digest TEXT NOT NULL,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_reconciliation (
          idempotency_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          PRIMARY KEY (idempotency_key, observed_at),
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents(idempotency_key)
        );
      `,
    },
    {
      name: "003_strict_effects",
      sql: `
        CREATE TABLE IF NOT EXISTS effect_intents_v3 (
          idempotency_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          capability TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          dry_run INTEGER NOT NULL,
          requested_at TEXT NOT NULL,
          intent_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS effect_preconditions_v3 (
          idempotency_key TEXT PRIMARY KEY,
          expected_external_revision TEXT,
          observed_external_revision TEXT,
          checked_at TEXT,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents_v3(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_receipts_v3 (
          idempotency_key TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          status TEXT NOT NULL,
          claimed_at TEXT,
          claim_token TEXT,
          outcome TEXT,
          external_revision TEXT,
          external_url TEXT,
          external_id TEXT,
          failure_category TEXT,
          recorded_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents_v3(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_reconciliation_v3 (
          idempotency_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (idempotency_key, observed_at),
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents_v3(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_dry_runs_v3 (
          idempotency_key TEXT PRIMARY KEY,
          planned_at TEXT NOT NULL,
          planned_json TEXT NOT NULL,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents_v3(idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS effect_bot_correlations_v3 (
          external_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          FOREIGN KEY (idempotency_key) REFERENCES effect_intents_v3(idempotency_key)
        );
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_intents (
          idempotency_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          provenance TEXT NOT NULL,
          capability TEXT NOT NULL,
          target TEXT NOT NULL,
          expected_external_revision TEXT,
          payload_digest TEXT NOT NULL,
          requested_at TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_receipts",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_receipts (
          idempotency_key TEXT PRIMARY KEY REFERENCES chimpbase_effects.effect_intents(idempotency_key),
          effect_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          external_revision TEXT,
          outcome TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_preconditions (
          idempotency_key TEXT PRIMARY KEY REFERENCES chimpbase_effects.effect_intents(idempotency_key),
          target TEXT NOT NULL,
          expected_external_revision TEXT,
          payload_digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_reconciliation (
          idempotency_key TEXT NOT NULL REFERENCES chimpbase_effects.effect_intents(idempotency_key),
          observed_at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          PRIMARY KEY (idempotency_key, observed_at)
        );
      `,
    },
    {
      name: "003_strict_effects",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_intents_v3 (
          idempotency_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          capability TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          dry_run INTEGER NOT NULL,
          requested_at TEXT NOT NULL,
          intent_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_preconditions_v3 (
          idempotency_key TEXT PRIMARY KEY REFERENCES chimpbase_effects.effect_intents_v3(idempotency_key),
          expected_external_revision TEXT,
          observed_external_revision TEXT,
          checked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_receipts_v3 (
          idempotency_key TEXT PRIMARY KEY REFERENCES chimpbase_effects.effect_intents_v3(idempotency_key),
          effect_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          correlation_token TEXT NOT NULL,
          status TEXT NOT NULL,
          claimed_at TEXT,
          claim_token TEXT,
          outcome TEXT,
          external_revision TEXT,
          external_url TEXT,
          external_id TEXT,
          failure_category TEXT,
          recorded_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_reconciliation_v3 (
          idempotency_key TEXT NOT NULL REFERENCES chimpbase_effects.effect_intents_v3(idempotency_key),
          observed_at TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (idempotency_key, observed_at)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_dry_runs_v3 (
          idempotency_key TEXT PRIMARY KEY REFERENCES chimpbase_effects.effect_intents_v3(idempotency_key),
          planned_at TEXT NOT NULL,
          planned_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_effects.effect_bot_correlations_v3 (
          external_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL REFERENCES chimpbase_effects.effect_intents_v3(idempotency_key),
          observed_at TEXT NOT NULL
        );
      `,
    },
  ],
} as const;
