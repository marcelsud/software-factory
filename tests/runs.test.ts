import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chimpbaseModuleResourceName, defineChimpbaseApp } from "chimpbase/core";
import { action } from "chimpbase/runtime";
import { createChimpbase } from "chimpbase/runtime/bun";

import { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import { compileFactoryDefinition, DefinitionCompileError } from "../src/compiler.ts";
import { attemptOutcome, effectOutcome, type FactoryEvent } from "../src/contracts/index.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";

const source = await readFile(new URL("../factory.yaml", import.meta.url), "utf8");
const manifestDigest = "manifest-runs-v3";
const workflowVersionDigest = "workflow-runs-v2";
const artifact = "a".repeat(64);
const directories: string[] = [];
const hosts: Array<{ close(): Promise<void> }> = [];

const injectAttempt = action({
  name: "runs-test.inject-attempt",
  args: attemptOutcome,
  result: attemptOutcome,
  async handler(ctx, input) {
    await ctx.enqueue(chimpbaseModuleResourceName("execution", "queue", "agent-workers"), {
      attemptId: input.attemptId,
      outcome: input,
    });
    return input;
  },
});

const injectEffect = action({
  name: "runs-test.inject-effect",
  args: effectOutcome,
  result: effectOutcome,
  async handler(ctx, input) {
    await ctx.enqueue(chimpbaseModuleResourceName("effects", "queue", "effect-workers"), {
      idempotencyKey: input.idempotencyKey,
      outcome: input,
    });
    return input;
  },
});

function testApp() {
  const app = createSoftwareFactoryApp({
    moduleManifestDigest: manifestDigest,
    readTransport: unavailableGitHubReadTransport,
    workflowVersionDigest,
  });
  return defineChimpbaseApp({
    ...app,
    registrations: [...app.registrations, injectAttempt, injectEffect],
  });
}

type Host = Awaited<ReturnType<typeof createChimpbase>>;

async function boot(path?: string): Promise<Host> {
  const host = await createChimpbase({
    app: testApp(),
    projectDir: process.cwd(),
    storage: path === undefined ? { engine: "memory" } : { engine: "sqlite", path },
    subscriptions: { dispatch: "async" },
  });
  hosts.push(host);
  return host;
}

async function sqlitePath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `factory-runs-${name}-`));
  directories.push(directory);
  return join(directory, "factory.sqlite");
}

async function activate(host: Host, definitionSource = source): Promise<string> {
  const revision = (
    await host.executeAction("definitions/compileDefinition@v1", {
      source: definitionSource,
      sourceName: "factory.yaml",
    })
  ).result as { definitionDigest: string };
  await host.executeAction("definitions/activateDefinition@v1", {
    definitionDigest: revision.definitionDigest,
  });
  return revision.definitionDigest;
}

function event(id: string, subject = `issue:${id}`, repository = "factory"): FactoryEvent {
  return {
    actor: "octocat",
    correlationId: `correlation:${id}`,
    deliveryId: `delivery:${id}`,
    eventType: "issue.opened",
    observedAt: `2026-01-01T00:${id.padStart(2, "0")}:00Z`,
    occurredAt: "2026-01-01T00:00:00Z",
    payload: { action: "opened" },
    repository,
    sourceId: "github:factory",
    sourceRevision: `cursor:${id}`,
    subject,
  };
}

