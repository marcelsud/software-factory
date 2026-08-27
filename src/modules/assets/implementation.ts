import { createHash } from "node:crypto";
import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import type { Kysely } from "kysely";

import { artifact } from "../../contracts/index.ts";
import { type AssetsDatabase, assetsMigrations } from "../../storage/assets-database.ts";
import { assets } from "./interface.ts";

const implementationInterface = assets as unknown as ChimpbaseModuleInterface<
  typeof assets.calls,
  typeof assets.events
>;

function artifactFromRow(row: AssetsDatabase["artifacts"]) {
  return artifact.parse({
    classification: row.classification,
    digest: row.digest,
    mediaType: row.media_type,
    name: row.name,
    runId: row.run_id,
    size: row.size,
  });
}

export const assetsImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: assetsMigrations,
  resources: {
    collections: ["artifacts", "skill-revisions"],
    kvPrefixes: ["artifact-bytes", "artifact-materializations"],
    tables: ["artifacts", "skill_revisions"],
  },
  calls: {
    async resolveSkill(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const existing = await db
        .selectFrom("skill_revisions")
        .selectAll()
        .where("digest", "=", input.revision)
        .executeTakeFirst();
      if (existing !== undefined) return { digest: existing.digest, reference: existing.reference };
      const revision = { digest: input.revision, reference: input.reference };
      await db.insertInto("skill_revisions").values(revision).execute();
      ctx.publish(assets.events.skillRevisionPinnedV1, revision);
      return revision;
    },
    async putArtifact(ctx, input) {
      const bytes = Buffer.from(input.contentBase64, "base64");
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      const expectedDigest = input.artifact.digest.replace(/^sha256:/, "");
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `digest_mismatch: expected ${input.artifact.digest}, received ${actualDigest}`,
        );
      }
      if (bytes.byteLength !== input.artifact.size) {
        throw new Error("digest_mismatch: artifact size does not match content");
      }
      const metadata = artifact.parse(input.artifact);
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const existing = await db
        .selectFrom("artifacts")
        .selectAll()
        .where("digest", "=", metadata.digest)
        .executeTakeFirst();
      if (existing !== undefined) {
        const stored = artifactFromRow(existing);
        if (JSON.stringify(stored) !== JSON.stringify(metadata)) {
          throw new Error(
            "digest_mismatch: immutable artifact digest already has different metadata",
          );
        }
        return stored;
      }
      await db
        .insertInto("artifacts")
        .values({
          classification: metadata.classification,
          digest: metadata.digest,
          media_type: metadata.mediaType,
          name: metadata.name,
          run_id: metadata.runId,
          size: metadata.size,
        })
        .execute();
      ctx.publish(assets.events.artifactStoredV1, metadata);
      return metadata;
    },
    async getArtifact(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const row = await db
        .selectFrom("artifacts")
        .select("digest")
        .where("digest", "=", input.digest)
        .executeTakeFirst();
      if (row === undefined) return null;
      throw new Error("module_unavailable: artifact byte driver is not configured");
    },
    async materializeArtifact(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const row = await db
        .selectFrom("artifacts")
        .selectAll()
        .where("digest", "=", input.digest)
        .executeTakeFirst();
      if (row === undefined) throw new Error("artifact_not_found");
      throw new Error(
        `module_unavailable: materialization driver is not configured for ${input.destination}`,
      );
    },
    async listRunArtifacts(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const rows = await db
        .selectFrom("artifacts")
        .selectAll()
        .where("run_id", "=", input.runId)
        .orderBy("digest")
        .execute();
      return rows.map(artifactFromRow);
    },
  },
});
