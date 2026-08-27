export interface SkillRevisionRow {
  digest: string;
  reference: string;
}

export interface SkillBundleRow {
  bundle_json: string;
  digest: string;
  reference: string;
}

export interface ArtifactBlobRow {
  content_base64: string;
  digest: string;
}

export interface ArtifactRow {
  classification: string;
  digest: string;
  media_type: string;
  name: string;
  run_id: string;
  size: number;
}

export interface SkillRevisionV2Row {
  bundle_json: string;
  digest: string;
  id: string;
  source: string;
}

export interface ArtifactV2Row {
  attempt_id: string | null;
  classification: string;
  created_at: string;
  digest: string;
  kind: string;
  media_type: string;
  name: string;
  redaction: string;
  retention: string;
  run_id: string;
  size: number;
  source_digest: string | null;
}

export interface AssetsDatabase {
  artifacts: ArtifactRow;
  artifact_blobs: ArtifactBlobRow;
  skill_bundles: SkillBundleRow;
  skill_revisions: SkillRevisionRow;
  artifacts_v2: ArtifactV2Row;
  skill_revisions_v2: SkillRevisionV2Row;
}

export const assetsMigrations = {
  sqlite: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS skill_revisions (
          digest TEXT PRIMARY KEY,
          reference TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_artifact_metadata",
      sql: `
        CREATE TABLE IF NOT EXISTS artifacts (
          digest TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          classification TEXT NOT NULL
        );
      `,
    },
    {
      name: "003_skill_bundles",
      sql: `
        CREATE TABLE IF NOT EXISTS skill_bundles (
          digest TEXT PRIMARY KEY,
          reference TEXT NOT NULL,
          bundle_json TEXT NOT NULL
        );
      `,
    },
    {
      name: "004_artifact_blobs",
      sql: `
        CREATE TABLE IF NOT EXISTS artifact_blobs (
          digest TEXT PRIMARY KEY,
          content_base64 TEXT NOT NULL,
          FOREIGN KEY (digest) REFERENCES artifacts(digest)
        );
      `,
    },
    {
      name: "005_strict_assets",
      sql: `
        CREATE TABLE IF NOT EXISTS skill_revisions_v2 (
          digest TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          source TEXT NOT NULL,
          bundle_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS skill_revisions_v2_id_digest
          ON skill_revisions_v2(id, digest);
        CREATE TABLE IF NOT EXISTS artifacts_v2 (
          digest TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_id TEXT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          classification TEXT NOT NULL,
          retention TEXT NOT NULL,
          redaction TEXT NOT NULL,
          created_at TEXT NOT NULL,
          source_digest TEXT,
          PRIMARY KEY (digest, run_id)
        );
        CREATE INDEX IF NOT EXISTS artifacts_v2_run_digest
          ON artifacts_v2(run_id, digest);
      `,
    },
  ],
  postgres: [
    {
      name: "001_ledger",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_assets.skill_revisions (
          digest TEXT PRIMARY KEY,
          reference TEXT NOT NULL
        );
      `,
    },
    {
      name: "002_artifact_metadata",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_assets.artifacts (
          digest TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          classification TEXT NOT NULL
        );
      `,
    },
    {
      name: "003_skill_bundles",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_assets.skill_bundles (
          digest TEXT PRIMARY KEY,
          reference TEXT NOT NULL,
          bundle_json TEXT NOT NULL
        );
      `,
    },
    {
      name: "004_artifact_blobs",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_assets.artifact_blobs (
          digest TEXT PRIMARY KEY REFERENCES chimpbase_assets.artifacts(digest),
          content_base64 TEXT NOT NULL
        );
      `,
    },
    {
      name: "005_strict_assets",
      sql: `
        CREATE TABLE IF NOT EXISTS chimpbase_assets.skill_revisions_v2 (
          digest TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          source TEXT NOT NULL,
          bundle_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chimpbase_assets.artifacts_v2 (
          digest TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_id TEXT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size BIGINT NOT NULL,
          classification TEXT NOT NULL,
          retention TEXT NOT NULL,
          redaction TEXT NOT NULL,
          created_at TEXT NOT NULL,
          source_digest TEXT,
          PRIMARY KEY (digest, run_id)
        );
      `,
    },
  ],
} as const;
