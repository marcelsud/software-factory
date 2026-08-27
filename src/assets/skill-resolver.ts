import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import type { PinnedSkillBundleV2, SkillResultSchema } from "../contracts/index.ts";

const ID = /^[a-z][a-z0-9._-]*$/u;
const RESULT_PROPERTY = /^[a-z][A-Za-z0-9._-]*$/u;
const INCLUDE_DIRECTIVE = /\{\{include:([^}]+)\}\}/gu;
const ALLOWED_CAPABILITIES = new Set(["process.test", "repository.patch", "repository.read"]);
const ALLOWED_ARTIFACT_KINDS = new Set([
  "log",
  "metadata",
  "patch",
  "report.md",
  "reproduction",
  "result.json",
  "test-result",
]);
const ALLOWED_PROPERTY_TYPES = new Set(["boolean", "number", "string", "string-array"]);
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
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 64;

type DataRecord = Record<string, unknown>;

export interface SkillInspection {
  readonly capabilities: readonly string[];
  readonly compatibility: number;
  readonly customizable: boolean;
  readonly digest: string;
  readonly files: readonly {
    readonly digest: string;
    readonly path: string;
    readonly size: number;
  }[];
  readonly id: string;
  readonly inputArtifactKinds: readonly string[];
  readonly resultSchema: SkillResultSchema;
  readonly sourcePath: string;
  readonly version: number;
}

export interface ResolvedSkill {
  readonly bundle: PinnedSkillBundleV2;
  readonly inspection: SkillInspection;
}

export interface SkillResolverOptions {
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly roots: readonly string[];
}

interface SkillManifest {
  readonly capabilities: readonly string[];
  readonly compatibility: 1;
  readonly customizable: boolean;
  readonly id: string;
  readonly includes: readonly string[];
  readonly inputArtifacts: readonly string[];
  readonly instruction: string;
  readonly resultSchema: SkillResultSchema;
  readonly version: 1;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function dataRecord(value: unknown, path: string, allowed: readonly string[]): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid_manifest: ${path} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown_manifest_key: ${path}.${key}`);
  }
  return value as DataRecord;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid_manifest: ${path} must be a non-empty string`);
  return value;
}

function uniqueStringList(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  )
    throw new Error(`invalid_manifest: ${path} must be a string list`);
  const result = [...value] as string[];
  if (new Set(result).size !== result.length) throw new Error(`duplicate_manifest_value: ${path}`);
  return result;
}

