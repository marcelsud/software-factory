import { canonicalJson } from "../compiler.ts";

const MAX_ID_LENGTH = 256;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE_LENGTH = 512;
export const RUN_ONCE_MAX_EVENT_BYTES = 256 * 1024;
export const RUN_ONCE_MAX_OUTPUT_BYTES = 256 * 1024;
export const RUN_ONCE_MAX_OUTPUT_ITEMS = 100;

export type GitHubInvocationEvent =
  | {
      readonly action: "closed" | "edited" | "labeled" | "opened" | "reopened" | "unlabeled";
      readonly name: "issues";
    }
  | { readonly action: "created" | "edited"; readonly name: "issue_comment" };

export interface RunOnceInvocationEnvelope {
  readonly actor: { readonly login: string; readonly type: "bot" | "unknown" | "user" };
  readonly context: Readonly<Record<string, string>>;
  readonly correlationId: string;
  readonly definitionRevision: string;
  readonly deliveryId: string;
  readonly event: GitHubInvocationEvent;
  readonly installation: { readonly id: string } | null;
  readonly observedAt: string;
  readonly payload: unknown;
  readonly repository: { readonly fullName: string; readonly id: string };
  readonly schemaVersion: 1;
  readonly source: "github-actions" | "github-webhook";
  readonly subject: { readonly id: string; readonly number: number };
}

export type RunOnceResultClass =
  | "completed"
  | "waiting"
  | "no-match"
  | "retryable-infrastructure-failure"
  | "policy-rejection"
  | "terminal-failure";

export const RUN_ONCE_EXIT_CODES: Readonly<Record<RunOnceResultClass, number>> = {
  completed: 0,
  waiting: 0,
  "no-match": 0,
  "retryable-infrastructure-failure": 75,
  "policy-rejection": 77,
  "terminal-failure": 1,
};

export interface RunOnceArtifactReference {
  readonly digest: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly name: string;
  readonly reference: string;
  readonly runId: string;
  readonly size: number;
}

export interface RunOnceEffectReceipt {
  readonly externalId: string | null;
  readonly externalRevision: string | null;
  readonly externalUrl: string | null;
  readonly failureCategory: string | null;
  readonly idempotencyKey: string;
  readonly outcome: string | null;
  readonly runId: string;
  readonly status: "finished" | "queued";
}

export interface RunOnceResult {
  readonly artifacts: readonly RunOnceArtifactReference[];
  readonly concurrencyKey: string;
  readonly effectIntents: readonly Readonly<Record<string, unknown>>[];
  readonly effectReceipts: readonly RunOnceEffectReceipt[];
  readonly exitCode: number;
  readonly invocation: {
    readonly correlationId: string;
    readonly definitionRevision: string;
    readonly deliveryId: string;
    readonly event: GitHubInvocationEvent;
    readonly repository: string;
    readonly source: RunOnceInvocationEnvelope["source"];
    readonly subject: string;
  };
  readonly outcome: string | null;
  readonly pending: {
    readonly effects: readonly Readonly<Record<string, string>>[];
    readonly gates: readonly Readonly<Record<string, string>>[];
    readonly retries: readonly Readonly<Record<string, string>>[];
  };
  readonly resultClass: RunOnceResultClass;
  readonly runIds: readonly string[];
  readonly schemaVersion: 1;
  readonly transitions: readonly Readonly<Record<string, unknown>>[];
  readonly truncation: {
    readonly artifactsOmitted: number;
    readonly bytes: number;
    readonly effectsOmitted: number;
    readonly receiptsOmitted: number;
    readonly runsOmitted: number;
    readonly transitionsOmitted: number;
    readonly truncated: boolean;
  };
}

