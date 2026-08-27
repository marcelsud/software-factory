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

export interface AssetsDatabase {
  artifacts: ArtifactRow;
  artifact_blobs: ArtifactBlobRow;
  skill_bundles: SkillBundleRow;
  skill_revisions: SkillRevisionRow;
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
  ],
} as const;
