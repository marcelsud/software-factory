import { defineChimpbaseModuleInterface } from "chimpbase/core";
import { v } from "chimpbase/runtime";

import { artifact, pinnedSkillBundle, skillRevision } from "../../contracts/index.ts";
import type { AssetsDatabase } from "../../storage/assets-database.ts";

const artifactEnvelope = v.object({ artifact, contentBase64: v.string() });

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
} as const;

const events = {
  skillRevisionPinnedV1: { name: "skillRevisionPinned", payload: skillRevision, version: 1 },
  artifactStoredV1: { name: "artifactStored", payload: artifact, version: 1 },
} as const;

export const assets = defineChimpbaseModuleInterface<AssetsDatabase, typeof calls, typeof events>({
  calls,
  events,
  name: "assets",
  version: 1,
});
