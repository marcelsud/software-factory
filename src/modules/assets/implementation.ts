import { createHash } from "node:crypto";
import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import type { Kysely } from "kysely";

import { MemoryArtifactByteDriver } from "../../adapters/artifact-byte-driver.ts";
import type { ArtifactByteDriver } from "../../adapters/seams.ts";
import { assertVerifiedSkillBundle as assertStrictBundle } from "../../assets/skill-bundle.ts";
import {
  type ArtifactV2,
  artifact,
  artifactV2,
  type PinnedSkillBundle,
  type PinnedSkillBundleV2,
  pinnedSkillBundle,
  redactSecrets,
  type SkillRevisionV2,
  skillRevisionV2,
} from "../../contracts/index.ts";
import { type AssetsDatabase, assetsMigrations } from "../../storage/assets-database.ts";
import { assets } from "./interface.ts";

const implementationInterface = assets as unknown as ChimpbaseModuleInterface<
  typeof assets.calls,
  typeof assets.events
>;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PUBLIC_TEXT_LIMIT = 1024 * 1024;
const ARTIFACT_LIMITS: Readonly<Record<ArtifactV2["kind"], number>> = {
  "result.json": 1024 * 1024,
  "report.md": 4 * 1024 * 1024,
  log: 8 * 1024 * 1024,
  patch: 32 * 1024 * 1024,
  "test-result": 4 * 1024 * 1024,
  reproduction: 16 * 1024 * 1024,
  metadata: 1024 * 1024,
};

export interface AssetsImplementationDependencies {
  readonly artifactByteDriver?: ArtifactByteDriver;
}

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

function artifactV2FromRow(row: AssetsDatabase["artifacts_v2"]): ArtifactV2 {
  return artifactV2.parse({
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    classification: row.classification,
    createdAt: row.created_at,
    digest: row.digest,
    kind: row.kind,
    mediaType: row.media_type,
    name: row.name,
    redaction: row.redaction,
    retention: row.retention,
    runId: row.run_id,
    size: row.size,
    ...(row.source_digest === null ? {} : { sourceDigest: row.source_digest }),
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

function assertDigestAndSize(digest: string, size: number, bytes: Uint8Array): void {
  if (!DIGEST.test(digest)) throw new Error(`digest_mismatch: invalid digest ${digest}`);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== digest) throw new Error(`digest_mismatch: expected ${digest}, received ${actual}`);
  if (bytes.byteLength !== size)
    throw new Error("digest_mismatch: artifact size does not match content");
}

function assertLegacyDigestAndSize(digest: string, size: number, bytes: Uint8Array): void {
  const expected = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(digest)?.[1];
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected === undefined || actual !== expected)
    throw new Error(`digest_mismatch: expected ${digest}, received ${actual}`);
  if (bytes.byteLength !== size)
    throw new Error("digest_mismatch: artifact size does not match content");
}

function revisionFromBundle(bundle: PinnedSkillBundleV2, source: string): SkillRevisionV2 {
  return skillRevisionV2.parse({
    capabilities: bundle.capabilities,
    compatibility: bundle.compatibility,
    customizable: bundle.customizable,
    digest: bundle.digest,
    id: bundle.id,
    inputArtifactKinds: bundle.inputArtifactKinds,
    resultSchema: bundle.resultSchema,
    source,
    version: bundle.version,
  });
}

function redactPublicText(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > PUBLIC_TEXT_LIMIT) throw new Error("artifact_too_large: public candidate");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("artifact_not_publishable: binary artifact");
  }
  return Buffer.from(redactSecrets(text), "utf8");
}
async function legacyBytes(
  db: Kysely<AssetsDatabase>,
  driver: ArtifactByteDriver,
  digest: string,
): Promise<Uint8Array | null> {
  const current = await driver.get(digest);
  if (current !== null) return current;
  const legacy = await db
    .selectFrom("artifact_blobs")
    .select("content_base64")
    .where("digest", "=", digest)
    .executeTakeFirst();
  if (legacy === undefined) return null;
  const bytes = Buffer.from(legacy.content_base64, "base64");
  assertLegacyDigestAndSize(digest, bytes.byteLength, bytes);
  await driver.put(digest, bytes);
  return bytes;
}