function identity(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function runId(definitionDigest: string, flowDigest: string, value: FactoryEvent): string {
  const eventId = identity("factory-event", value.sourceId, value.deliveryId);
  return identity("run", definitionDigest, flowDigest, eventId);
}

async function accept(
  host: Host,
  value: FactoryEvent,
  definitionDigest: string,
  drain = true,
): Promise<string> {
  const active = (await host.executeAction("definitions/getActiveDefinition@v1", {})).result as {
    flowDigests: Record<string, string>;
  };
  const flowDigest = active.flowDigests["issue-triage"] ?? "";
  const cursor = (
    await host.executeAction("intake/getSourceCursor@v1", { sourceId: value.sourceId })
  ).result as { cursor: string } | null;
  await host.executeAction("intake/acceptSourceEventV2@v1", {
    event: value,
    expectedCursor: cursor?.cursor ?? null,
    nextCursor: value.sourceRevision,
  });
  if (drain) await host.drain({ maxDurationMs: 5_000 });
  return runId(definitionDigest, flowDigest, value);
}

async function projection(host: Host, id: string) {
  return (await host.executeAction("runs/getRunV3@v1", { runId: id })).result as {
    auditSequence: number;
    currentAttemptId?: string;
    currentCorrelationToken?: string;
    currentEffectKey?: string;
    currentGateId?: string;
    outcome: string;
    stateId: string;
    status: string;
  };
}

async function completeAttempt(
  host: Host,
  id: string,
  outcome: string,
  outputArtifactDigests: string[] = [artifact],
  infrastructureFailure = false,
): Promise<{ attemptId: string; correlationToken: string }> {
  const current = await projection(host, id);
  if (current.currentAttemptId === undefined || current.currentCorrelationToken === undefined)
    throw new Error("run has no current attempt");
  await host.executeAction(injectAttempt.name, {
    attemptId: current.currentAttemptId,
    finishedAt: "2026-01-01T01:00:00Z",
    outcome: infrastructureFailure ? "failed" : "succeeded",
    result: { data: {}, outcome, outputArtifactDigests, summary: outcome },
  });
  try {
    await host.drain({ maxDurationMs: 5_000 });
  } catch (error) {
    if (
      outcome !== "fixed" ||
      !(error instanceof Error) ||
      !error.message.includes("effect_adapter_unavailable")
    )
      throw error;
  }
  return { attemptId: current.currentAttemptId, correlationToken: current.currentCorrelationToken };
}

async function reachGate(host: Host, id: string): Promise<void> {
  await completeAttempt(host, id, "reproduced");
  await completeAttempt(host, id, "diagnosed");
  await completeAttempt(host, id, "verified");
}

async function approve(host: Host, id: string, commandId = `approve:${id}`): Promise<void> {
  const current = await projection(host, id);
  if (current.currentGateId === undefined || current.currentCorrelationToken === undefined) {
    throw new Error(`run has no gate: ${JSON.stringify(current)}`);
  }
  await host.executeAction("runs/applyOperatorCommandV2@v1", {
    commandId,
    correlationToken: current.currentCorrelationToken,
    gateId: current.currentGateId,
    issuedAt: "2026-01-01T02:00:00Z",
    kind: "approve",
    runId: id,
  });
  await host.drain({ maxDurationMs: 5_000 });
}

async function finishEffect(
  host: Host,
  id: string,
  outcome: "applied" | "rejected" | "ambiguous" = "applied",
) {
  const current = await projection(host, id);
  if (current.currentEffectKey === undefined) throw new Error("run has no effect");
  await host.executeAction(injectEffect.name, {
    externalRevision: outcome === "applied" ? "revision:1" : null,
    finishedAt: "2026-01-01T03:00:00Z",
    idempotencyKey: current.currentEffectKey,
    outcome,
  });
  await host.drain({ maxDurationMs: 5_000 });
}

async function happyPath(host: Host, id: string): Promise<void> {
  await reachGate(host, id);
  await approve(host, id);
  await completeAttempt(host, id, "fixed");
  await finishEffect(host, id);
}

async function audit(host: Host, id: string) {
  return (await host.executeAction("runs/getRunAudit@v1", { runId: id })).result as Array<{
    kind: string;
    payloadJson: string;
    sequence: number;
  }>;
}

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close();
  while (directories.length > 0)
    await rm(directories.pop() ?? "", { force: true, recursive: true });
});

