import { createHash } from "node:crypto";

import type { PinnedSkillBundleV2, SkillResultSchema } from "./validators.ts";

export function validateSkillResult(schema: SkillResultSchema, value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("result_schema_mismatch: report must be an object");
  const report = value as Record<string, unknown>;
  for (const required of schema.required) {
    if (!Object.hasOwn(report, required))
      throw new Error(`result_schema_mismatch: missing ${required}`);
  }
  for (const [key, fieldValue] of Object.entries(report)) {
    const field = schema.properties[key];
    if (field === undefined) throw new Error(`result_schema_mismatch: unknown ${key}`);
    const valid =
      field.type === "string-array"
        ? Array.isArray(fieldValue) && fieldValue.every((entry) => typeof entry === "string")
        : typeof fieldValue === field.type;
    if (!valid) throw new Error(`result_schema_mismatch: invalid ${key}`);
  }
}

export function canonicalSkillBundleDigest(bundle: Pick<PinnedSkillBundleV2, "files">): string {
  const canonical = [...bundle.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ contentBase64, path }) => [path, contentBase64 ?? ""]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}