function artifactRecordId(metadata: ArtifactV2): string {
  return createHash("sha256").update(JSON.stringify(metadata), "utf8").digest("hex");
}

async function strictBytes(
  db: Kysely<AssetsDatabase>,
  driver: ArtifactByteDriver,
  digest: string,
): Promise<Uint8Array | null> {
  const current = await driver.get(digest);
  if (current !== null) return current;
  const fallback = await db
    .selectFrom("artifact_blobs_v2")
    .select("content_base64")
    .where("digest", "=", digest)
    .executeTakeFirst();
  if (fallback === undefined) return null;
  const bytes = Buffer.from(fallback.content_base64, "base64");
  assertDigestAndSize(digest, bytes.byteLength, bytes);
  await driver.put(digest, bytes);
  return bytes;
}

export function createAssetsImplementation(dependencies: AssetsImplementationDependencies = {}) {
  const byteDriver = dependencies.artifactByteDriver ?? new MemoryArtifactByteDriver();
  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: assetsMigrations,
    resources: {
      collections: ["artifacts", "skill-bundles", "skill-revisions"],
      kvPrefixes: ["artifact-bytes", "artifact-materializations"],
      tables: [
        "artifact_blobs",
        "artifact_blobs_v2",
        "artifacts",
        "artifacts_v2",
        "skill_bundles",
        "skill_revisions",
        "skill_revisions_v2",
      ],
    },
    calls: {
      async resolveSkill(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const existing = await db
          .selectFrom("skill_revisions")
          .selectAll()
          .where("digest", "=", input.revision)
          .executeTakeFirst();
        if (existing !== undefined)
          return { digest: existing.digest, reference: existing.reference };
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
      async resolveSkillV2(ctx, input) {
        const row = await (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
          .selectFrom("skill_revisions_v2")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("id", "=", input.id)
          .executeTakeFirst();
        if (row === undefined) throw new Error(`skill_not_found: ${input.id}@${input.digest}`);
        return assertStrictBundle(JSON.parse(row.bundle_json));
      },
      async storeSkillBundleV2(ctx, input) {
        const bundle = assertStrictBundle(input.bundle);
        if (
          input.source.startsWith("/") ||
          input.source.includes("\\") ||
          input.source.split("/").includes("..")
        )
          throw new Error("skill_root_escape");
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const bundleJson = JSON.stringify(bundle);
        const existing = await db
          .selectFrom("skill_revisions_v2")
          .selectAll()
          .where("digest", "=", bundle.digest)
          .executeTakeFirst();
        if (
          existing !== undefined &&
          (existing.id !== bundle.id ||
            existing.source !== input.source ||
            existing.bundle_json !== bundleJson)
        )
          throw new Error("skill_conflict");
        const revision = revisionFromBundle(bundle, input.source);
        if (existing === undefined) {
          await db
            .insertInto("skill_revisions_v2")
            .values({
              bundle_json: bundleJson,
              digest: bundle.digest,
              id: bundle.id,
              source: input.source,
            })
            .execute();
          ctx.publish(assets.events.skillRevisionPinnedV2, revision);
        }
        return revision;
      },
      async verifySkillBundleV2(_ctx, input) {
        return assertStrictBundle(input.bundle);
      },
      async getSkillBundleV2(ctx, input) {
        const row = await (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
          .selectFrom("skill_revisions_v2")
          .select("bundle_json")
          .where("digest", "=", input.digest)
          .executeTakeFirst();
        return row === undefined ? null : assertStrictBundle(JSON.parse(row.bundle_json));
      },
      async listSkillRevisionsV2(ctx, input) {
        let query = (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
          .selectFrom("skill_revisions_v2")
          .selectAll();
        if (input.id !== undefined) query = query.where("id", "=", input.id);
        const rows = await query.orderBy("id").orderBy("digest").execute();
        return rows.map((row) =>
          revisionFromBundle(assertStrictBundle(JSON.parse(row.bundle_json)), row.source),
        );
      },
      async putArtifact(ctx, input) {
        const bytes = Buffer.from(input.contentBase64, "base64");
        const metadata = artifact.parse(input.artifact);
        assertLegacyDigestAndSize(metadata.digest, metadata.size, bytes);
        await byteDriver.put(metadata.digest, bytes);
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const existing = await db
          .selectFrom("artifacts")
          .selectAll()
          .where("digest", "=", metadata.digest)
          .executeTakeFirst();
        if (existing !== undefined) {
          const stored = artifactFromRow(existing);
          if (JSON.stringify(stored) !== JSON.stringify(metadata))
            throw new Error(
              "digest_mismatch: immutable artifact digest already has different metadata",
            );
        } else {
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
        }
        await db
          .insertInto("artifact_blobs")
          .values({ content_base64: input.contentBase64, digest: metadata.digest })
          .onConflict((conflict) => conflict.column("digest").doNothing())
          .execute();
        if (existing === undefined) ctx.publish(assets.events.artifactStoredV1, metadata);
        return metadata;
      },
      async getArtifact(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const row = await db
          .selectFrom("artifacts")
          .selectAll()
          .where("digest", "=", input.digest)
          .executeTakeFirst();
        if (row === undefined) return null;
        const bytes = await legacyBytes(db, byteDriver, input.digest);
        if (bytes === null) throw new Error(`artifact_corrupt: ${input.digest}`);
        return {
          artifact: artifactFromRow(row),
          contentBase64: Buffer.from(bytes).toString("base64"),
        };
      },
      async materializeArtifact(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const row = await db
          .selectFrom("artifacts")
          .selectAll()
          .where("digest", "=", input.digest)
          .executeTakeFirst();
        if (row === undefined) throw new Error("artifact_not_found");
        const bytes = await legacyBytes(db, byteDriver, input.digest);
        if (bytes === null) throw new Error(`artifact_corrupt: ${input.digest}`);
        await byteDriver.materialize(input.digest, input.destination);
        return artifactFromRow(row);
      },
      async listRunArtifacts(ctx, input) {
        const rows = await (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
          .selectFrom("artifacts")
          .selectAll()
          .where("run_id", "=", input.runId)
          .orderBy("digest")
          .execute();
        return rows.map(artifactFromRow);
      },
      async storeArtifactV2(ctx, input) {
        const metadata = artifactV2.parse(input.artifact);
        const bytes = Buffer.from(input.contentBase64, "base64");
        const artifactLimit = ARTIFACT_LIMITS[metadata.kind];
        if (artifactLimit === undefined) throw new Error("invalid_artifact_kind");
        if (metadata.size > artifactLimit) throw new Error("artifact_too_large");
        assertDigestAndSize(metadata.digest, metadata.size, bytes);
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        if (metadata.classification === "public") {
          if (
            metadata.redaction !== "redacted-public" ||
            metadata.sourceDigest === undefined ||
            metadata.sourceDigest === metadata.digest
          )
            throw new Error("artifact_not_publishable");
          const source = await db
            .selectFrom("artifacts_v2")
            .select(["attempt_id", "classification"])
            .where("digest", "=", metadata.sourceDigest)
            .where("run_id", "=", metadata.runId)
            .executeTakeFirst();
          if (
            source?.classification !== "private" ||
            source.attempt_id !== (metadata.attemptId ?? null)
          )
            throw new Error("artifact_not_publishable");
          const scanned = redactPublicText(bytes);
          if (!Buffer.from(scanned).equals(bytes))
            throw new Error("artifact_not_publishable: secret detected");
        } else if (metadata.redaction !== "raw-private" || metadata.sourceDigest !== undefined) {
          throw new Error("artifact_conflict: invalid private artifact redaction");
        }
        await byteDriver.put(metadata.digest, bytes);
        await db
          .insertInto("artifact_blobs_v2")
          .values({ content_base64: input.contentBase64, digest: metadata.digest })
          .onConflict((conflict) => conflict.column("digest").doNothing())
          .execute();
        const recordId = artifactRecordId(metadata);
        const existing = await db
          .selectFrom("artifacts_v2")
          .select("record_id")
          .where("record_id", "=", recordId)
          .executeTakeFirst();
        if (existing === undefined) {
          await db
            .insertInto("artifacts_v2")
            .values({
              attempt_id: metadata.attemptId ?? null,
              classification: metadata.classification,
              created_at: metadata.createdAt,
              digest: metadata.digest,
              kind: metadata.kind,
              media_type: metadata.mediaType,
              name: metadata.name,
              record_id: recordId,
              redaction: metadata.redaction,
              retention: metadata.retention,
              run_id: metadata.runId,
              size: metadata.size,
              source_digest: metadata.sourceDigest ?? null,
            })
            .execute();
          ctx.publish(assets.events.artifactStoredV2, metadata);
        }
        return metadata;
      },
      async getArtifactV2(ctx, input) {
        if (!input.allowedDigests.includes(input.digest)) throw new Error("artifact_access_denied");
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const row = await db
          .selectFrom("artifacts_v2")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (row !== undefined) {
          const bytes = await strictBytes(db, byteDriver, input.digest);
          if (bytes === null || bytes.byteLength !== row.size)
            throw new Error(`artifact_corrupt: ${input.digest}`);
          return {
            artifact: artifactV2FromRow(row),
            contentBase64: Buffer.from(bytes).toString("base64"),
          };
        }
        const legacy = await db
          .selectFrom("artifacts")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (legacy === undefined) {
          const strictOwner = await db
            .selectFrom("artifacts_v2")
            .select("run_id")
            .where("digest", "=", input.digest)
            .executeTakeFirst();
          const legacyOwner = await db
            .selectFrom("artifacts")
            .select("run_id")
            .where("digest", "=", input.digest)
            .executeTakeFirst();
          if (strictOwner !== undefined || legacyOwner !== undefined)
            throw new Error("artifact_access_denied");
          return null;
        }
        const bytes = await legacyBytes(db, byteDriver, input.digest);
        if (bytes === null || bytes.byteLength !== legacy.size)
          throw new Error(`artifact_corrupt: ${input.digest}`);
        return {
          artifact: artifactV2.parse({
            classification: legacy.classification,
            createdAt: "1970-01-01T00:00:00.000Z",
            digest: legacy.digest,
            kind: "metadata",
            mediaType: legacy.media_type,
            name: legacy.name,
            redaction: legacy.classification === "private" ? "raw-private" : "not-required",
            retention: "retained",
            runId: legacy.run_id,
            size: legacy.size,
          }),
          contentBase64: Buffer.from(bytes).toString("base64"),
        };
      },
      async materializeForAttemptV2(ctx, input) {
        if (!input.allowedDigests.includes(input.digest)) throw new Error("artifact_access_denied");
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const strict = await db
          .selectFrom("artifacts_v2")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (strict !== undefined) {
          const bytes = await strictBytes(db, byteDriver, input.digest);
          if (bytes === null || bytes.byteLength !== strict.size)
            throw new Error(`artifact_corrupt: ${input.digest}`);
          return {
            artifact: artifactV2FromRow(strict),
            contentBase64: Buffer.from(bytes).toString("base64"),
          };
        }
        const legacy = await db
          .selectFrom("artifacts")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("run_id", "=", input.runId)
          .executeTakeFirst();
        if (legacy === undefined) {
          const strictOwner = await db
            .selectFrom("artifacts_v2")
            .select("run_id")
            .where("digest", "=", input.digest)
            .executeTakeFirst();
          const legacyOwner = await db
            .selectFrom("artifacts")
            .select("run_id")
            .where("digest", "=", input.digest)
            .executeTakeFirst();
          if (strictOwner !== undefined || legacyOwner !== undefined)
            throw new Error("artifact_access_denied");
          throw new Error("artifact_not_found");
        }
        const bytes = await legacyBytes(db, byteDriver, input.digest);
        if (bytes === null || bytes.byteLength !== legacy.size)
          throw new Error(`artifact_corrupt: ${input.digest}`);
        return {
          artifact: artifactV2.parse({
            classification: legacy.classification,
            createdAt: "1970-01-01T00:00:00.000Z",
            digest: legacy.digest,
            kind: "metadata",
            mediaType: legacy.media_type,
            name: legacy.name,
            redaction: legacy.classification === "private" ? "raw-private" : "not-required",
            retention: "retained",
            runId: legacy.run_id,
            size: legacy.size,
          }),
          contentBase64: Buffer.from(bytes).toString("base64"),
        };
      },
      async listRunArtifactsV2(ctx, input) {
        const rows = await (ctx.db.kysely() as unknown as Kysely<AssetsDatabase>)
          .selectFrom("artifacts_v2")
          .selectAll()
          .where("run_id", "=", input.runId)
          .orderBy("digest")
          .execute();
        return rows.map(artifactV2FromRow);
      },
      async publishArtifactV2(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<AssetsDatabase>;
        const source = await db
          .selectFrom("artifacts_v2")
          .selectAll()
          .where("digest", "=", input.digest)
          .where("run_id", "=", input.runId)
          .where("attempt_id", "=", input.attemptId)
          .where("classification", "=", "private")
          .executeTakeFirst();
        if (source === undefined) throw new Error("artifact_access_denied");
        const raw = await strictBytes(db, byteDriver, source.digest);
        if (raw === null || raw.byteLength !== source.size)
          throw new Error(`artifact_corrupt: ${source.digest}`);
        const scanned = redactPublicText(raw);
        const redacted = Buffer.from(scanned).equals(raw)
          ? Buffer.concat([Buffer.from(scanned), Buffer.from("\n")])
          : Buffer.from(scanned);
        const digest = `sha256:${createHash("sha256").update(redacted).digest("hex")}`;
        const metadata = artifactV2.parse({
          attemptId: input.attemptId,
          classification: "public",
          createdAt: input.createdAt,
          digest,
          kind: source.kind,
          mediaType: source.media_type,
          name: source.name,
          redaction: "redacted-public",
          retention: "retained",
          runId: input.runId,
          size: redacted.byteLength,
          sourceDigest: source.digest,
        });
        await byteDriver.put(digest, redacted);
        const contentBase64 = Buffer.from(redacted).toString("base64");
        await db
          .insertInto("artifact_blobs_v2")
          .values({ content_base64: contentBase64, digest })
          .onConflict((conflict) => conflict.column("digest").doNothing())
          .execute();
        const recordId = artifactRecordId(metadata);
        const existing = await db
          .selectFrom("artifacts_v2")
          .select("record_id")
          .where("record_id", "=", recordId)
          .executeTakeFirst();
        if (existing === undefined) {
          await db
            .insertInto("artifacts_v2")
            .values({
              attempt_id: metadata.attemptId ?? null,
              classification: metadata.classification,
              created_at: metadata.createdAt,
              digest: metadata.digest,
              kind: metadata.kind,
              media_type: metadata.mediaType,
              name: metadata.name,
              record_id: recordId,
              redaction: metadata.redaction,
              retention: metadata.retention,
              run_id: metadata.runId,
              size: metadata.size,
              source_digest: metadata.sourceDigest ?? null,
            })
            .execute();
          ctx.publish(assets.events.artifactStoredV2, metadata);
        }
        return {
          artifact: metadata,
          contentBase64,
        };
      },
    },
  });
}

export const assetsImplementation = createAssetsImplementation();
