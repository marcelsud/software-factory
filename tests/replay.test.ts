import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChimpbaseSinkSpan, ChimpbaseTelemetrySink } from "chimpbase/runtime";
import { createChimpbase } from "chimpbase/runtime/bun";

import { createSoftwareFactoryApp, FACTORY_RUNS_V2_WORKFLOW_DIGEST } from "../chimpbase.app.ts";
import { runCli } from "../src/cli.ts";
import { compileFactoryDefinition } from "../src/compiler.ts";
import type { ReplayBundle, ReplayEvent, ReplayPins } from "../src/contracts/index.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";
import {
  assertEvalSuiteUnbiased,
  createReplayBundle,
  DETERMINISTIC_EVAL_SCENARIOS,
  type EvalFixture,
  evaluateReplayFixture,
  executeReplayBundle,
  mapFactoryFailure,
  parseReplayBundle,
  projectOperationsTelemetry,
  replayBundleDigest,
  sha256Digest,
  type TrustedReplayPins,
  telemetryRecordsForEvent,
  transitionsFromEvents,
  verifyReplayBundle,
} from "../src/replay.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const digest = (value: string) => sha256Digest(value);
const artifactBytes = Buffer.from("public evidence", "utf8");
const artifactDigest = sha256Digest(artifactBytes);

const pins: ReplayPins = {
  agentProfileDigests: { triage: digest("agent") },
  definitionDigest: digest("definition"),
  flowDigest: digest("flow"),
  moduleManifestDigest: digest("manifest"),
  skillDigests: { diagnose: digest("skill") },
  workflowVersionDigest: digest("workflow"),
};

const events: ReplayEvent[] = [
  {
    eventId: "event-1",
    kind: "run.state",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      agentProfileDigests: pins.agentProfileDigests,
      currentCorrelationToken: "correlation-1",
      currentStepId: "diagnose",
      definitionDigest: pins.definitionDigest,
      flowDigest: pins.flowDigest,
      flowId: "triage",
      moduleManifestDigest: pins.moduleManifestDigest,
      skillDigests: pins.skillDigests,
      stateId: "diagnosing",
      status: "running",
      workflowVersionDigest: pins.workflowVersionDigest,
    },
    runId: "run-1",
    sequence: 1,
  },
  {
    eventId: "event-2",
    kind: "step.requested",
    occurredAt: "2026-01-01T00:00:01.000Z",
    payload: {
      attemptId: "attempt-1",
      correlationToken: "correlation-1",
      skillDigests: pins.skillDigests,
      stepId: "diagnose",
    },
    runId: "run-1",
    sequence: 2,
  },
  {
    eventId: "event-3",
    kind: "attempt.finished",
    occurredAt: "2026-01-01T00:00:02.000Z",
    payload: {
      attemptId: "attempt-1",
      correlationToken: "correlation-1",
      finishedAt: "2026-01-01T00:00:02.000Z",
      outcome: "no_action",
      startedAt: "2026-01-01T00:00:01.000Z",
      stepId: "diagnose",
      testsTrusted: true,
    },
    runId: "run-1",
    sequence: 3,
  },
  {
    eventId: "event-4",
    kind: "effect.requested",
    occurredAt: "2026-01-01T00:00:03.000Z",
    payload: {
      capability: "issue.comment",
      correlationToken: "correlation-1",
      idempotencyKey: "effect-1",
    },
    runId: "run-1",
    sequence: 4,
  },
];

function bundle(overrides: Partial<Parameters<typeof createReplayBundle>[0]> = {}): ReplayBundle {
  return createReplayBundle({
    artifactDigests: [
      {
        classification: "public",
        contentBase64: artifactBytes.toString("base64"),
        digest: artifactDigest,
        name: "evidence.txt",
        size: artifactBytes.byteLength,
      },
    ],
    capabilities: ["issue.comment"],
    createdAt: "2026-01-01T00:00:04.000Z",
    events,
    fixtures: {
      agentResults: [],
      clock: ["2026-01-01T00:00:04.000Z"],
      effectResults: [],
      githubReads: [],
      ids: ["run-1", "attempt-1"],
    },
    pins,
    redactionPolicy: {
      maxBytes: 1024 * 1024,
      maxItems: 10_000,
      maxStringBytes: 64 * 1024,
      privateRetention: "ephemeral",
      secretMarkers: [],
    },
    resultDocuments: [
      {
        artifactDigests: [artifactDigest],
        result: { outcome: "no_action" },
        runId: "run-1",
        skillDigest: pins.skillDigests.diagnose as string,
        skillId: "diagnose",
        stepId: "diagnose",
      },
    ],
    runId: "run-1",
    ...overrides,
  });
}

