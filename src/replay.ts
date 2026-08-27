import { createHash } from "node:crypto";

import { canonicalJson } from "./compiler.ts";
import {
  containsSecret,
  type FactoryFailureCategory,
  type FactoryTelemetryAttributes,
  type FactoryTelemetryRecord,
  factoryTelemetryAttributes,
  type OperationsTelemetrySnapshot,
  type ReplayBundle,
  type ReplayEvent,
  type ReplayPins,
  type ReplayRedactionPolicy,
  type ReplayTransition,
  redactSecrets,
  replayBundle,
} from "./contracts/index.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DEFAULT_SECRET_MARKERS = ["<SECRET>", "SECRET_MARKER", "PRIVATE_REPORT"] as const;
const PUBLIC_LIMITS = { maxBytes: 1024 * 1024, maxItems: 10_000, maxStringBytes: 64 * 1024 };
const SAFE_PUBLIC_KEYS = new Set([
  "correlationId",
  "correlationToken",
  "currentCorrelationToken",
  "secretMarkers",
]);
const PRIVATE_KEY =
  /(?:credential|authorization|api.?key|password|private.?report|raw.?prompt|reasoning|secret|token)/iu;

type JsonObject = Record<string, unknown>;

export interface ReplayBundleInput {
  readonly artifactDigests: ReplayBundle["artifactDigests"];
  readonly capabilities?: readonly string[];
  readonly createdAt: string;
  readonly events: readonly ReplayEvent[];
  readonly fixtures?: Partial<ReplayBundle["fixtures"]>;
  readonly pins: ReplayPins;
  readonly redactionPolicy?: Partial<ReplayRedactionPolicy>;
  readonly resultDocuments?: ReplayBundle["resultDocuments"];
  readonly runId: string;
  readonly transitions?: readonly ReplayTransition[];
}

export interface TrustedReplayPins extends ReplayPins {
  readonly allowedCapabilities: readonly string[];
  readonly artifactBytes?: Readonly<Record<string, string | Uint8Array>>;
}

export interface ReplayExecutionResult {
  readonly bundleDigest: string;
  readonly effectIntents: readonly unknown[];
  readonly liveWrites: 0;
  readonly transitions: readonly ReplayTransition[];
}

export interface EvalFixture {
  readonly artifactDigests: readonly string[];
  readonly bundle: ReplayBundle;
  readonly expectedOutcome: string;
  readonly name: string;
  readonly runId: string;
  readonly skillDigest: string;
  readonly skillId: string;
  readonly stepId: string;
}

export interface EvalResult {
  readonly artifactDigests: readonly string[];
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly runId: string;
  readonly scores: {
    readonly capabilityInvariant: boolean;
    readonly earlyExit: boolean;
    readonly evidence: boolean;
    readonly schema: boolean;
    readonly testTrust: boolean;
  };
  readonly skillDigest: string;
  readonly skillId: string;
  readonly stepId: string;
}

export function sha256Digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function replayBundleDigest(value: Omit<ReplayBundle, "bundleDigest">): string {
  return sha256Digest(canonicalJson(value));
}

function plainObject(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid_replay_bundle: ${name} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: unknown, keys: readonly string[], name: string): void {
  const actual = Object.keys(plainObject(value, name)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`invalid_replay_bundle: ${name} contains unknown or missing fields`);
}

function normalizedPolicy(input: Partial<ReplayRedactionPolicy> = {}): ReplayRedactionPolicy {
  const policy: ReplayRedactionPolicy = {
    maxBytes: input.maxBytes ?? PUBLIC_LIMITS.maxBytes,
    maxItems: input.maxItems ?? PUBLIC_LIMITS.maxItems,
    maxStringBytes: input.maxStringBytes ?? PUBLIC_LIMITS.maxStringBytes,
    privateRetention: input.privateRetention ?? "ephemeral",
    secretMarkers: [...new Set(input.secretMarkers ?? [])].sort(),
  };
  if (
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 1 ||
    policy.maxBytes > PUBLIC_LIMITS.maxBytes ||
    !Number.isSafeInteger(policy.maxItems) ||
    policy.maxItems < 1 ||
    policy.maxItems > PUBLIC_LIMITS.maxItems ||
    !Number.isSafeInteger(policy.maxStringBytes) ||
    policy.maxStringBytes < 1 ||
    policy.maxStringBytes > PUBLIC_LIMITS.maxStringBytes
  )
    throw new Error("invalid_replay_bundle: redaction bounds exceed public limits");
  return policy;
}

