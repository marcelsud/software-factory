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
export interface GitHubIssueSnapshotRow {
  issue_id: string;
  issue_number: number;
  position: string;
  repository_id: string;
  snapshot_json: string;
  updated_at: string;
}

export interface GitHubCommentSnapshotRow {
  comment_id: string;
  issue_number: number;
  position: string;
  repository_id: string;
  snapshot_json: string;
  updated_at: string;
}

export interface GitHubPollStateRow {
  comments_etag: string | null;
  issues_etag: string | null;
  rate_limit: number | null;
  rate_remaining: number | null;
  rate_retry_after_ms: number | null;
  rate_reset_at: string | null;
  repository_id: string;
  source_position: string | null;
  updated_at: string;
}

export interface IntakeDatabase {
  delivery_deduplication: DeliveryDeduplicationRow;
  event_sources: EventSourceRow;
  factory_events: FactoryEventRow;
  github_comment_snapshots: GitHubCommentSnapshotRow;
  github_issue_snapshots: GitHubIssueSnapshotRow;
  github_poll_state: GitHubPollStateRow;
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
    {
      name: "003_github_polling",
      sql: `
        CREATE TABLE IF NOT EXISTS github_issue_snapshots (
          repository_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          position TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (repository_id, issue_id)
        );
        CREATE INDEX IF NOT EXISTS github_issue_snapshots_position
          ON github_issue_snapshots(repository_id, updated_at, issue_id);
        CREATE TABLE IF NOT EXISTS github_comment_snapshots (
          repository_id TEXT NOT NULL,
          comment_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          position TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (repository_id, comment_id)
        );
        CREATE INDEX IF NOT EXISTS github_comment_snapshots_position
          ON github_comment_snapshots(repository_id, updated_at, comment_id);
        CREATE TABLE IF NOT EXISTS github_poll_state (
          repository_id TEXT PRIMARY KEY,
          source_position TEXT,
          issues_etag TEXT,
          comments_etag TEXT,
          rate_limit INTEGER,
          rate_remaining INTEGER,
          rate_retry_after_ms INTEGER,
          rate_reset_at TEXT,
          updated_at TEXT NOT NULL
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
    {
      name: "003_github_polling",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_intake.github_issue_snapshots (
          repository_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          position TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (repository_id, issue_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_intake.github_comment_snapshots (
          repository_id TEXT NOT NULL,
          comment_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          position TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (repository_id, comment_id)
        );
        CREATE TABLE IF NOT EXISTS chimpbase_intake.github_poll_state (
          repository_id TEXT PRIMARY KEY,
          source_position TEXT,
          issues_etag TEXT,
          comments_etag TEXT,
          rate_limit INTEGER,
          rate_remaining INTEGER,
          rate_reset_at TEXT,
          rate_retry_after_ms INTEGER,
          updated_at TEXT NOT NULL
        );
      `,
    },
  ],
} as const;
