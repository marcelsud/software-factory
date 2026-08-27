import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import {
  artifact,
  artifactV2,
  pinnedSkillBundle,
  pinnedSkillBundleV2,
  skillRevision,
  skillRevisionV2,
} from "../../contracts/index.ts";
import type { AssetsDatabase } from "../../storage/assets-database.ts";

const artifactEnvelope = v.object({ artifact, contentBase64: v.string() });
const artifactEnvelopeV2 = v.object({ artifact: artifactV2, contentBase64: v.string() });

const calls = {
  resolveSkill: {
    input: v.object({ reference: v.string(), revision: v.string() }),
    output: skillRevision,
    errors: ["module_unavailable", "skill_not_found", "skill_root_escape"],
    guarantees: ["returns an immutable digest-pinned skill revision"],
  },
  putSkillBundle: {
    input: v.object({ bundle: pinnedSkillBundle, reference: v.string() }),
    output: pinnedSkillBundle,
    errors: ["module_unavailable", "digest_mismatch", "skill_conflict"],
    guarantees: ["stores immutable canonical skill instructions and files by digest"],
  },
  getSkillBundle: {
    input: v.object({ digest: v.string() }),
    output: pinnedSkillBundle.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns only the exact immutable pinned skill bundle"],
  },
  resolveSkillV2: {
    input: v.object({ digest: v.string(), id: v.string() }),
    output: pinnedSkillBundleV2,
    errors: ["module_unavailable", "skill_not_found", "skill_conflict"],
    guarantees: ["returns exactly the stored immutable bundle selected by id and digest"],
  },
  storeSkillBundleV2: {
    input: v.object({ bundle: pinnedSkillBundleV2, source: v.string() }),
    output: skillRevisionV2,
    errors: ["module_unavailable", "digest_mismatch", "skill_conflict"],
    guarantees: ["verifies and stores a complete canonical data-only skill bundle by digest"],
  },
  verifySkillBundleV2: {
    input: v.object({ bundle: pinnedSkillBundleV2 }),
    output: pinnedSkillBundleV2,
    errors: ["digest_mismatch", "invalid_skill_bundle"],
    guarantees: ["rejects any bundle whose canonical files do not match its digest"],
  },
  getSkillBundleV2: {
    input: v.object({ digest: v.string() }),
    output: pinnedSkillBundleV2.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns only an exact verified immutable bundle"],
  },
  listSkillRevisionsV2: {
    input: v.object({ id: v.string().optional() }),
    output: skillRevisionV2.array(),
    errors: ["module_unavailable"],
    guarantees: ["lists immutable revisions in stable id and digest order"],
  },
  putArtifact: {
    input: artifactEnvelope,
    output: artifact,
    errors: ["module_unavailable", "artifact_too_large", "digest_mismatch"],
    guarantees: ["artifact bytes are immutable under their digest"],
  },
  getArtifact: {
    input: v.object({ digest: v.string() }),
    output: artifactEnvelope.nullable(),
    errors: ["module_unavailable"],
    guarantees: ["returns bytes only for the exact requested digest"],
  },
  materializeArtifact: {
    input: v.object({ destination: v.string(), digest: v.string() }),
    output: artifact,
    errors: ["module_unavailable", "artifact_not_found", "invalid_destination"],
    guarantees: ["materializes only within the trusted composition-selected destination"],
  },
  listRunArtifacts: {
    input: v.object({ runId: v.string() }),
    output: artifact.array(),
    errors: ["module_unavailable"],
    guarantees: ["returns immutable artifact metadata ordered by digest"],
  },
  storeArtifactV2: {
    input: artifactEnvelopeV2,
    output: artifactV2,
    errors: ["module_unavailable", "artifact_too_large", "digest_mismatch", "artifact_conflict"],
    guarantees: ["stores bytes through the private driver before committing immutable metadata"],
  },
  getArtifactV2: {
    input: v.object({
      allowedDigests: v.string().array(),
      attemptId: v.string(),
      digest: v.string(),
      runId: v.string(),
    }),
    output: artifactEnvelopeV2.nullable(),
    errors: ["module_unavailable", "artifact_access_denied", "artifact_corrupt"],
    guarantees: ["returns bytes only to the owning run and an explicitly authorized attempt edge"],
  },
  materializeForAttemptV2: {
    input: v.object({
      allowedDigests: v.string().array(),
      attemptId: v.string(),
      digest: v.string(),
      runId: v.string(),
    }),
    output: artifactEnvelopeV2,
    errors: [
      "module_unavailable",
      "artifact_not_found",
      "artifact_access_denied",
      "artifact_corrupt",
    ],
    guarantees: ["materializes bytes in-memory only for the owning run and declared flow edge"],
  },
  listRunArtifactsV2: {
    input: v.object({ runId: v.string() }),
    output: artifactV2.array(),
    errors: ["module_unavailable"],
    guarantees: ["returns run-owned strict artifact metadata in stable digest order"],
  },
  getPublicArtifactV2: {
    input: v.object({ digest: v.string() }),
    output: artifactEnvelopeV2.nullable(),
    errors: ["module_unavailable", "artifact_corrupt"],
    guarantees: ["returns bytes only for an explicitly public immutable artifact"],
  },
  publishArtifactV2: {
    input: v.object({
      attemptId: v.string(),
      createdAt: v.string(),
      digest: v.string(),
      runId: v.string(),
    }),
    output: artifactEnvelopeV2,
    errors: [
      "module_unavailable",
      "artifact_not_found",
      "artifact_access_denied",
      "artifact_not_publishable",
      "artifact_too_large",
    ],
    guarantees: ["publishes only a separately addressed bounded UTF-8 redacted artifact"],
  },
} as const;

const events = {
  skillRevisionPinnedV1: { name: "skillRevisionPinned", payload: skillRevision, version: 1 },
  artifactStoredV1: { name: "artifactStored", payload: artifact, version: 1 },
  skillRevisionPinnedV2: { name: "skillRevisionPinned", payload: skillRevisionV2, version: 2 },
  artifactStoredV2: { name: "artifactStored", payload: artifactV2, version: 2 },
} as const;

export const assets = defineChimpbaseModuleInterface<AssetsDatabase, typeof calls, typeof events>({
  calls,
  events,
  name: "assets",
  version: 1,
});