export function parseRunOnceInvocationEnvelope(value: unknown): RunOnceInvocationEnvelope {
  const input = strictRecord(value, "invocation", [
    "actor",
    "context",
    "correlationId",
    "definitionRevision",
    "deliveryId",
    "event",
    "installation",
    "observedAt",
    "payload",
    "repository",
    "schemaVersion",
    "source",
    "subject",
  ]);
  if (input.schemaVersion !== 1) invalid("schemaVersion must be 1");
  if (input.source !== "github-actions" && input.source !== "github-webhook")
    invalid("source must be github-actions or github-webhook");
  const repository = strictRecord(input.repository, "repository", ["fullName", "id"]);
  const repositoryId = boundedId(repository.id, "repository.id");
  const fullName = boundedString(repository.fullName, "repository.fullName", MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName))
    invalid("repository.fullName must be owner/name");
  const subject = strictRecord(input.subject, "subject", ["id", "number"]);
  const subjectId = boundedId(subject.id, "subject.id");
  if (!Number.isSafeInteger(subject.number) || Number(subject.number) < 1)
    invalid("subject.number must be a positive safe integer");
  const actor = strictRecord(input.actor, "actor", ["login", "type"]);
  const actorLogin = boundedId(actor.login, "actor.login");
  if (actor.type !== "bot" && actor.type !== "unknown" && actor.type !== "user")
    invalid("actor.type is invalid");
  const event = parseEvent(input.event);
  const installation =
    input.installation === null
      ? null
      : (() => {
          const record = strictRecord(input.installation, "installation", ["id"]);
          return { id: boundedId(record.id, "installation.id") };
        })();
  const context = strictRecord(input.context, "context", [
    "job",
    "ref",
    "runAttempt",
    "runId",
    "sha",
    "workflow",
  ]);
  if (Object.keys(context).length > MAX_METADATA_ENTRIES) invalid("context has too many entries");
  const normalizedContext = Object.fromEntries(
    Object.entries(context).map(([key, entry]) => [
      key,
      boundedString(entry, `context.${key}`, MAX_METADATA_VALUE_LENGTH),
    ]),
  );
  const observedAt = isoTimestamp(input.observedAt, "observedAt");
  const definitionRevision = boundedString(
    input.definitionRevision,
    "definitionRevision",
    MAX_ID_LENGTH,
  );
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(definitionRevision))
    invalid("definitionRevision must be a SHA-256 digest");
  assertJsonData(input.payload, "payload", new Set<object>());
  const payloadBytes = Buffer.byteLength(canonicalJson(input.payload));
  if (payloadBytes > RUN_ONCE_MAX_EVENT_BYTES)
    invalid(`payload exceeds ${RUN_ONCE_MAX_EVENT_BYTES} bytes`);
  validatePayloadIdentity(input.payload, event, fullName, subjectId, Number(subject.number));
  return {
    actor: { login: actorLogin, type: actor.type },
    context: normalizedContext,
    correlationId: boundedId(input.correlationId, "correlationId"),
    definitionRevision,
    deliveryId: boundedId(input.deliveryId, "deliveryId"),
    event,
    installation,
    observedAt,
    payload: input.payload,
    repository: { fullName, id: repositoryId },
    schemaVersion: 1,
    source: input.source,
    subject: { id: subjectId, number: Number(subject.number) },
  };
}

export function parseRunOnceResult(value: unknown): RunOnceResult {
  const result = strictRecord(value, "result", [
    "artifacts",
    "concurrencyKey",
    "effectIntents",
    "effectReceipts",
    "exitCode",
    "invocation",
    "outcome",
    "pending",
    "resultClass",
    "runIds",
    "schemaVersion",
    "transitions",
    "truncation",
  ]);
  if (result.schemaVersion !== 1) invalid("result.schemaVersion must be 1");
  if (!isResultClass(result.resultClass)) invalid("result.resultClass is invalid");
  if (result.exitCode !== RUN_ONCE_EXIT_CODES[result.resultClass])
    invalid("result.exitCode does not match resultClass");
  assertJsonData(value, "result", new Set<object>());
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > RUN_ONCE_MAX_OUTPUT_BYTES)
    invalid(`result exceeds ${RUN_ONCE_MAX_OUTPUT_BYTES} bytes`);
  for (const key of ["artifacts", "effectIntents", "effectReceipts", "runIds", "transitions"])
    if (!Array.isArray(result[key]) || result[key].length > RUN_ONCE_MAX_OUTPUT_ITEMS)
      invalid(`result.${key} must be a bounded array`);
  validateResultShape(result);
  if (containsSensitiveKey(value)) invalid("result contains a sensitive field");
  return value as RunOnceResult;
}

