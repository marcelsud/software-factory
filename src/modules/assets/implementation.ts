import { createHash } from "node:crypto";
import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import type { Kysely } from "kysely";

import { artifact, type PinnedSkillBundle, pinnedSkillBundle } from "../../contracts/index.ts";
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

function skillBundleDigest(bundle: PinnedSkillBundle): string {
  const canonical = JSON.stringify({
    files: [...bundle.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ contentBase64, digest, kind, path, size }) => ({
        contentBase64: contentBase64 ?? null,
        digest,
        kind,
        path,
        size,
      })),
    instructions: bundle.instructions,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export const assetsImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: assetsMigrations,
  resources: {
    collections: ["artifacts", "skill-bundles", "skill-revisions"],
    kvPrefixes: ["artifact-bytes", "artifact-materializations"],
    tables: ["artifact_blobs", "artifacts", "skill_bundles", "skill_revisions"],
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
    async putSkillBundle(ctx, input) {
      const bundle = pinnedSkillBundle.parse(input.bundle);
      if (skillBundleDigest(bundle) !== bundle.digest) throw new Error("digest_mismatch");
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const existing = await db
        .selectFrom("skill_bundles")
        .selectAll()
        .where("digest", "=", bundle.digest)
        .executeTakeFirst();
      const bundleJson = JSON.stringify(bundle);
      if (existing !== undefined) {
        if (existing.reference !== input.reference || existing.bundle_json !== bundleJson)
          throw new Error("skill_conflict");
        return bundle;
      }
      await db
        .insertInto("skill_bundles")
        .values({ bundle_json: bundleJson, digest: bundle.digest, reference: input.reference })
        .execute();
      return bundle;
    },
    async getSkillBundle(ctx, input) {
      const row = await (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
        .selectFrom("skill_bundles")
        .select("bundle_json")
        .where("digest", "=", input.digest)
        .executeTakeFirst();
      return row === undefined ? null : pinnedSkillBundle.parse(JSON.parse(row.bundle_json));
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
      await db
        .insertInto("artifact_blobs")
        .values({ content_base64: input.contentBase64, digest: metadata.digest })
        .execute();
      ctx.publish(assets.events.artifactStoredV1, metadata);
      return metadata;
    },
    async getArtifact(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
      const row = await db
        .selectFrom("artifacts")
        .innerJoin("artifact_blobs", "artifact_blobs.digest", "artifacts.digest")
        .selectAll("artifacts")
        .select("artifact_blobs.content_base64")
        .where("artifacts.digest", "=", input.digest)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { artifact: artifactFromRow(row), contentBase64: row.content_base64 };
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
