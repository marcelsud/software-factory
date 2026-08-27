export interface EventSourceRow {
  source_id: string;
  created_at: string;
}

export interface SourceCursorRow {
  cursor: string;
  source_id: string;
  updated_at: string;
}

export interface FactoryEventRow {
  delivery_id: string;
  event_json: string;
  event_type: string;
  observed_at: string;
  payload_digest: string;
  repository: string;
  source_id: string;
  source_revision: string;
  subject: string;
}

export interface DeliveryDeduplicationRow {
  accepted_at: string;
  delivery_id: string;
  payload_digest: string;
  source_id: string;
}

export interface SourcePayloadSnapshotRow {
  delivery_id: string;
  observed_at: string;
  payload_digest: string;
  payload_json: string;
  source_id: string;
}

export interface IntakeDatabase {
  delivery_deduplication: DeliveryDeduplicationRow;
  event_sources: EventSourceRow;
  factory_events: FactoryEventRow;
  source_cursors: SourceCursorRow;
  source_payload_snapshots: SourcePayloadSnapshotRow;
}

export const intakeMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS event_sources (
          source_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_event_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS source_cursors (
          source_id TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (source_id) REFERENCES event_sources(source_id)
        );
        CREATE TABLE IF NOT EXISTS delivery_deduplication (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id)
        );
        CREATE TABLE IF NOT EXISTS factory_events (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          event_type TEXT NOT NULL,
          repository TEXT NOT NULL,
          subject TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id),
          FOREIGN KEY (source_id, delivery_id) REFERENCES delivery_deduplication(source_id, delivery_id)
        );
        CREATE TABLE IF NOT EXISTS source_payload_snapshots (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id),
          FOREIGN KEY (source_id, delivery_id) REFERENCES delivery_deduplication(source_id, delivery_id)
        );
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_intake.event_sources (
          source_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_event_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_intake.source_cursors (
          source_id TEXT PRIMARY KEY REFERENCES chimpbase_intake.event_sources(source_id),
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_intake.delivery_deduplication (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_intake.factory_events (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          event_type TEXT NOT NULL,
          repository TEXT NOT NULL,
          subject TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id),
          FOREIGN KEY (source_id, delivery_id) REFERENCES chimpbase_intake.delivery_deduplication(source_id, delivery_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_intake.source_payload_snapshots (
          source_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_id, delivery_id),
          FOREIGN KEY (source_id, delivery_id) REFERENCES chimpbase_intake.delivery_deduplication(source_id, delivery_id)
        );
      `,
    },
  ],
} as const;