interface RedactionCount {
  bytes: number;
  items: number;
  strings: number;
  truncated: boolean;
}

function redactValue(
  value: unknown,
  policy: ReplayRedactionPolicy,
  count: RedactionCount,
  key = "",
): unknown {
  if (PRIVATE_KEY.test(key) && !SAFE_PUBLIC_KEYS.has(key)) return "[REDACTED]";
  if (key === "secretMarkers" && typeof value === "string") return value;
  if (key === "contentBase64" && typeof value === "string") {
    count.bytes += Buffer.byteLength(value);
    return value;
  }
  if (typeof value === "string") {
    const before = Buffer.byteLength(value);
    let safe = redactSecrets(value);
    for (const marker of [...DEFAULT_SECRET_MARKERS, ...policy.secretMarkers])
      safe = safe.split(marker).join("[REDACTED]");
    const bytes = Buffer.from(safe);
    if (bytes.byteLength > policy.maxStringBytes) {
      safe = bytes.subarray(0, policy.maxStringBytes).toString("utf8");
      count.strings += 1;
      count.truncated = true;
    }
    count.bytes += before;
    return safe;
  }
  if (Array.isArray(value)) {
    const remaining = Math.max(0, policy.maxItems - count.items);
    if (value.length > remaining) count.truncated = true;
    return value.slice(0, remaining).map((entry) => {
      count.items += 1;
      return redactValue(entry, policy, count, key);
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonObject).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const result: JsonObject = {};
    for (const [entryKey, entry] of entries) {
      if (count.items >= policy.maxItems) {
        count.truncated = true;
        break;
      }
      count.items += 1;
      result[entryKey] = redactValue(entry, policy, count, entryKey);
    }
    return result;
  }
  return value;
}

export function redactReplayValue(
  value: unknown,
  policyInput: Partial<ReplayRedactionPolicy> = {},
): { readonly truncation: RedactionCount; readonly value: unknown } {
  const policy = normalizedPolicy(policyInput);
  const truncation: RedactionCount = { bytes: 0, items: 0, strings: 0, truncated: false };
  return { truncation, value: redactValue(value, policy, truncation) };
}

export function transitionsFromEvents(events: readonly ReplayEvent[]): ReplayTransition[] {
  return events
    .filter((event) => event.kind === "run.state")
    .map((event) => {
      const payload = plainObject(event.payload, "run.state payload");
      return {
        correlationToken:
          typeof payload.currentCorrelationToken === "string"
            ? payload.currentCorrelationToken
            : null,
        effectKey: typeof payload.currentEffectKey === "string" ? payload.currentEffectKey : null,
        sequence: event.sequence,
        stateId: String(payload.stateId),
        status: String(payload.status),
        stepId: typeof payload.currentStepId === "string" ? payload.currentStepId : null,
      };
    });
}

export function createReplayBundle(input: ReplayBundleInput): ReplayBundle {
  const policy = normalizedPolicy(input.redactionPolicy);
  const redacted = redactReplayValue(
    {
      artifactDigests: [...input.artifactDigests].sort((left, right) =>
        left.digest.localeCompare(right.digest),
      ),
      capabilities: [...new Set(input.capabilities ?? [])].sort(),
      createdAt: input.createdAt,
      events: [...input.events].sort((left, right) => left.sequence - right.sequence),
      fixtures: {
        agentResults: input.fixtures?.agentResults ?? [],
        clock: input.fixtures?.clock ?? [input.createdAt],
        effectResults: input.fixtures?.effectResults ?? [],
        githubReads: input.fixtures?.githubReads ?? [],
        ids: input.fixtures?.ids ?? [input.runId],
      },
      infrastructure: "fake",
      pins: input.pins,
      redactionPolicy: policy,
      resultDocuments: [...(input.resultDocuments ?? [])].sort((left, right) =>
        `${left.runId}\0${left.stepId}\0${left.skillId}`.localeCompare(
          `${right.runId}\0${right.stepId}\0${right.skillId}`,
        ),
      ),
      runId: input.runId,
      schemaVersion: 1,
      transitions: input.transitions ?? transitionsFromEvents(input.events),
    },
    policy,
  );
  const body = {
    ...(redacted.value as Omit<ReplayBundle, "bundleDigest" | "truncation">),
    truncation: redacted.truncation,
  } as Omit<ReplayBundle, "bundleDigest">;
  const bundle = replayBundle.parse({ ...body, bundleDigest: replayBundleDigest(body) });
  const bytes = Buffer.byteLength(canonicalJson(bundle));
  if (bytes > policy.maxBytes)
    throw new Error(`replay_bundle_too_large: ${bytes} exceeds ${policy.maxBytes}`);
  assertFakeBundleSelection(bundle, bundle.capabilities);
  assertNoSecretLeak(bundle);
  return bundle;
}

function assertDataOnly(value: unknown, path = "$"): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertDataOnly(entry, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object") throw new Error(`invalid_replay_bundle: ${path} is not data`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`invalid_replay_bundle: ${path} has a non-data prototype`);
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      throw new Error(`invalid_replay_bundle: forbidden key ${path}.${key}`);
    assertDataOnly(entry, `${path}.${key}`);
  }
}

