export interface SkillRevisionRow {
  digest: string;
  reference: string;
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
  ],
} as const;