export function factoryConcurrencyKey(repository: string, subject: string, flowId: string): string {
  return [
    boundedId(repository, "repository"),
    boundedId(subject, "subject"),
    boundedId(flowId, "flowId"),
  ]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseEvent(value: unknown): GitHubInvocationEvent {
  const event = strictRecord(value, "event", ["action", "name"]);
  if (event.name === "issues") {
    if (
      !["closed", "edited", "labeled", "opened", "reopened", "unlabeled"].includes(
        String(event.action),
      )
    )
      invalid("event.action is invalid for issues");
    return {
      action: event.action as GitHubInvocationEvent["action"],
      name: "issues",
    } as GitHubInvocationEvent;
  }
  if (event.name === "issue_comment") {
    if (event.action !== "created" && event.action !== "edited")
      invalid("event.action is invalid for issue_comment");
    return { action: event.action, name: "issue_comment" };
  }
  return invalid("event.name must be issues or issue_comment");
}

function validatePayloadIdentity(
  value: unknown,
  event: GitHubInvocationEvent,
  repository: string,
  subjectId: string,
  subjectNumber: number,
): void {
  const payload = strictDataRecord(value, "payload");
  for (const forbidden of [
    "adapter",
    "adapters",
    "command",
    "commands",
    "credential",
    "credentials",
    "env",
    "environment",
    "plugin",
    "plugins",
    "runtime",
    "storage",
  ])
    if (forbidden in payload) invalid(`payload cannot configure ${forbidden}`);
  const payloadRepository = strictDataRecord(payload.repository, "payload.repository");
  if (payloadRepository.full_name !== repository)
    invalid("payload.repository.full_name does not match repository.fullName");
  const issue = strictDataRecord(payload.issue, "payload.issue");
  if (String(issue.id ?? issue.node_id ?? "") !== subjectId)
    invalid("payload.issue identity does not match subject.id");
  if (issue.number !== subjectNumber) invalid("payload.issue.number does not match subject.number");
  if (payload.action !== undefined && payload.action !== event.action)
    invalid("payload.action does not match event.action");
  if (event.name === "issue_comment" && payload.comment === undefined)
    invalid("issue_comment payload requires comment");
  if (event.name === "issues" && payload.comment !== undefined)
    invalid("issues payload cannot contain comment");
  if (event.name === "issues" && (event.action === "labeled" || event.action === "unlabeled")) {
    const label = strictRecord(payload.label, "payload.label", [
      "color",
      "default",
      "description",
      "id",
      "name",
      "node_id",
      "url",
    ]);
    boundedString(label.name, "payload.label.name", MAX_METADATA_VALUE_LENGTH);
  }
  isoTimestamp(issue.created_at, "payload.issue.created_at");
  isoTimestamp(issue.updated_at, "payload.issue.updated_at");
  if (event.name === "issue_comment") {
    const comment = strictDataRecord(payload.comment, "payload.comment");
    isoTimestamp(comment.created_at, "payload.comment.created_at");
    isoTimestamp(comment.updated_at, "payload.comment.updated_at");
  }
}

function validateResultShape(result: Record<string, unknown>): void {
  boundedString(result.concurrencyKey, "result.concurrencyKey", 1024);
  if (result.outcome !== null) boundedString(result.outcome, "result.outcome", 512);
  const invocation = strictRecord(result.invocation, "result.invocation", [
    "correlationId",
    "definitionRevision",
    "deliveryId",
    "event",
    "repository",
    "source",
    "subject",
  ]);
  boundedId(invocation.correlationId, "result.invocation.correlationId");
  boundedString(
    invocation.definitionRevision,
    "result.invocation.definitionRevision",
    MAX_ID_LENGTH,
  );
  boundedId(invocation.deliveryId, "result.invocation.deliveryId");
  parseEvent(invocation.event);
  boundedString(invocation.repository, "result.invocation.repository", MAX_ID_LENGTH);
  if (invocation.source !== "github-actions" && invocation.source !== "github-webhook")
    invalid("result.invocation.source is invalid");
  boundedId(invocation.subject, "result.invocation.subject");

  const pending = strictRecord(result.pending, "result.pending", ["effects", "gates", "retries"]);
  validateRecordArray(pending.effects, "result.pending.effects", [
    "idempotencyKey",
    "runId",
    "stepId",
  ]);
  validateRecordArray(pending.gates, "result.pending.gates", ["gateId", "runId", "status"]);
  validateRecordArray(pending.retries, "result.pending.retries", ["attemptId", "runId", "stepId"]);
  validateRecordArray(result.artifacts, "result.artifacts", [
    "digest",
    "kind",
    "mediaType",
    "name",
    "reference",
    "runId",
    "size",
  ]);
  validateRecordArray(result.effectReceipts, "result.effectReceipts", [
    "externalId",
    "externalRevision",
    "externalUrl",
    "failureCategory",
    "idempotencyKey",
    "outcome",
    "runId",
    "status",
  ]);
  validateRecordArray(
    result.effectIntents,
    "result.effectIntents",
    ["capability", "idempotencyKey", "kind", "runId", "stepId", "target"],
    ["idempotencyKey", "kind", "runId"],
  );
  validateRecordArray(result.transitions, "result.transitions", [
    "auditSequence",
    "outcome",
    "runId",
    "stateId",
    "status",
  ]);
  if (!Array.isArray(result.runIds)) invalid("result.runIds must be an array");
  for (const [index, runId] of result.runIds.entries()) boundedId(runId, `result.runIds[${index}]`);
  const truncation = strictRecord(result.truncation, "result.truncation", [
    "artifactsOmitted",
    "bytes",
    "effectsOmitted",
    "receiptsOmitted",
    "runsOmitted",
    "transitionsOmitted",
    "truncated",
  ]);
  for (const key of [
    "artifactsOmitted",
    "bytes",
    "effectsOmitted",
    "receiptsOmitted",
    "runsOmitted",
    "transitionsOmitted",
  ])
    if (!Number.isSafeInteger(truncation[key]) || Number(truncation[key]) < 0)
      invalid(`result.truncation.${key} must be a non-negative safe integer`);
  if (typeof truncation.truncated !== "boolean")
    invalid("result.truncation.truncated must be boolean");
}

function validateRecordArray(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): void {
  if (!Array.isArray(value) || value.length > RUN_ONCE_MAX_OUTPUT_ITEMS)
    invalid(`${path} must be a bounded array`);
  for (const [index, entry] of value.entries()) {
    const record = strictRecord(entry, `${path}[${index}]`, allowedKeys);
    for (const key of requiredKeys)
      if (!(key in record)) invalid(`${path}[${index}] is missing ${key}`);
    for (const [key, field] of Object.entries(record)) {
      if (key === "auditSequence" || key === "size") {
        if (!Number.isSafeInteger(field) || Number(field) < 0)
          invalid(`${path}[${index}].${key} must be a non-negative safe integer`);
      } else if (
        ["externalId", "externalRevision", "externalUrl", "failureCategory", "outcome"].includes(
          key,
        )
      ) {
        if (field !== null && (typeof field !== "string" || field.length > 512))
          invalid(`${path}[${index}].${key} must be null or a bounded string`);
      } else if (typeof field !== "string" || field.length < 1 || field.length > 1024) {
        invalid(`${path}[${index}].${key} must be a bounded string`);
      }
    }
  }
}
function assertJsonData(value: unknown, path: string, stack: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object") invalid(`${path} must contain JSON data only`);
  if (stack.has(value)) invalid(`${path} cannot contain a cycle`);
  stack.add(value);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertJsonData(entry, `${path}[${index}]`, stack);
  } else {
    const record = strictDataRecord(value, path);
    for (const [key, entry] of Object.entries(record))
      assertJsonData(entry, `${path}.${key}`, stack);
  }
  stack.delete(value);
}

function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = strictDataRecord(value, path);
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) invalid(`${path} has unknown key ${unknown.sort()[0]}`);
  return record;
}

function strictDataRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be data-only`);
  return value as Record<string, unknown>;
}

function boundedId(value: unknown, path: string): string {
  const result = boundedString(value, path, MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(result)) invalid(`${path} has invalid characters`);
  return result;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    invalid(`${path} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

function isoTimestamp(value: unknown, path: string): string {
  const timestamp = boundedString(value, path, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    invalid(`${path} must be an ISO-8601 UTC timestamp`);
  return new Date(timestamp).toISOString();
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      /(?:credential|password|private(?:Log|Bytes|Artifact)?|prompt|reasoning|secret|token)/i.test(
        key,
      ) || containsSensitiveKey(entry),
  );
}

function isResultClass(value: unknown): value is RunOnceResultClass {
  return [
    "completed",
    "waiting",
    "no-match",
    "retryable-infrastructure-failure",
    "policy-rejection",
    "terminal-failure",
  ].includes(String(value));
}

function invalid(message: string): never {
  throw new Error(`run_once_invalid: ${message}`);
}