function trusted(overrides: Partial<TrustedReplayPins> = {}): TrustedReplayPins {
  return { ...pins, allowedCapabilities: ["issue.comment"], ...overrides };
}

function resign(
  value: ReplayBundle,
  patch: Partial<Omit<ReplayBundle, "bundleDigest">>,
): ReplayBundle {
  const { bundleDigest: _ignored, ...body } = structuredClone(value);
  const changed = { ...body, ...patch };
  return { ...changed, bundleDigest: replayBundleDigest(changed) };
}

function effectEvent(sequence: number, key = "effect-1"): ReplayEvent {
  return {
    eventId: `effect-${sequence}`,
    kind: "effect.requested",
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    payload: {
      capability: "issue.comment",
      correlationToken: "correlation-1",
      idempotencyKey: key,
    },
    runId: "run-1",
    sequence,
  };
}

async function boot(sinks: ChimpbaseTelemetrySink[] = []) {
  return await createChimpbase({
    app: createSoftwareFactoryApp({ readTransport: unavailableGitHubReadTransport }),
    sinks,
    storage: { engine: "memory" },
    subscriptions: { dispatch: "sync" },
  });
}

class RecordingSink implements ChimpbaseTelemetrySink {
  readonly logs: Array<{
    attributes: Record<string, unknown>;
    scope: { kind: string; name: string };
  }> = [];
  readonly metrics: Array<{
    labels: Record<string, unknown>;
    scope: { kind: string; name: string };
  }> = [];
  readonly spans: Array<{
    attributes: Record<string, unknown>;
    scope: { kind: string; name: string };
  }> = [];

  onLog(
    scope: { kind: string; name: string },
    _level: "debug" | "info" | "warn" | "error",
    _message: string,
    attributes: Record<string, string | number | boolean | null>,
  ) {
    this.logs.push({ attributes, scope });
  }

  onMetric(
    scope: { kind: string; name: string },
    _name: string,
    _value: number,
    labels: Record<string, string | number | boolean | null>,
  ) {
    this.metrics.push({ labels, scope });
  }

  startSpan(
    scope: { kind: string; name: string },
    _name: string,
    attributes: Record<string, string | number | boolean | null>,
  ): ChimpbaseSinkSpan {
    this.spans.push({ attributes, scope });
    return { end() {}, setAttribute() {} };
  }

  startHandlerSpan(): ChimpbaseSinkSpan {
    return { end() {}, setAttribute() {} };
  }
}

