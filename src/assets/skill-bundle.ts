import { createHash } from "node:crypto";

import { parseDocument } from "yaml";

import { canonicalSkillBundleDigest } from "../contracts/skill-bundle.ts";
import { type PinnedSkillBundleV2, pinnedSkillBundleV2 } from "../contracts/validators.ts";

const MANIFEST_KEYS = [
  "capabilities",
  "compatibility",
  "customizable",
  "id",
  "includes",
  "inputArtifacts",
  "instruction",
  "resultSchema",
  "version",
] as const;
const CAPABILITIES = new Set(["process.test", "repository.patch", "repository.read"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function manifestFromBytes(bytes: Uint8Array): Record<string, unknown> {
  const document = parseDocument(Buffer.from(bytes).toString("utf8"), {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) throw new Error(`invalid_skill_bundle: ${problems[0]?.message}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_skill_bundle: skill.yaml must be a mapping");
  const manifest = value as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key as (typeof MANIFEST_KEYS)[number]))
      throw new Error(`invalid_skill_bundle: unknown manifest key ${key}`);
  }
  return manifest;
}

export function assertVerifiedSkillBundle(value: unknown): PinnedSkillBundleV2 {
  const bundle = pinnedSkillBundleV2.parse(value);
  if (
    bundle.version !== 1 ||
    bundle.compatibility !== 1 ||
    bundle.resultSchema.additionalProperties ||
    bundle.files.length === 0 ||
    bundle.files.length > 64 ||
    new Set(bundle.capabilities).size !== bundle.capabilities.length ||
    bundle.capabilities.some((capability) => !CAPABILITIES.has(capability))
  )
    throw new Error("invalid_skill_bundle");
  if (canonicalSkillBundleDigest(bundle) !== bundle.digest) throw new Error("digest_mismatch");

  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (
      file.kind !== "skill" ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..") ||
      paths.has(file.path) ||
      file.contentBase64 === undefined
    )
      throw new Error(`invalid_skill_bundle: unsafe, duplicate, or incomplete path ${file.path}`);
    paths.add(file.path);
    const bytes = Buffer.from(file.contentBase64, "base64");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (
      bytes.toString("base64") !== file.contentBase64 ||
      bytes.byteLength !== file.size ||
      digest !== file.digest
    )
      throw new Error(`invalid_skill_bundle: file integrity mismatch ${file.path}`);
  }

  const manifestFile = bundle.files.find((file) => file.path === "skill.yaml");
  if (manifestFile?.contentBase64 === undefined)
    throw new Error("invalid_skill_bundle: skill.yaml is missing");
  const manifest = manifestFromBytes(Buffer.from(manifestFile.contentBase64, "base64"));
  const expected = {
    capabilities: [...bundle.capabilities].sort(),
    compatibility: bundle.compatibility,
    customizable: bundle.customizable,
    id: bundle.id,
    inputArtifacts: [...bundle.inputArtifactKinds].sort(),
    instruction: bundle.instructionPath,
    resultSchema: bundle.resultSchema,
    version: bundle.version,
  };
  const actual = {
    capabilities: Array.isArray(manifest.capabilities)
      ? [...manifest.capabilities].sort()
      : manifest.capabilities,
    compatibility: manifest.compatibility,
    customizable: manifest.customizable,
    id: manifest.id,
    inputArtifacts: Array.isArray(manifest.inputArtifacts)
      ? [...manifest.inputArtifacts].sort()
      : manifest.inputArtifacts,
    instruction: manifest.instruction,
    resultSchema: manifest.resultSchema,
    version: manifest.version,
  };
  if (canonical(actual) !== canonical(expected))
    throw new Error("invalid_skill_bundle: metadata does not match pinned skill.yaml");
  if (!Array.isArray(manifest.includes))
    throw new Error("invalid_skill_bundle: includes must be a list");
  for (const include of manifest.includes) {
    if (typeof include !== "string" || !paths.has(include))
      throw new Error(`invalid_skill_bundle: missing declared include ${String(include)}`);
  }
  const instruction = bundle.files.find((file) => file.path === bundle.instructionPath);
  if (
    instruction?.contentBase64 === undefined ||
    Buffer.from(instruction.contentBase64, "base64").toString("utf8") !== bundle.instructions
  )
    throw new Error("invalid_skill_bundle: instructions do not match pinned entry");
  return bundle;
}