describe("generic runs workflow", () => {
  test("[G1] traverses the sequential flow and every declared early exit", async () => {
    const host = await boot();
    const digest = await activate(host);
    const happy = await accept(host, event("01"), digest);
    await happyPath(host, happy);
    expect(await projection(host, happy)).toMatchObject({
      outcome: "completed",
      status: "succeeded",
    });
    for (const [index, outcome] of [
      "not_actionable",
      "needs_reproduction",
      "unable_to_reproduce",
    ].entries()) {
      const id = await accept(host, event(`1${index + 1}`), digest);
      await completeAttempt(host, id, outcome);
      expect((await projection(host, id)).outcome).toBe(outcome);
    }
    const unable = await accept(host, event("15"), digest);
    await completeAttempt(host, unable, "reproduced");
    await completeAttempt(host, unable, "unable_to_fix");
    expect((await projection(host, unable)).outcome).toBe("unable_to_fix");
  });

  test("[G2] rejects negative verify and unknown result schemas", async () => {
    const host = await boot();
    const digest = await activate(host);
    const negative = await accept(host, event("20"), digest);
    await completeAttempt(host, negative, "reproduced");
    await completeAttempt(host, negative, "diagnosed");
    await completeAttempt(host, negative, "failed");
    expect(await projection(host, negative)).toMatchObject({
      outcome: "failed",
      stateId: "verification-failed",
    });
    const invalid = await accept(host, event("21"), digest);
    await completeAttempt(host, invalid, "unknown");
    expect(await projection(host, invalid)).toMatchObject({ outcome: "failed", status: "failed" });
  });

  test("[G3] SQLite restart preserves pins and the current wait", async () => {
    const path = await sqlitePath("pins");
    let host = await boot(path);
    const digest = await activate(host);
    const id = await accept(host, event("30"), digest);
    const before = await projection(host, id);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(path);
    await host.drain({ maxDurationMs: 5_000 });
    expect(
      (await host.executeAction("definitions/getActiveDefinition@v1", {})).result,
    ).toMatchObject({ definitionDigest: digest });
    await host.executeAction("definitions/activateDefinition@v1", {
      definitionDigest: digest,
    });
    expect(await projection(host, id)).toMatchObject({
      currentAttemptId: before.currentAttemptId,
      stateId: "reproduce",
    });
    const v2 = (await host.executeAction("runs/getRunV2@v1", { runId: id })).result as Record<
      string,
      unknown
    >;
    expect(v2).toMatchObject({
      definitionDigest: digest,
      moduleManifestDigest: manifestDigest,
      workflowVersion: 2,
      workflowVersionDigest,
    });
  });

  test("[G4] duplicate events and commands are idempotent", async () => {
    const host = await boot();
    const digest = await activate(host);
    const value = event("40");
    const id = await accept(host, value, digest);
    await accept(host, value, digest);
    await reachGate(host, id);
    await approve(host, id, "same-command");
    const after = await projection(host, id);
    await host
      .executeAction("runs/applyOperatorCommandV2@v1", {
        commandId: "same-command",
        correlationToken: after.currentCorrelationToken,
        issuedAt: "2026-01-01T02:00:00Z",
        kind: "approve",
        runId: id,
      })
      .catch(() => undefined);
    expect(
      (await audit(host, id)).filter((entry) => entry.kind === "operator.approve"),
    ).toHaveLength(1);
  });

  test("[G5] manifest dependencies remain acyclic and versioned", async () => {
    const app = testApp();
    const modules = app.modules.map((module) => module.interface);
    expect(modules.find((module) => module.name === "runs")?.dependencies).toEqual([
      "assets",
      "definitions",
      "effects",
      "execution",
      "intake",
    ]);
    const runEvents = modules.find((module) => module.name === "runs")?.events ?? {};
    expect(Object.values(runEvents).map((entry) => `${entry.name}.v${entry.version}`)).toContain(
      "runFinished.v3",
    );
  });

  test("[G6] only correlated declared gate signals advance and duplicates do not", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("60"), digest);
    await reachGate(host, id);
    const gate = await projection(host, id);
    await expect(
      host.executeAction("runs/applyOperatorCommandV2@v1", {
        commandId: "stale-gate",
        correlationToken: "stale",
        gateId: gate.currentGateId,
        issuedAt: "2026-01-01T02:00:00Z",
        kind: "approve",
        runId: id,
      }),
    ).rejects.toThrow("stale");
    await expect(
      host.executeAction("runs/applyOperatorCommandV2@v1", {
        commandId: "retry-pending-gate",
        issuedAt: "2026-01-01T02:00:00Z",
        kind: "retry",
        runId: id,
      }),
    ).rejects.toThrow("no retryable work");
    await approve(host, id, "valid-gate");
    expect((await projection(host, id)).stateId).toBe("fix");
    const signalSource = source
      .replace("kind: approval", "kind: signal")
      .replace(
        "accepted: [operator.approve, operator.reject]",
        "accepted: [external.ready, external.reject]",
      )
      .replace("timeoutOutcome: operator.reject", "timeoutOutcome: external.reject")
      .replace("on: operator.approve", "on: external.ready")
      .replace("on: operator.reject", "on: external.reject");
    const signalHost = await boot();
    const signalDigest = await activate(signalHost, signalSource);
    const signalId = await accept(signalHost, event("61"), signalDigest);
    await reachGate(signalHost, signalId);
    const waiting = await projection(signalHost, signalId);
    const signal = {
      correlationToken: waiting.currentCorrelationToken ?? "",
      gateId: waiting.currentGateId ?? "",
      identity: "external-signal-61",
      occurredAt: "2026-01-01T02:00:00Z",
      runId: signalId,
      signal: "external.ready",
    };
    await signalHost.executeAction("runs/signalRun@v1", signal);
    await signalHost.executeAction("runs/signalRun@v1", signal);
    await signalHost.drain({ maxDurationMs: 5_000 });
    expect((await projection(signalHost, signalId)).stateId).toBe("fix");
    expect(
      (await audit(signalHost, signalId)).filter((entry) => entry.kind === "gate.external.ready"),
    ).toHaveLength(1);
  });

  test("[G7] stale attempt and effect correlations cannot advance", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("70"), digest);
    const stale = await completeAttempt(host, id, "reproduced");
    const diagnose = await projection(host, id);
    await host.executeAction(injectAttempt.name, {
      attemptId: stale.attemptId,
      finishedAt: "2026-01-01T01:01:00Z",
      outcome: "succeeded",
      result: { data: {}, outcome: "unable_to_fix", outputArtifactDigests: [], summary: "stale" },
    });
    await expect(host.drain({ maxDurationMs: 5_000 })).rejects.toThrow("attempt_already_finished");
    expect(await projection(host, id)).toMatchObject({
      currentAttemptId: diagnose.currentAttemptId,
      stateId: "diagnose",
    });
    const effectId = await accept(host, event("71"), digest);
    await reachGate(host, effectId);
    await approve(host, effectId);
    await completeAttempt(host, effectId, "fixed");
    const effectKey = (await projection(host, effectId)).currentEffectKey ?? "";
    await finishEffect(host, effectId);
    await host.executeAction(injectEffect.name, {
      externalRevision: null,
      finishedAt: "2026-01-01T05:00:00Z",
      idempotencyKey: effectKey,
      outcome: "rejected",
    });
    await expect(host.drain({ maxDurationMs: 5_000 })).rejects.toThrow("effect_already_finished");
    expect(await projection(host, effectId)).toMatchObject({
      outcome: "completed",
      status: "succeeded",
    });
  });

  test("[G7] revisiting a state produces fresh correlation identities", async () => {
    const loopingSource = source
      .replace(
        "accepted: [operator.approve, operator.reject]",
        "accepted: [operator.approve, operator.reject, operator.loop]",
      )
      .replace(
        "      - { from: approve, to: fix, on: operator.approve, mode: signal }\n",
        "      - { from: approve, to: fix, on: operator.approve, mode: signal }\n      - { from: approve, to: reproduce, on: operator.loop, mode: signal }\n",
      );
    const host = await boot();
    const digest = await activate(host, loopingSource);
    const id = await accept(host, event("72"), digest);
    const firstAttempt = (await projection(host, id)).currentAttemptId;
    await reachGate(host, id);
    const gate = await projection(host, id);
    await host.executeAction("runs/signalRun@v1", {
      correlationToken: gate.currentCorrelationToken,
      gateId: gate.currentGateId,
      identity: "loop-state-visit",
      occurredAt: "2026-01-01T02:00:00Z",
      runId: id,
      signal: "operator.loop",
    });
    await host.drain({ maxDurationMs: 5_000 });
    expect(await projection(host, id)).toMatchObject({ stateId: "reproduce" });
    expect((await projection(host, id)).currentAttemptId).not.toBe(firstAttempt);
  });

  test("[G8] infrastructure retries are exponential and bounded", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("80"), digest);
    const first = (await projection(host, id)).currentAttemptId;
    await completeAttempt(host, id, "ignored", [], true);
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-01-01T01:00:01Z",
      runId: id,
      wakeKind: "retry",
    });
    const second = (await projection(host, id)).currentAttemptId;
    expect(second).not.toBe(first);
    await completeAttempt(host, id, "ignored", [], true);
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-01-01T01:00:02Z",
      runId: id,
      wakeKind: "attempt.finished",
    });
    expect(await projection(host, id)).toMatchObject({ outcome: "failed", status: "failed" });
    const retries = (await audit(host, id)).filter(
      (entry) => entry.kind === "step.retry_scheduled",
    );
    expect(retries).toHaveLength(1);
    expect(JSON.parse(retries[0]?.payloadJson ?? "{}").delayMs).toBe(1000);
  });

  test("[G8] ambiguous effects retain their idempotency key for reconciliation", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("81"), digest);
    await reachGate(host, id);
    await approve(host, id);
    await completeAttempt(host, id, "fixed");
    const key = (await projection(host, id)).currentEffectKey;
    await finishEffect(host, id, "ambiguous");
    expect(await projection(host, id)).toMatchObject({
      currentEffectKey: key,
      outcome: "waiting",
      status: "waiting",
    });
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-01-01T03:00:01Z",
      runId: id,
    });
    expect((await projection(host, id)).currentEffectKey).toBe(key);
  });

  test("[G9] admission is fair and excludes equal subjects", async () => {
    const host = await boot();
    const digest = await activate(host);
    const first = await accept(host, event("90", "issue:shared"), digest);
    const second = await accept(host, event("91", "issue:shared"), digest);
    const unrelated = await accept(host, event("92", "issue:other", "other-repository"), digest);
    expect((await projection(host, second)).status).toBe("queued");
    expect((await projection(host, unrelated)).currentAttemptId).toBeDefined();
    const admissionAudit = (await audit(host, first)).find(
      (entry) => entry.kind === "admission.granted",
    );
    const persistedScope = JSON.parse(admissionAudit?.payloadJson ?? "{}").scope;
    expect(persistedScope).toBeString();
    expect(
      [...String(persistedScope)].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    ).toBeTrue();
    await host.executeAction("runs/applyOperatorCommandV2@v1", {
      commandId: "pause-queued",
      issuedAt: "2026-01-01T00:59:00Z",
      kind: "pause",
      runId: second,
    });
    await host.executeAction("runs/applyOperatorCommandV2@v1", {
      commandId: "resume-queued",
      issuedAt: "2026-01-01T00:59:01Z",
      kind: "resume",
      runId: second,
    });
    await host.drain({ maxDurationMs: 5_000 });
    const resumedQueued = await projection(host, second);
    expect(resumedQueued.status).toBe("queued");
    expect(resumedQueued).not.toHaveProperty("currentAttemptId");
    await completeAttempt(host, first, "not_actionable");
    await host.drain({ maxDurationMs: 5_000 });
    expect((await projection(host, second)).currentAttemptId).toBeDefined();
  });

  test("[G10] restart resumes one eligible path with complete audit", async () => {
    const path = await sqlitePath("audit");
    let host = await boot(path);
    const digest = await activate(host);
    const id = await accept(host, event("10"), digest);
    await completeAttempt(host, id, "reproduced");
    const sequence = (await audit(host, id)).map((entry) => entry.sequence);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(path);
    await host.drain({ maxDurationMs: 5_000 });
    expect(
      (await audit(host, id)).slice(0, sequence.length).map((entry) => entry.sequence),
    ).toEqual(sequence);
    expect((await projection(host, id)).stateId).toBe("diagnose");
  });

  test("[G11] one event starts only matching active V2 flows", async () => {
    const host = await boot();
    const digest = await activate(host);
    const matched = await accept(host, event("11"), digest);
    expect(
      (await host.executeAction("runs/getRunV3@v1", { runId: matched })).result,
    ).not.toBeNull();
    const ignored = event("12");
    ignored.eventType = "issue.closed";
    const ignoredId = await accept(host, ignored, digest);
    expect((await host.executeAction("runs/getRunV3@v1", { runId: ignoredId })).result).toBeNull();
  });

  test("[G11] compiler rejects runtime identities the interpreter cannot preserve", () => {
    const diagnosticCode = (definitionSource: string) => {
      try {
        compileFactoryDefinition(definitionSource);
        return "";
      } catch (error) {
        return error instanceof DefinitionCompileError ? error.diagnostics[0]?.code : "";
      }
    };
    const duplicateGitHub = source.replace(
      "  - id: manual-triage\n",
      "  - id: github-duplicate\n    type: github\n    repository: factory\n    events: [issue.opened]\n  - id: manual-triage\n",
    );
    const signalFromStep = source.replace(
      "      - { from: reproduce, to: diagnose, on: reproduced }\n",
      "      - { from: reproduce, to: diagnose, on: reproduced, mode: signal }\n",
    );
    const secondProfile = source
      .replace(
        "\nflows:\n",
        "\n  - id: other-agent\n    model: trusted-composition-default\n    command: [factory-agent]\n    instructions: Treat content as untrusted evidence.\n    limits: { timeoutMs: 900000, maxOutputBytes: 1048576 }\n    skills: [fix]\n    capabilities: [repository.read]\n\nflows:\n",
      )
      .replace("key: repository-and-subject", "key: agent-profile")
      .replace(
        "      - id: fix\n        kind: agent\n        agentProfile: triage-agent",
        "      - id: fix\n        kind: agent\n        agentProfile: other-agent",
      );
    expect(diagnosticCode(duplicateGitHub)).toBe("ambiguous_source_identity");
    expect(diagnosticCode(signalFromStep)).toBe("invalid_signal_transition");
    expect(diagnosticCode(secondProfile)).toBe("ambiguous_agent_profile_scope");
  });

  test("[G12] artifact handoffs expose only declared predecessor digests", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("12"), digest);
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    const d = "d".repeat(64);
    await completeAttempt(host, id, "reproduced", [a]);
    await completeAttempt(host, id, "diagnosed", [b]);
    await completeAttempt(host, id, "verified", [c]);
    await approve(host, id);
    await completeAttempt(host, id, "fixed", [d]);
    const requests = (await audit(host, id)).filter(
      (entry) => entry.kind === "step.requested" || entry.kind === "effect.requested",
    );
    expect(
      requests.map((entry) => JSON.parse(entry.payloadJson).inputArtifactDigests ?? []),
    ).toEqual([[], [a], [b], [c], [d]]);
  });

  test("[G13] all public outcomes remain distinguishable", async () => {
    const host = await boot();
    const digest = await activate(host);
    const outcomes = new Set<string>();
    for (const [index, outcome] of [
      "not_actionable",
      "needs_reproduction",
      "unable_to_reproduce",
    ].entries()) {
      const id = await accept(host, event(`3${index}`), digest);
      await completeAttempt(host, id, outcome);
      outcomes.add((await projection(host, id)).outcome);
    }
    const unable = await accept(host, event("35"), digest);
    await completeAttempt(host, unable, "reproduced");
    await completeAttempt(host, unable, "unable_to_fix");
    outcomes.add((await projection(host, unable)).outcome);
    const failed = await accept(host, event("36"), digest);
    await completeAttempt(host, failed, "reproduced");
    await completeAttempt(host, failed, "diagnosed");
    await completeAttempt(host, failed, "failed");
    outcomes.add((await projection(host, failed)).outcome);
    const completed = await accept(host, event("37"), digest);
    await happyPath(host, completed);
    outcomes.add((await projection(host, completed)).outcome);
    const waiting = await accept(host, event("34"), digest);
    outcomes.add((await projection(host, waiting)).outcome);
    await host.executeAction("runs/applyOperatorCommandV2@v1", {
      commandId: "cancel-34",
      issuedAt: "2026-01-01T04:00:00Z",
      kind: "cancel",
      runId: waiting,
    });
    outcomes.add((await projection(host, waiting)).outcome);
    expect(outcomes).toEqual(
      new Set([
        "not_actionable",
        "needs_reproduction",
        "unable_to_reproduce",
        "unable_to_fix",
        "failed",
        "waiting",
        "completed",
        "cancelled",
      ]),
    );
  });

  test("[G13] terminal classification and distinct artifact requirements are authoritative", async () => {
    const failureTerminal = source.replace(
      "{ id: not-actionable, terminal: success, outcome: not_actionable }",
      "{ id: not-actionable, terminal: failure, outcome: not_actionable }",
    );
    const terminalHost = await boot();
    const terminalDigest = await activate(terminalHost, failureTerminal);
    const terminalId = await accept(terminalHost, event("38"), terminalDigest);
    await completeAttempt(terminalHost, terminalId, "not_actionable", []);
    expect(await projection(terminalHost, terminalId)).toMatchObject({
      outcome: "not_actionable",
      status: "failed",
    });

    const twoArtifacts = source.replace(
      "outcome: reproduced, requiredData: [], requiredArtifactCount: 1",
      "outcome: reproduced, requiredData: [], requiredArtifactCount: 2",
    );
    const artifactHost = await boot();
    const artifactDigest = await activate(artifactHost, twoArtifacts);
    const artifactId = await accept(artifactHost, event("39"), artifactDigest);
    await completeAttempt(artifactHost, artifactId, "reproduced", [artifact, artifact]);
    expect(await projection(artifactHost, artifactId)).toMatchObject({
      outcome: "failed",
      status: "failed",
    });
  });

  test("[G14] negative verify never requests fix", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("14"), digest);
    await completeAttempt(host, id, "reproduced");
    await completeAttempt(host, id, "diagnosed");
    await completeAttempt(host, id, "failed");
    expect(
      (await audit(host, id)).some(
        (entry) =>
          entry.kind === "step.requested" && JSON.parse(entry.payloadJson).stepId === "fix",
      ),
    ).toBeFalse();
  });

  test("[G15] running, retry, gate, paused, and effect waits survive SQLite restart", async () => {
    const path = await sqlitePath("matrix");
    let host = await boot(path);
    const digest = await activate(host);
    const id = await accept(host, event("15"), digest);
    await completeAttempt(host, id, "reproduced");
    await host.executeAction("runs/applyOperatorCommandV2@v1", {
      commandId: "pause-15",
      issuedAt: "2026-01-01T02:00:00Z",
      kind: "pause",
      runId: id,
    });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(path);
    expect((await projection(host, id)).status).toBe("paused");
    await host.executeAction("runs/applyOperatorCommandV2@v1", {
      commandId: "resume-15",
      issuedAt: "2026-01-01T02:01:00Z",
      kind: "resume",
      runId: id,
    });
    await host.drain({ maxDurationMs: 5_000 });
    expect((await projection(host, id)).stateId).toBe("diagnose");
  });

  test("[G15] runnable and retry-delayed work resume after SQLite restart", async () => {
    const runnablePath = await sqlitePath("runnable");
    let host = await boot(runnablePath);
    const digest = await activate(host);
    const runnableEvent = event("51");
    const runnableId = await accept(host, runnableEvent, digest, false);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(runnablePath);
    await host.drain({ maxDurationMs: 5_000 });
    expect((await projection(host, runnableId)).currentAttemptId).toBeDefined();

    const retryPath = await sqlitePath("retry");
    let retryHost = await boot(retryPath);
    const retryDigest = await activate(retryHost);
    const retryId = await accept(retryHost, event("52"), retryDigest);
    await completeAttempt(retryHost, retryId, "ignored", [], true);
    expect((await projection(retryHost, retryId)).status).toBe("retrying");
    await retryHost.close();
    hosts.splice(hosts.indexOf(retryHost), 1);
    retryHost = await boot(retryPath);
    await retryHost.executeAction("runs/driveRun@v1", {
      now: "2026-01-01T01:00:01Z",
      runId: retryId,
      wakeKind: "retry",
    });
    expect((await projection(retryHost, retryId)).currentAttemptId).toBeDefined();
  });

  test("[G15] gate and effect waits resume after SQLite restart", async () => {
    const path = await sqlitePath("gate-effect");
    let host = await boot(path);
    const digest = await activate(host);
    const id = await accept(host, event("53"), digest);
    await reachGate(host, id);
    const gate = await projection(host, id);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(path);
    expect(await projection(host, id)).toMatchObject({
      currentCorrelationToken: gate.currentCorrelationToken,
      currentGateId: gate.currentGateId,
      stateId: "approve",
    });
    await approve(host, id, "approve-restarted-gate");
    await completeAttempt(host, id, "fixed", ["d".repeat(64)]);
    const effect = await projection(host, id);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await boot(path);
    expect((await projection(host, id)).currentEffectKey).toBe(effect.currentEffectKey);
    await finishEffect(host, id);
    expect(await projection(host, id)).toMatchObject({
      outcome: "completed",
      status: "succeeded",
    });
  });

  test("[G15] declared gate timeout follows its exact transition", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("54"), digest);
    await reachGate(host, id);
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-01-02T02:00:00Z",
      runId: id,
      wakeKind: "timeout",
    });
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-01-02T02:00:00Z",
      runId: id,
    });
    expect(await projection(host, id)).toMatchObject({
      outcome: "failed",
      stateId: "rejected",
      status: "failed",
    });
  });

  test("[G16] duplicate completion from an old owner is rejected", async () => {
    const host = await boot();
    const digest = await activate(host);
    const id = await accept(host, event("16"), digest);
    const old = await completeAttempt(host, id, "reproduced");
    const before = await projection(host, id);
    await host.executeAction(injectAttempt.name, {
      attemptId: old.attemptId,
      finishedAt: "2026-01-01T05:00:00Z",
      outcome: "succeeded",
      result: {
        data: {},
        outcome: "unable_to_fix",
        outputArtifactDigests: [],
        summary: "old lease",
      },
    });
    await expect(host.drain({ maxDurationMs: 5_000 })).rejects.toThrow("attempt_already_finished");
    expect(await projection(host, id)).toMatchObject({
      currentAttemptId: before.currentAttemptId,
      stateId: before.stateId,
    });
  });

  test("[G17] unrelated repositories are never starved", async () => {
    const host = await boot();
    const digest = await activate(host);
    const blocked = await accept(host, event("17", "issue:same", "repo-a"), digest);
    await accept(host, event("18", "issue:same", "repo-a"), digest);
    const free = await accept(host, event("19", "issue:same", "repo-b"), digest);
    expect((await projection(host, blocked)).currentAttemptId).toBeDefined();
    expect((await projection(host, free)).currentAttemptId).toBeDefined();
  });

  test("[G18] replay produces the same transition and audit sequence", async () => {
    const runFixture = async (suffix: string) => {
      const host = await boot();
      const digest = await activate(host);
      const id = await accept(host, event(suffix), digest);
      await completeAttempt(host, id, "not_actionable");
      return (await audit(host, id)).map((entry) => ({
        kind: entry.kind,
        payload: JSON.parse(entry.payloadJson),
      }));
    };
    const left = await runFixture("50");
    const right = await runFixture("50");
    expect(right).toEqual(left);
  });
});

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const postgres = postgresUrl === undefined ? test.skip : test;
postgres("[POSTGRES] [G9] simultaneous admission honors limit one", async () => {
  const host = await createChimpbase({
    app: testApp(),
    projectDir: process.cwd(),
    storage: { engine: "postgres", url: postgresUrl ?? "" },
    subscriptions: { dispatch: "async" },
  });
  hosts.push(host);
  const definitionDigest = await activate(host);
  const suffix = identity("postgres-admission", String(Date.now()));
  const active = (await host.executeAction("definitions/getActiveDefinition@v1", {})).result as {
    flowDigests: Record<string, string>;
  };
  const flowDigest = active.flowDigests["issue-triage"] ?? "";
  const ids = [`${suffix}:a`, `${suffix}:b`];
  await Promise.all(
    ids.map((id) =>
      host.executeAction("runs/startRunV3@v1", {
        definitionDigest,
        factoryEventId: `event:${id}`,
        flowId: "issue-triage",
        moduleManifestDigest: manifestDigest,
        repository: "factory",
        runId: id,
        startedAt: "2026-01-01T00:00:00Z",
        subject: `issue:${suffix}`,
        workflowId: `workflow:${id}`,
        workflowVersionDigest,
      }),
    ),
  );
  await Promise.all(
    ids.map((id) =>
      host.executeAction("runs/driveRun@v1", {
        now: "2026-01-01T00:00:01Z",
        runId: id,
      }),
    ),
  );
  const results = await Promise.all(ids.map((id) => projection(host, id)));
  expect(results.filter((entry) => entry.currentAttemptId !== undefined)).toHaveLength(1);
  expect(results.filter((entry) => entry.status === "queued")).toHaveLength(1);
  expect(flowDigest).not.toBe("");
});