function parseYaml(bytes: Uint8Array, path: string): unknown {
  const document = parseDocument(Buffer.from(bytes).toString("utf8"), {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0)
    throw new Error(`invalid_manifest_yaml: ${path}: ${problems[0]?.message}`);
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(
      `invalid_manifest_yaml: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resultSchema(value: unknown): SkillResultSchema {
  const record = dataRecord(value, "resultSchema", [
    "additionalProperties",
    "properties",
    "required",
    "type",
  ]);
  if (record.type !== "object" || record.additionalProperties !== false)
    throw new Error("invalid_result_schema: only closed object schemas are supported");
  if (
    record.properties === null ||
    typeof record.properties !== "object" ||
    Array.isArray(record.properties)
  )
    throw new Error("invalid_result_schema: properties must be a mapping");
  const properties = dataRecord(
    record.properties,
    "resultSchema.properties",
    Object.keys(record.properties),
  );
  const parsedProperties: Record<
    string,
    { readonly type: "boolean" | "number" | "string" | "string-array" }
  > = {};
  for (const [name, property] of Object.entries(properties)) {
    if (!RESULT_PROPERTY.test(name))
      throw new Error(`invalid_result_schema: invalid property ${name}`);
    const field = dataRecord(property, `resultSchema.properties.${name}`, ["type"]);
    if (typeof field.type !== "string" || !ALLOWED_PROPERTY_TYPES.has(field.type))
      throw new Error(`invalid_result_schema: unsupported type for ${name}`);
    parsedProperties[name] = {
      type: field.type as "boolean" | "number" | "string" | "string-array",
    };
  }
  const required = uniqueStringList(record.required, "resultSchema.required");
  if (required.some((name) => parsedProperties[name] === undefined))
    throw new Error("invalid_result_schema: required property is not declared");
  return { additionalProperties: false, properties: parsedProperties, required, type: "object" };
}

function manifest(bytes: Uint8Array): SkillManifest {
  const record = dataRecord(parseYaml(bytes, "skill.yaml"), "skill", MANIFEST_KEYS);
  if (record.version !== 1) throw new Error(`unsupported_skill_version: ${String(record.version)}`);
  if (record.compatibility !== 1)
    throw new Error(`incompatible_skill_version: ${String(record.compatibility)}`);
  const id = stringValue(record.id, "skill.id");
  if (!ID.test(id)) throw new Error(`invalid_skill_id: ${id}`);
  const capabilities = uniqueStringList(record.capabilities, "skill.capabilities").sort();
  for (const capability of capabilities) {
    if (!ALLOWED_CAPABILITIES.has(capability))
      throw new Error(`unknown_skill_capability: ${capability}`);
  }
  const inputArtifacts = uniqueStringList(record.inputArtifacts, "skill.inputArtifacts").sort();
  for (const kind of inputArtifacts) {
    if (!ALLOWED_ARTIFACT_KINDS.has(kind)) throw new Error(`unknown_artifact_kind: ${kind}`);
  }
  if (typeof record.customizable !== "boolean")
    throw new Error("invalid_manifest: skill.customizable must be boolean");
  return {
    capabilities,
    compatibility: 1,
    customizable: record.customizable,
    id,
    includes: uniqueStringList(record.includes, "skill.includes").sort(),
    inputArtifacts,
    instruction: stringValue(record.instruction, "skill.instruction"),
    resultSchema: resultSchema(record.resultSchema),
    version: 1,
  };
}

function safeRelativePath(path: string): string {
  if (isAbsolute(path) || path.includes("\\")) throw new Error(`skill_root_escape: ${path}`);
  const normalized = path
    .split("/")
    .filter((part) => part !== ".")
    .join("/");
  if (normalized.length === 0 || normalized.split("/").includes(".."))
    throw new Error(`skill_root_escape: ${path}`);
  return normalized;
}

function includeDirectives(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("utf8");
  return [...text.matchAll(INCLUDE_DIRECTIVE)].map((match) =>
    safeRelativePath(match[1]?.trim() ?? ""),
  );
}

export class SkillResolver {
  readonly #options: Required<Omit<SkillResolverOptions, "roots">> & {
    readonly roots: readonly string[];
  };

  constructor(options: SkillResolverOptions) {
    if (options.roots.length === 0) throw new Error("skill roots must not be empty");
    this.#options = {
      maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
      maxFiles: options.maxFiles ?? MAX_FILES,
      maxTotalBytes: options.maxTotalBytes ?? MAX_TOTAL_BYTES,
      roots: options.roots.map((root) => resolve(root)),
    };
  }

  async resolve(sourcePath: string): Promise<ResolvedSkill> {
    const trustedRoots = await Promise.all(
      this.#options.roots.map(async (root) => await realpath(root)),
    );
    const lexical = resolve(sourcePath);
    const directory = await realpath(lexical);
    if (directory !== lexical) throw new Error(`skill_symlink_forbidden: ${sourcePath}`);
    const trustedRoot = trustedRoots.find(
      (root) => directory === root || directory.startsWith(`${root}${sep}`),
    );
    if (trustedRoot === undefined) throw new Error(`skill_root_escape: ${sourcePath}`);
    const inside = relative(trustedRoot, directory);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new Error(`skill_root_escape: ${sourcePath}`);

    const files = new Map<string, Uint8Array>();
    let totalBytes = 0;
    const load = async (requested: string): Promise<Uint8Array> => {
      const path = safeRelativePath(requested);
      const existing = files.get(path);
      if (existing !== undefined) return existing;
      if (files.size >= this.#options.maxFiles) throw new Error("skill_too_large: too many files");
      const absolute = resolve(directory, path);
      if (!absolute.startsWith(`${directory}${sep}`))
        throw new Error(`skill_root_escape: ${requested}`);
      const status = await lstat(absolute);
      if (!status.isFile() || status.isSymbolicLink())
        throw new Error(`skill_symlink_forbidden: ${requested}`);
      const canonical = await realpath(absolute);
      if (canonical !== absolute) throw new Error(`skill_symlink_forbidden: ${requested}`);
      if (status.size > this.#options.maxFileBytes)
        throw new Error(`skill_file_too_large: ${requested}`);
      const bytes = await readFile(absolute);
      totalBytes += bytes.byteLength;
      if (totalBytes > this.#options.maxTotalBytes)
        throw new Error("skill_too_large: total bytes exceeded");
      files.set(path, bytes);
      return bytes;
    };

    const manifestBytes = await load("skill.yaml");
    const parsed = manifest(manifestBytes);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = async (path: string, declared: readonly string[]): Promise<void> => {
      const normalized = safeRelativePath(path);
      if (visiting.has(normalized)) throw new Error(`skill_include_cycle: ${normalized}`);
      if (visited.has(normalized)) return;
      visiting.add(normalized);
      const bytes = await load(normalized);
      const directives = includeDirectives(bytes);
      for (const directive of directives) {
        if (!declared.includes(directive))
          throw new Error(`undeclared_skill_include: ${directive}`);
      }
      if (normalized.endsWith(".include.yaml")) {
        const descriptor = dataRecord(parseYaml(bytes, normalized), normalized, ["includes"]);
        const includes = uniqueStringList(descriptor.includes, `${normalized}.includes`).sort();
        for (const include of includes) await visit(include, includes);
      }
      visiting.delete(normalized);
      visited.add(normalized);
    };
    await visit(parsed.instruction, parsed.includes);
    for (const include of parsed.includes) await visit(include, parsed.includes);

    const canonicalFiles = [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => ({
        contentBase64: Buffer.from(bytes).toString("base64"),
        digest: sha256(bytes),
        kind: "skill" as const,
        path,
        size: bytes.byteLength,
      }));
    const canonicalBytes = Buffer.from(
      JSON.stringify(canonicalFiles.map(({ contentBase64, path }) => [path, contentBase64])),
      "utf8",
    );
    const digest = sha256(canonicalBytes);
    const instructions = Buffer.from(await load(parsed.instruction)).toString("utf8");
    const bundle: PinnedSkillBundleV2 = {
      capabilities: [...parsed.capabilities],
      compatibility: parsed.compatibility,
      customizable: parsed.customizable,
      digest,
      files: canonicalFiles,
      id: parsed.id,
      inputArtifactKinds: [...parsed.inputArtifacts],
      instructionPath: parsed.instruction,
      instructions,
      resultSchema: parsed.resultSchema,
      version: parsed.version,
    };
    return {
      bundle,
      inspection: {
        capabilities: bundle.capabilities,
        compatibility: bundle.compatibility,
        customizable: bundle.customizable,
        digest,
        files: canonicalFiles.map(({ digest: fileDigest, path, size }) => ({
          digest: fileDigest,
          path,
          size,
        })),
        id: bundle.id,
        inputArtifactKinds: bundle.inputArtifactKinds,
        resultSchema: bundle.resultSchema,
        sourcePath: directory,
        version: bundle.version,
      },
    };
  }

  async resolveAll(sourcePaths: readonly string[]): Promise<ResolvedSkill[]> {
    const resolved: ResolvedSkill[] = [];
    const ids = new Set<string>();
    for (const sourcePath of sourcePaths) {
      const skill = await this.resolve(sourcePath);
      if (ids.has(skill.bundle.id)) throw new Error(`duplicate_skill_id: ${skill.bundle.id}`);
      ids.add(skill.bundle.id);
      resolved.push(skill);
    }
    return resolved;
  }
}