function assertFakeBundleSelection(value: unknown, capabilities: readonly string[]) {
  const allowed = new Set(capabilities);
  const visit = (entryValue: unknown): void => {
    if (Array.isArray(entryValue)) {
      for (const entry of entryValue) visit(entry);
      return;
    }
    if (entryValue === null || typeof entryValue !== "object") return;
    for (const [entryKey, entry] of Object.entries(entryValue as JsonObject)) {
      if (/(?:^live|adapter$|transport$|^infrastructure$)/iu.test(entryKey)) {
        const safe =
          entry === null ||
          entry === false ||
          entry === 0 ||
          (typeof entry === "string" && entry.toLowerCase().startsWith("fake"));
        if (!safe) throw new Error(`live_adapter_forbidden: ${entryKey}`);
      }
      if (entryKey === "capabilities" && Array.isArray(entry))
        for (const capability of entry)
          if (typeof capability !== "string" || !allowed.has(capability))
            throw new Error(`capability_escalation: ${String(capability)}`);
      visit(entry);
    }
  };
  visit(value);
}

function assertNestedBundleShapes(value: JsonObject): void {
  for (const [index, event] of (value.events as unknown[]).entries())
    exactKeys(
      event,
      ["eventId", "kind", "occurredAt", "payload", "runId", "sequence"],
      `events[${index}]`,
    );
  for (const [index, artifact] of (value.artifactDigests as unknown[]).entries())
    exactKeys(
      artifact,
      ["classification", "contentBase64", "digest", "name", "size"],
      `artifactDigests[${index}]`,
    );
  for (const [index, result] of (value.resultDocuments as unknown[]).entries())
    exactKeys(
      result,
      ["artifactDigests", "result", "runId", "skillDigest", "skillId", "stepId"],
      `resultDocuments[${index}]`,
    );
  for (const [index, transition] of (value.transitions as unknown[]).entries())
    exactKeys(
      transition,
      ["correlationToken", "effectKey", "sequence", "stateId", "status", "stepId"],
      `transitions[${index}]`,
    );
}

function strictBundleShape(value: unknown): void {
  exactKeys(
    value,
    [
      "artifactDigests",
      "bundleDigest",
      "capabilities",
      "createdAt",
      "events",
      "fixtures",
      "infrastructure",
      "pins",
      "redactionPolicy",
      "resultDocuments",
      "runId",
      "schemaVersion",
      "transitions",
      "truncation",
    ],
    "bundle",
  );
  const object = value as JsonObject;
  exactKeys(
    object.pins,
    [
      "agentProfileDigests",
      "definitionDigest",
      "flowDigest",
      "moduleManifestDigest",
      "skillDigests",
      "workflowVersionDigest",
    ],
    "pins",
  );
  exactKeys(
    object.fixtures,
    ["agentResults", "clock", "effectResults", "githubReads", "ids"],
    "fixtures",
  );
  exactKeys(
    object.redactionPolicy,
    ["maxBytes", "maxItems", "maxStringBytes", "privateRetention", "secretMarkers"],
    "redactionPolicy",
  );
  exactKeys(object.truncation, ["bytes", "items", "strings", "truncated"], "truncation");
  assertNestedBundleShapes(object);
}

