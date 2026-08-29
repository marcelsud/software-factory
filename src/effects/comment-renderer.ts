import type { ArtifactV2 } from "../contracts/index.ts";

export interface PublicCommentArtifact {
  readonly artifact: ArtifactV2;
  readonly contentBase64: string;
}

const FORBIDDEN_PUBLIC_TEXT =
  /(?:authorization:\s*bearer|api[_ -]?key|access[_ -]?token|password\s*[:=]|private[_ -]?key|raw private log|hidden reasoning|chain[- ]of[- ]thought)/i;
const EFFECT_MARKER = /<!-- software-factory:effect:([^\s>]+) -->/;

export function effectMarker(idempotencyKey: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new Error("invalid effect marker key");
  return `<!-- software-factory:effect:${idempotencyKey} -->`;
}

export function extractFactoryEffectMarker(body: string): string | null {
  return EFFECT_MARKER.exec(body)?.[1] ?? null;
}

export function renderPublicArtifactComment(input: {
  readonly artifacts: readonly PublicCommentArtifact[];
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly stepId: string;
}): string {
  const sections: string[] = [];
  for (const envelope of [...input.artifacts].sort((left, right) =>
    left.artifact.digest.localeCompare(right.artifact.digest),
  )) {
    const artifact = envelope.artifact;
    if (
      artifact.classification !== "public" ||
      artifact.redaction !== "redacted-public" ||
      artifact.kind === "log"
    )
      throw new Error("artifact_not_publishable: comments require redacted public artifacts");
    const content = Buffer.from(envelope.contentBase64, "base64").toString("utf8");
    if (Buffer.from(content, "utf8").toString("base64") !== envelope.contentBase64)
      throw new Error("artifact_not_publishable: comment artifact is not canonical UTF-8");
    if (FORBIDDEN_PUBLIC_TEXT.test(content))
      throw new Error("artifact_not_publishable: sensitive or hidden content detected");
    sections.push(
      `### [${escapeMarkdown(artifact.name)}](artifact://${encodeURIComponent(artifact.digest)})\n\n${content.trim()}`,
    );
  }
  if (sections.length === 0)
    throw new Error("artifact_not_publishable: a public artifact is required");
  return [
    effectMarker(input.idempotencyKey),
    `Factory run \`${escapeMarkdown(input.runId)}\`, step \`${escapeMarkdown(input.stepId)}\`.`,
    ...sections,
  ].join("\n\n");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("]", "\\]");
}
