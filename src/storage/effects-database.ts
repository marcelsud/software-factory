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

export interface EffectsDatabase {
  effect_intents: EffectIntentRow;
  effect_preconditions: EffectPreconditionRow;
  effect_receipts: EffectReceiptRow;
  effect_reconciliation: EffectReconciliationRow;
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
  ],
} as const;