export function parseReplayBundle(source: string | unknown): ReplayBundle {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("invalid_replay_bundle: malformed JSON");
    }
  }
  strictBundleShape(value);
  assertDataOnly(value);
  const parsed = replayBundle.parse(value);
  if (!DIGEST.test(parsed.bundleDigest)) throw new Error("digest_mismatch: invalid bundle digest");
  const { bundleDigest, ...body } = parsed;
  const actual = replayBundleDigest(body);
  if (actual !== bundleDigest)
    throw new Error(`digest_mismatch: expected ${bundleDigest}, received ${actual}`);
  normalizedPolicy(parsed.redactionPolicy);
  const bytes = Buffer.byteLength(canonicalJson(parsed));
  if (bytes > parsed.redactionPolicy.maxBytes) throw new Error("replay_bundle_too_large");
  assertFakeBundleSelection(parsed, parsed.capabilities);
  assertNoSecretLeak(parsed);
  assertNormalizedSequence(parsed.events);
  return parsed;
}

function assertNoSecretLeak(bundle: ReplayBundle): void {
  const scanValue = {
    ...bundle,
    redactionPolicy: { ...bundle.redactionPolicy, secretMarkers: [] },
  };
  const serialized = canonicalJson(scanValue);
  if (containsSecret(serialized)) throw new Error("replay_secret_leak: credential marker detected");
  for (const marker of [...DEFAULT_SECRET_MARKERS, ...bundle.redactionPolicy.secretMarkers]) {
    if (marker !== "" && serialized.includes(marker))
      throw new Error(`replay_secret_leak: ${marker}`);
  }
  for (const artifact of bundle.artifactDigests) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(artifact.contentBase64, "base64"),
      );
    } catch {
      throw new Error(`replay_secret_leak: public artifact ${artifact.name} is not UTF-8`);
    }
    if (containsSecret(text))
      throw new Error(`replay_secret_leak: credential in public artifact ${artifact.name}`);
    for (const marker of [...DEFAULT_SECRET_MARKERS, ...bundle.redactionPolicy.secretMarkers])
      if (marker !== "" && text.includes(marker))
        throw new Error(`replay_secret_leak: marker in public artifact ${artifact.name}`);
  }
}

function assertNormalizedSequence(events: readonly ReplayEvent[]): void {
  let last = -1;
  const identities = new Set<string>();
  for (const event of events) {
    if (event.sequence <= last)
      throw new Error("transition_drift: events are not strictly ordered");
    if (identities.has(event.eventId)) throw new Error(`duplicate_event: ${event.eventId}`);
    identities.add(event.eventId);
    last = event.sequence;
  }
}

function equalRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyReplayBundle(
  bundleInput: ReplayBundle | unknown,
  trusted: TrustedReplayPins,
): ReplayBundle {
  const bundle = parseReplayBundle(bundleInput);
  const mismatch = (name: string): never => {
    throw new Error(`digest_mismatch: ${name}`);
  };
  if (bundle.pins.moduleManifestDigest !== trusted.moduleManifestDigest)
    mismatch("module manifest");
  if (bundle.pins.definitionDigest !== trusted.definitionDigest) mismatch("definition");
  if (bundle.pins.flowDigest !== trusted.flowDigest) mismatch("flow");
  if (bundle.pins.workflowVersionDigest !== trusted.workflowVersionDigest) mismatch("workflow");
  if (!equalRecord(bundle.pins.agentProfileDigests, trusted.agentProfileDigests)) mismatch("agent");
  if (!equalRecord(bundle.pins.skillDigests, trusted.skillDigests)) mismatch("skill");

  const allowed = new Set(trusted.allowedCapabilities);
  for (const capability of bundle.capabilities)
    if (!allowed.has(capability)) throw new Error(`capability_escalation: ${capability}`);

  const expectedTransitions = transitionsFromEvents(bundle.events);
  if (canonicalJson(expectedTransitions) !== canonicalJson(bundle.transitions))
    throw new Error("transition_drift: declared transitions do not match events");

  const effects = bundle.events.filter((event) => event.kind === "effect.requested");
  const effectKeys = new Set<string>();
  for (const event of effects) {
    const key = String(plainObject(event.payload, "effect payload").idempotencyKey ?? "");
    if (key === "") throw new Error("correlation_gap: effect is missing idempotency key");
    if (effectKeys.has(key)) throw new Error(`duplicate_effect: ${key}`);
    effectKeys.add(key);
  }

  const publicDigests = new Set<string>();
  for (const artifact of bundle.artifactDigests) {
    if (!DIGEST.test(artifact.digest)) mismatch(`artifact ${artifact.name}`);
    if (publicDigests.has(artifact.digest))
      throw new Error(`duplicate_artifact: ${artifact.digest}`);
    publicDigests.add(artifact.digest);
    const bundledBytes = Buffer.from(artifact.contentBase64, "base64");
    if (bundledBytes.byteLength !== artifact.size || sha256Digest(bundledBytes) !== artifact.digest)
      mismatch(`artifact ${artifact.name}`);
    const trustedBytes = trusted.artifactBytes?.[artifact.digest];
    if (trustedBytes !== undefined && sha256Digest(trustedBytes) !== artifact.digest)
      mismatch(`artifact ${artifact.name}`);
  }
  for (const result of bundle.resultDocuments)
    for (const digest of result.artifactDigests)
      if (!publicDigests.has(digest)) mismatch(`result artifact ${digest}`);
  return bundle;
}