describe("leaf 10 replay", () => {
  test("[G1] reconstructs a structured run timeline without free-form log parsing", () => {
    expect(transitionsFromEvents(events)).toEqual([
      {
        correlationToken: "correlation-1",
        effectKey: null,
        sequence: 1,
        stateId: "diagnosing",
        status: "running",
        stepId: "diagnose",
      },
    ]);
  });

  test("[G2] separates product outcomes from infrastructure failure categories", () => {
    const failed = structuredClone(events[2] as ReplayEvent);
    failed.eventId = "event-timeout";
    failed.payload = {
      ...(failed.payload as object),
      failure: { category: "timeout" },
      outcome: null,
    };
    const snapshot = projectOperationsTelemetry(
      [...events.slice(0, 2), failed],
      "2026-01-01T00:00:10.000Z",
    );
    expect(snapshot.infrastructureFailures).toEqual({ timeout: 1 });
    expect(projectOperationsTelemetry(events, "2026-01-01T00:00:10.000Z").outcomes).toEqual({
      no_action: 1,
    });
    expect(mapFactoryFailure(null, "duplicate")).toEqual({
      failureCategory: "expected_product_outcome",
      productOutcome: "duplicate",
    });
  });

  test("[G3] removes credentials, private reports, prompts, reasoning, and secret markers from public records", () => {
    const redacted = bundle({
      fixtures: {
        agentResults: [
          { apiKey: "api-key-super-secret", rawPrompt: "SECRET_MARKER", reasoning: "private" },
        ],
      },
    });
    const text = JSON.stringify(redacted.fixtures);
    expect(text).not.toContain("api-key-super-secret");
    expect(text).not.toContain("SECRET_MARKER");
    expect(text).not.toContain("private");
    expect(text).toContain("[REDACTED]");
  });

  test("[G4] detects stuck waiting, running, effect states and missing or mismatched correlations", () => {
    const waiting = resign(bundle(), {
      events: [
        {
          ...(events[0] as ReplayEvent),
          payload: {
            ...(events[0]?.payload as object),
            currentEffectKey: "effect-1",
            status: "waiting",
          },
        },
        {
          ...(events[2] as ReplayEvent),
          payload: { ...(events[2]?.payload as object), correlationToken: "wrong" },
          sequence: 3,
        },
      ],
      transitions: [
        {
          correlationToken: "correlation-1",
          effectKey: "effect-1",
          sequence: 1,
          stateId: "diagnosing",
          status: "waiting",
          stepId: "diagnose",
        },
      ],
    });
    const snapshot = projectOperationsTelemetry(waiting.events, "2026-01-01T00:10:00.000Z", 1000);
    expect(snapshot.stuck).toEqual([
      { ageMs: 600_000, kind: "effect", runId: "run-1", since: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(snapshot.correlationGaps[0]).toMatchObject({ actual: "wrong", kind: "attempt" });
  });

  test("[G5] emits structured logs, metrics, and traces through Chimpbase scopes for every module", async () => {
    const modules = new Set(
      [
        "definition.published",
        "source.accepted",
        "skill.pinned",
        "attempt.finished",
        "effect.finished",
        "run.state",
        "operations.audit",
      ].map(
        (kind, index) =>
          telemetryRecordsForEvent({
            eventId: `scope-${index}`,
            kind,
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {},
            runId: "run-1",
            sequence: index + 1,
          })[0]?.scope.module,
      ),
    );
    expect([...modules].sort()).toEqual([
      "assets",
      "definitions",
      "effects",
      "execution",
      "intake",
      "operations",
      "runs",
    ]);

    const sink = new RecordingSink();
    const host = await boot([sink]);
    try {
      await host.executeAction("operations/importReplayBundle@v1", { bundle: bundle() });
      await host.drain({ maxDurationMs: 5_000 });
      expect(sink.logs.some((entry) => entry.attributes.schemaVersion === 1)).toBe(true);
      expect(sink.metrics.some((entry) => entry.labels.sourceModule === "assets")).toBe(true);
      expect(sink.spans.length).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });

  test("[G6] yields an identical transition and effect-intent sequence on repeated replay", () => {
    const first = executeReplayBundle(bundle(), trusted());
    const second = executeReplayBundle(bundle(), trusted());
    expect(first).toEqual(second);
  });

  test("[G7] rejects a bundle digest or pin mismatch before replay execution", () => {
    expect(() =>
      verifyReplayBundle(bundle(), trusted({ definitionDigest: digest("other") })),
    ).toThrow("digest_mismatch: definition");
    expect(() => parseReplayBundle({ ...bundle(), bundleDigest: digest("wrong") })).toThrow(
      "digest_mismatch",
    );
  });

  test("[G8] rejects live adapters and extra capabilities from untrusted bundle data", () => {
    const value = bundle();
    expect(() => parseReplayBundle(resign(value, { infrastructure: "live" as "fake" }))).toThrow();
    expect(() => parseReplayBundle({ ...value, liveAdapter: "github" })).toThrow(
      "unknown or missing fields",
    );
    expect(() => bundle({ fixtures: { effectResults: [{ adapter: "live-github" }] } })).toThrow(
      "live_adapter_forbidden",
    );
    expect(() =>
      verifyReplayBundle(resign(value, { capabilities: ["repository.write"] }), trusted()),
    ).toThrow("capability_escalation");
    expect(executeReplayBundle(value, trusted()).liveWrites).toBe(0);
  });

  test("[G9] fails duplicate effects, leaked secrets, capability escalation, transition drift, and forced-fix bias", () => {
    const value = bundle();
    expect(() =>
      verifyReplayBundle(resign(value, { events: [...value.events, effectEvent(5)] }), trusted()),
    ).toThrow("duplicate_effect");
    const leakedEvents = structuredClone(value.events);
    (leakedEvents[0]?.payload as Record<string, unknown>).note = "SECRET_MARKER";
    expect(() => parseReplayBundle(resign(value, { events: leakedEvents }))).toThrow(
      "replay_secret_leak",
    );
    expect(() => verifyReplayBundle(resign(value, { capabilities: ["root"] }), trusted())).toThrow(
      "capability_escalation",
    );
    expect(() => verifyReplayBundle(resign(value, { transitions: [] }), trusted())).toThrow(
      "transition_drift",
    );
    expect(() => assertEvalSuiteUnbiased([{ expectedOutcome: "fix" } as EvalFixture])).toThrow(
      "forced_fix_bias",
    );
  });

  test("[G10] stores bundles through assets and exposes them through operations", async () => {
    const host = await boot();
    try {
      const imported = (
        await host.executeAction("operations/importReplayBundle@v1", { bundle: bundle() })
      ).result as { artifactDigest: string };
      const loaded = (
        await host.executeAction("operations/getReplayBundle@v1", {
          digest: imported.artifactDigest,
        })
      ).result as { bundle: ReplayBundle };
      expect(loaded.bundle.bundleDigest).toBe(bundle().bundleDigest);
      const artifacts = (
        await host.executeAction("assets/listRunArtifactsV2@v1", { runId: "run-1" })
      ).result as Array<{ classification: string; name: string }>;
      expect(artifacts.some((artifact) => artifact.classification === "private")).toBe(true);
      expect(
        artifacts.some(
          (artifact) =>
            artifact.classification === "public" && artifact.name === "replay-bundle.json",
        ),
      ).toBe(true);
    } finally {
      await host.close();
    }
  });

  test("[G11] reconstructs durable audit facts without parsing log messages", () => {
    const value = bundle();
    expect(value.events.map(({ kind, sequence }) => ({ kind, sequence }))).toEqual([
      { kind: "run.state", sequence: 1 },
      { kind: "step.requested", sequence: 2 },
      { kind: "attempt.finished", sequence: 3 },
      { kind: "effect.requested", sequence: 4 },
    ]);
    expect(value.transitions).toEqual(transitionsFromEvents(value.events));
  });

  test("[G12] CLI replay uses isolated fake infrastructure and makes no live writes", async () => {
    const source = await readFile("factory.yaml", "utf8");
    const compiled = compileFactoryDefinition(source, { sourceName: "factory.yaml" });
    const plan = Object.values(compiled.plansV3)[0];
    if (plan === undefined) throw new Error("fixture plan missing");
    const manifest = await readFile("module-contracts/manifest.json");
    const cliPins: ReplayPins = {
      agentProfileDigests: plan.agentProfileDigests,
      definitionDigest: compiled.revision.definitionDigest,
      flowDigest: plan.flowDigest,
      moduleManifestDigest: createHash("sha256").update(manifest).digest("hex"),
      skillDigests: plan.skillRevisions,
      workflowVersionDigest: FACTORY_RUNS_V2_WORKFLOW_DIGEST,
    };
    const cliBundle = createReplayBundle({
      artifactDigests: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      events: [],
      fixtures: { clock: ["2026-01-01T00:00:00.000Z"], ids: ["run-cli"] },
      pins: cliPins,
      runId: "run-cli",
    });
    const directory = await mkdtemp(join(tmpdir(), "factory-replay-"));
    scratch.push(directory);
    const path = join(directory, "bundle.json");
    await writeFile(path, JSON.stringify(cliBundle));
    let stdout = "";
    const code = await runCli(
      ["replay", path, "--json"],
      {
        stderr: () => {},
        stdout: (text) => {
          stdout += text;
        },
      },
      { checkModules: async () => {}, readText: (file) => readFile(file, "utf8") },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      infrastructure: "fake",
      liveWrites: 0,
      storage: "memory",
    });
  });

  test("[G13] detects definition, skill, and artifact digest mismatches before execution", () => {
    const value = bundle();
    expect(() => verifyReplayBundle(value, trusted({ definitionDigest: digest("bad") }))).toThrow(
      "definition",
    );
    expect(() =>
      verifyReplayBundle(value, trusted({ skillDigests: { diagnose: digest("bad") } })),
    ).toThrow("skill");
    const originalArtifact = value.artifactDigests[0];
    if (originalArtifact === undefined) throw new Error("fixture artifact missing");
    const badArtifact = [
      { ...originalArtifact, contentBase64: Buffer.from("tampered").toString("base64") },
    ] as ReplayBundle["artifactDigests"];
    expect(() =>
      verifyReplayBundle(resign(value, { artifactDigests: badArtifact }), trusted()),
    ).toThrow("artifact");
  });

  test("[G14] exposes outcome and failure metrics plus waiting, running, and effect stuck states", () => {
    const stuckEvents = [
      {
        ...(events[0] as ReplayEvent),
        runId: "waiting",
        payload: { ...(events[0]?.payload as object), status: "waiting" },
      },
      { ...(events[0] as ReplayEvent), eventId: "running", runId: "running", sequence: 2 },
      {
        ...(events[0] as ReplayEvent),
        eventId: "effect",
        runId: "effect",
        sequence: 3,
        payload: { ...(events[0]?.payload as object), currentEffectKey: "key" },
      },
    ];
    const snapshot = projectOperationsTelemetry(stuckEvents, "2026-01-01T00:10:00.000Z", 1);
    expect(snapshot.stuck.map((entry) => entry.kind).sort()).toEqual([
      "effect",
      "running",
      "waiting",
    ]);
    expect(snapshot.queueDepth).toBe(0);
  });

  test("[G15] invariant fixtures reject duplicate, drift, leaks, escalation, and forced-fix bias", () => {
    expect(DETERMINISTIC_EVAL_SCENARIOS).toEqual(
      expect.arrayContaining([
        "crash",
        "stale_lease",
        "rate_limit",
        "conflict",
        "prompt_injection",
        "effect_ambiguity",
        "approval",
      ]),
    );
    const value = bundle();
    const checks = [
      () =>
        verifyReplayBundle(resign(value, { events: [...value.events, effectEvent(5)] }), trusted()),
      () => verifyReplayBundle(resign(value, { transitions: [] }), trusted()),
      () => verifyReplayBundle(resign(value, { capabilities: ["admin"] }), trusted()),
    ];
    expect(
      checks.every((check) => {
        try {
          check();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  });

  test("[G16] eval results retain exact run, step, skill revision, and artifact evidence", () => {
    const fixture: EvalFixture = {
      artifactDigests: [artifactDigest],
      bundle: bundle(),
      expectedOutcome: "no_action",
      name: "no-action",
      runId: "run-1",
      skillDigest: pins.skillDigests.diagnose as string,
      skillId: "diagnose",
      stepId: "diagnose",
    };
    const result = evaluateReplayFixture(fixture, trusted());
    expect(result).toMatchObject({
      passed: true,
      runId: "run-1",
      skillId: "diagnose",
      stepId: "diagnose",
      skillDigest: pins.skillDigests.diagnose,
    });
    expect(result.artifactDigests).toEqual([artifactDigest]);
    expect(result.scores).toEqual({
      capabilityInvariant: true,
      earlyExit: true,
      evidence: true,
      schema: true,
      testTrust: true,
    });
  });

  test("[G17] bounds and redacts public exports while preserving configurable private retention", () => {
    const value = bundle({
      fixtures: { agentResults: [{ output: "0123456789", rawPrompt: "hidden" }] },
      redactionPolicy: {
        maxBytes: 1024 * 1024,
        maxItems: 10_000,
        maxStringBytes: 8,
        privateRetention: "retained",
        secretMarkers: [],
      },
    });
    expect(value.redactionPolicy.privateRetention).toBe("retained");
    expect(value.truncation.truncated).toBe(true);
    expect(value.truncation.strings).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toContain("hidden");
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(
      value.redactionPolicy.maxBytes,
    );
  });
});