export function executeReplayBundle(
  bundleInput: ReplayBundle | unknown,
  trusted: TrustedReplayPins,
): ReplayExecutionResult {
  const bundle = verifyReplayBundle(bundleInput, trusted);
  return {
    bundleDigest: bundle.bundleDigest,
    effectIntents: bundle.events
      .filter((event) => event.kind === "effect.requested")
      .map((event) => event.payload),
    liveWrites: 0,
    transitions: bundle.transitions,
  };
}

export class DeterministicReplayClock {
  readonly #values: readonly string[];
  #index = 0;

  constructor(values: readonly string[]) {
    if (values.length === 0) throw new Error("invalid_replay_bundle: clock fixture is empty");
    this.#values = values;
  }

  now = (): Date =>
    new Date(this.#values[Math.min(this.#index++, this.#values.length - 1)] as string);
}

export class DeterministicReplayIds {
  readonly #values: readonly string[];
  #index = 0;

  constructor(values: readonly string[]) {
    if (values.length === 0) throw new Error("invalid_replay_bundle: id fixture is empty");
    this.#values = values;
  }

  next = (): string => {
    const value = this.#values[this.#index++];
    if (value === undefined) throw new Error("replay_fixture_exhausted: ids");
    return value;
  };
}

export function mapFactoryFailure(
  category: unknown,
  productOutcome: unknown = null,
): {
  readonly failureCategory: FactoryFailureCategory | null;
  readonly productOutcome: string | null;
} {
  if (typeof productOutcome === "string")
    return { failureCategory: "expected_product_outcome", productOutcome };
  switch (category) {
    case "result-invalid":
    case "validation":
      return { failureCategory: "result_invalid", productOutcome: null };
    case "policy":
    case "rejected":
      return { failureCategory: "policy_rejection", productOutcome: null };
    case "conflict":
    case "stale_external_revision":
      return { failureCategory: "conflict", productOutcome: null };
    case "rate":
    case "rate_limit":
      return { failureCategory: "rate_limit", productOutcome: null };
    case "timeout":
      return { failureCategory: "timeout", productOutcome: null };
    case "cancel":
    case "cancelled":
      return { failureCategory: "cancellation", productOutcome: null };
    case "adapter":
    case "provider":
    case "process":
    case "sandbox":
    case "unavailable":
    case "workspace-limit":
    case "ambiguous_network":
      return { failureCategory: "adapter_failure", productOutcome: null };
    case null:
    case undefined:
      return { failureCategory: null, productOutcome: null };
    default:
      return { failureCategory: "factory_defect", productOutcome: null };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function telemetryAttributes(
  event: Pick<ReplayEvent, "kind" | "payload" | "runId">,
): FactoryTelemetryAttributes {
  const payload = plainObject(event.payload, `${event.kind} payload`);
  const provenance =
    payload.provenance !== null && typeof payload.provenance === "object"
      ? (payload.provenance as JsonObject)
      : {};
  return {
    agentProfileDigest: nullableString(payload.agentProfileDigest),
    agentProfileDigests:
      payload.agentProfileDigests !== null && typeof payload.agentProfileDigests === "object"
        ? canonicalJson(payload.agentProfileDigests)
        : null,
    artifactDigest: nullableString(payload.digest),
    attemptId: nullableString(payload.attemptId),
    correlationId: nullableString(payload.correlationId),
    correlationToken: nullableString(payload.correlationToken),
    definitionDigest: nullableString(payload.definitionDigest),
    effectKey: nullableString(payload.idempotencyKey ?? payload.currentEffectKey),
    flowDigest: nullableString(payload.flowDigest),
    flowId: nullableString(payload.flowId),
    gateId: nullableString(payload.gateId ?? payload.currentGateId),
    moduleManifestDigest: nullableString(payload.moduleManifestDigest),
    repository: nullableString(
      payload.repository ?? (payload.target as JsonObject | undefined)?.repository,
    ),
    runId: event.runId,
    skillDigest: nullableString(payload.skillDigest),
    skillDigests:
      payload.skillDigests !== null && typeof payload.skillDigests === "object"
        ? canonicalJson(payload.skillDigests)
        : null,
    stateId: nullableString(payload.stateId),
    stepId: nullableString(payload.stepId ?? provenance.stepId),
    subject: nullableString(payload.subject ?? (payload.target as JsonObject | undefined)?.subject),
  };
}

function moduleForKind(kind: string): FactoryTelemetryRecord["scope"]["module"] {
  if (kind.startsWith("source.")) return "intake";
  if (kind.startsWith("definition.")) return "definitions";
  if (kind.startsWith("skill.") || kind.startsWith("artifact.")) return "assets";
  if (kind.startsWith("attempt.")) return "execution";
  if (kind.startsWith("effect.finished")) return "effects";
  if (kind.startsWith("run.") || kind.startsWith("step.") || kind.startsWith("effect.requested"))
    return "runs";
  return "operations";
}

export function telemetryRecordsForEvent(event: ReplayEvent): FactoryTelemetryRecord[] {
  const payload = plainObject(event.payload, `${event.kind} payload`);
  const failure = payload.failure as JsonObject | null | undefined;
  const productOutcome =
    event.kind === "attempt.finished" || event.kind === "run.finished"
      ? (payload.productOutcome ?? payload.outcome)
      : payload.productOutcome;
  const mapped = mapFactoryFailure(failure?.category ?? payload.failureCategory, productOutcome);
  const telemetryRedaction = redactReplayValue(telemetryAttributes(event), {
    maxBytes: 16 * 1024,
    maxItems: 64,
    maxStringBytes: 1024,
    privateRetention: "ephemeral",
    secretMarkers: [],
  });
  const attributes = factoryTelemetryAttributes.parse(telemetryRedaction.value);
  const base = {
    attributes,
    failureCategory: mapped.failureCategory,
    productOutcome: mapped.productOutcome,
    recordedAt: event.occurredAt,
    schemaVersion: 1 as const,
    scope: { kind: "subscription" as const, module: moduleForKind(event.kind), name: event.kind },
    truncation: {
      bytes: telemetryRedaction.truncation.bytes,
      items: telemetryRedaction.truncation.items,
      truncated: telemetryRedaction.truncation.truncated,
    },
  };
  return [
    { ...base, metric: null, signal: "log" },
    { ...base, metric: { name: "factory.events", unit: "event", value: 1 }, signal: "metric" },
    { ...base, metric: null, signal: "trace" },
  ];
}

function duration(start: unknown, finish: unknown): number | null {
  if (typeof start !== "string" || typeof finish !== "string") return null;
  const value = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function projectOperationsTelemetry(
  events: readonly ReplayEvent[],
  checkedAt: string,
  stuckAfterMs = 5 * 60_000,
  pollLagMs: number | null = null,
): OperationsTelemetrySnapshot {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const outcomes: Record<string, number> = {};
  const infrastructureFailures: Record<string, number> = {};
  const attemptDurations: number[] = [];
  const runDurations: number[] = [];
  const gateWait: number[] = [];
  const waitingSince = new Map<string, string>();
  const lastStates = new Map<string, ReplayEvent>();
  const expectedAttempts = new Map<
    string,
    { eventId: string; runId: string; token: string | null }
  >();
  const expectedEffects = new Map<
    string,
    { eventId: string; runId: string; token: string | null }
  >();
  const correlationGaps: OperationsTelemetrySnapshot["correlationGaps"] = [];
  let retries = 0;
  let effectsRequested = 0;
  let effectsApplied = 0;
  let effectsFailed = 0;
  let tokenInput = 0;
  let tokenOutput = 0;
  let costUsd = 0;

  for (const event of sorted) {
    const payload = plainObject(event.payload, `${event.kind} payload`);
    if (event.kind === "run.state") {
      const previous = lastStates.get(event.runId);
      const status = String(payload.status);
      if (status === "waiting" && !waitingSince.has(event.runId))
        waitingSince.set(event.runId, event.occurredAt);
      if (status !== "waiting") {
        const since = waitingSince.get(event.runId);
        const elapsed = duration(since, event.occurredAt);
        if (elapsed !== null) gateWait.push(elapsed);
        waitingSince.delete(event.runId);
      }
      if (
        status === "retrying" ||
        (previous !== undefined && previous.payload !== payload && status === "running")
      )
        retries += status === "retrying" ? 1 : 0;
      lastStates.set(event.runId, event);
    } else if (event.kind === "step.requested") {
      expectedAttempts.set(String(payload.attemptId), {
        eventId: event.eventId,
        runId: event.runId,
        token: nullableString(payload.correlationToken),
      });
    } else if (event.kind === "attempt.finished") {
      const expected = expectedAttempts.get(String(payload.attemptId));
      const actual = nullableString(payload.correlationToken);
      if (expected === undefined || expected.token !== actual)
        correlationGaps.push({
          actual,
          eventId: event.eventId,
          expected: expected?.token ?? null,
          kind: "attempt",
          runId: event.runId,
        });
      const elapsed = duration(payload.startedAt, payload.finishedAt);
      if (elapsed !== null) attemptDurations.push(elapsed);
      const failure = payload.failure as JsonObject | null | undefined;
      const mapped = mapFactoryFailure(
        failure?.category ?? payload.failureCategory,
        payload.outcome,
      );
      if (mapped.productOutcome !== null) increment(outcomes, mapped.productOutcome);
      else if (mapped.failureCategory !== null)
        increment(infrastructureFailures, mapped.failureCategory);
      const usage = payload.usage as JsonObject | undefined;
      tokenInput += Number(usage?.inputTokens ?? 0);
      tokenOutput += Number(usage?.outputTokens ?? 0);
      costUsd += Number(usage?.costUsd ?? 0);
    } else if (event.kind === "effect.requested") {
      effectsRequested += 1;
      expectedEffects.set(String(payload.idempotencyKey), {
        eventId: event.eventId,
        runId: event.runId,
        token: nullableString(payload.correlationToken),
      });
    } else if (event.kind === "effect.finished") {
      const expected = expectedEffects.get(String(payload.idempotencyKey));
      const actual = nullableString(payload.correlationToken);
      if (expected === undefined || expected.token !== actual)
        correlationGaps.push({
          actual,
          eventId: event.eventId,
          expected: expected?.token ?? null,
          kind: "effect",
          runId: event.runId,
        });
      if (payload.outcome === "applied" || payload.outcome === "already_applied")
        effectsApplied += 1;
      else effectsFailed += 1;
      const mapped = mapFactoryFailure(payload.failureCategory);
      if (mapped.failureCategory !== null)
        increment(infrastructureFailures, mapped.failureCategory);
    } else if (event.kind === "run.finished") {
      const elapsed = duration(payload.startedAt, payload.finishedAt);
      if (elapsed !== null) runDurations.push(elapsed);
      if (typeof payload.outcome === "string") increment(outcomes, payload.outcome);
    }
  }

  const now = Date.parse(checkedAt);
  const stuck: OperationsTelemetrySnapshot["stuck"] = [];
  let queueDepth = 0;
  for (const [runId, event] of lastStates) {
    const payload = plainObject(event.payload, "run.state payload");
    const status = String(payload.status);
    if (status === "queued" || status === "retrying") queueDepth += 1;
    const ageMs = now - Date.parse(event.occurredAt);
    if (!Number.isFinite(ageMs) || ageMs < stuckAfterMs) continue;
    if (payload.currentEffectKey !== undefined && payload.currentEffectKey !== null)
      stuck.push({ ageMs, kind: "effect", runId, since: event.occurredAt });
    else if (status === "waiting")
      stuck.push({ ageMs, kind: "waiting", runId, since: event.occurredAt });
    else if (status === "running" || status === "retrying")
      stuck.push({ ageMs, kind: "running", runId, since: event.occurredAt });
  }

  return {
    checkedAt,
    correlationGaps,
    durationsMs: { attempts: attemptDurations, gateWait, runs: runDurations },
    effects: { applied: effectsApplied, failed: effectsFailed, requested: effectsRequested },
    infrastructureFailures,
    outcomes,
    pollLagMs,
    queueDepth,
    retries,
    schemaVersion: 1,
    stuck,
    tokens: { costUsd, input: tokenInput, output: tokenOutput },
  };
}

export const TRIAGE_EVAL_OUTCOMES = [
  "not_actionable",
  "needs_reproduction",
  "skipped",
  "unable_to_reproduce",
  "intended_behavior",
  "unable_to_fix",
  "fix_pending",
  "fix_rejected",
  "fix_verified",
  "failed",
  "completed",
] as const;

export const DETERMINISTIC_EVAL_SCENARIOS = [
  ...TRIAGE_EVAL_OUTCOMES,
  "crash",
  "duplicate",
  "stale_lease",
  "rate_limit",
  "conflict",
  "prompt_injection",
  "effect_ambiguity",
  "approval",
] as const;

export const DETERMINISTIC_EVAL_FIXTURES = DETERMINISTIC_EVAL_SCENARIOS.map((name) => ({
  expectedOutcome: TRIAGE_EVAL_OUTCOMES.includes(name as (typeof TRIAGE_EVAL_OUTCOMES)[number])
    ? name
    : "failed",
  name,
  schemaVersion: 1 as const,
}));

export function evaluateReplayFixture(
  fixture: EvalFixture,
  trusted: TrustedReplayPins,
): EvalResult {
  const failures: string[] = [];
  let schema = true;
  let capabilityInvariant = true;
  try {
    verifyReplayBundle(fixture.bundle, trusted);
  } catch (error) {
    schema = false;
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
    capabilityInvariant = !message.startsWith("capability_escalation");
  }
  const result = fixture.bundle.resultDocuments.find(
    (entry) =>
      entry.runId === fixture.runId &&
      entry.stepId === fixture.stepId &&
      entry.skillId === fixture.skillId &&
      entry.skillDigest === fixture.skillDigest,
  );
  const evidence =
    result !== undefined &&
    fixture.artifactDigests.length > 0 &&
    fixture.artifactDigests.every((digest) => result.artifactDigests.includes(digest));
  if (!evidence) failures.push("missing_reproduction_evidence");
  const earlyExit =
    (fixture.expectedOutcome !== "fix" &&
      fixture.expectedOutcome !== "fix_pending" &&
      fixture.expectedOutcome !== "fix_verified") ||
    fixture.bundle.transitions.length > 0;
  const testTrust = fixture.bundle.events.every((event) => {
    if (event.kind !== "attempt.finished") return true;
    const payload = plainObject(event.payload, "attempt payload");
    return payload.testsTrusted !== false;
  });
  if (!testTrust) failures.push("untrusted_test_result");
  return {
    artifactDigests: [...fixture.artifactDigests],
    failures,
    passed: failures.length === 0,
    runId: fixture.runId,
    scores: { capabilityInvariant, earlyExit, evidence, schema, testTrust },
    skillDigest: fixture.skillDigest,
    skillId: fixture.skillId,
    stepId: fixture.stepId,
  };
}

export function assertEvalSuiteUnbiased(fixtures: readonly EvalFixture[]): void {
  const outcomes = new Set(fixtures.map((fixture) => fixture.expectedOutcome));
  for (const outcome of TRIAGE_EVAL_OUTCOMES)
    if (!outcomes.has(outcome)) throw new Error(`forced_fix_bias: missing ${outcome} fixture`);
}
