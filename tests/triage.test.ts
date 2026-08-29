import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chimpbaseModuleResourceName, defineChimpbaseApp } from "chimpbase/core";
import { action } from "chimpbase/runtime";
import { createChimpbase } from "chimpbase/runtime/bun";

import { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import { SkillResolver } from "../src/assets/skill-resolver.ts";
import { runCli } from "../src/cli.ts";
import { compileFactoryDefinition, DefinitionCompileError } from "../src/compiler.ts";
import {
  attemptOutcome,
  effectOutcome,
  type FactoryEvent,
  parsePatchTestReportV1,
  parseVerificationReportV1,
  triageOutcome,
} from "../src/contracts/index.ts";
import { renderPublicArtifactComment } from "../src/effects/comment-renderer.ts";
import { createExecutionImplementation } from "../src/modules/execution/implementation.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";

const source = await readFile(new URL("../factory.yaml", import.meta.url), "utf8");
const manifestDigest = "manifest-triage-v1";
const workflowVersionDigest = "workflow-triage-v1";
const hosts: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

const injectAttempt = action({
  name: "triage-test.inject-attempt",
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
  name: "triage-test.inject-effect",
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function testApp() {
  const app = createSoftwareFactoryApp({
    moduleManifestDigest: manifestDigest,
    readTransport: unavailableGitHubReadTransport,
    workflowVersionDigest,
  });
  const execution = createExecutionImplementation({ deferAttempts: true });
  return defineChimpbaseApp({
    ...app,
    modules: app.modules.map((module) =>
      module.interface.name === "execution" ? execution : module,
    ),
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

function event(
  id: string,
  eventType = "issue.opened",
  payload: unknown = { action: "opened" },
): FactoryEvent {
  return {
    actor: "maintainer",
    correlationId: `correlation:${id}`,
    deliveryId: `delivery:${id}`,
    eventType,
    observedAt: `2026-08-27T00:${id.padStart(2, "0")}:00Z`,
    occurredAt: "2026-08-27T00:00:00Z",
    payload,
    repository: "factory",
    sourceId: "github:factory",
    sourceRevision: `cursor:${id}`,
    subject: `issue:${Number(id) || 1}`,
  };
}

function runIdentity(definitionDigest: string, flowDigest: string, value: FactoryEvent): string {
  const accepted = digest(["factory-event", value.sourceId, value.deliveryId].join("\0"));
  return digest(["run", definitionDigest, flowDigest, accepted].join("\0"));
}

async function accept(host: Host, value: FactoryEvent, definitionDigest: string): Promise<string> {
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
  await safeDrain(host);
  return runIdentity(definitionDigest, flowDigest, value);
}

async function safeDrain(host: Host): Promise<void> {
  try {
    await host.drain({ maxDurationMs: 5_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("effect_adapter_unavailable"))
      throw error;
  }
}

async function projection(host: Host, runId: string) {
  return (await host.executeAction("runs/getRunV4@v1", { runId })).result as {
    currentAttemptId?: string;
    currentCorrelationToken?: string;
    currentEffectKey?: string;
    currentGateId?: string;
    outcome: string;
    stateId: string;
    status: string;
  };
}

async function audit(host: Host, runId: string) {
  return (await host.executeAction("runs/getRunAudit@v1", { runId })).result as Array<{
    kind: string;
    payloadJson: string;
    sequence: number;
  }>;
}

async function completeAttempt(
  host: Host,
  runId: string,
  outcome: string,
  data: Record<string, unknown>,
  artifacts: string[] = [],
): Promise<string> {
  const current = await projection(host, runId);
  if (current.currentAttemptId === undefined)
    throw new Error(`no attempt: ${JSON.stringify(current)}`);
  await host.executeAction(injectAttempt.name, {
    attemptId: current.currentAttemptId,
    finishedAt: `2026-08-27T01:${String((await audit(host, runId)).length).padStart(2, "0")}:00Z`,
    outcome: "succeeded",
    result: { data, outcome, outputArtifactDigests: artifacts, summary: outcome },
  });
  await safeDrain(host);
  return current.currentAttemptId;
}

async function completeEffect(host: Host, runId: string): Promise<string> {
  const current = await projection(host, runId);
  if (current.currentEffectKey === undefined)
    throw new Error(`no effect: ${JSON.stringify(current)}`);
  await host.executeAction(injectEffect.name, {
    externalRevision: `revision:${current.currentEffectKey}`,
    finishedAt: `2026-08-27T02:${String((await audit(host, runId)).length).padStart(2, "0")}:00Z`,
    idempotencyKey: current.currentEffectKey,
    outcome: "applied",
  });
  await safeDrain(host);
  return current.currentEffectKey;
}

async function reachConfirmation(host: Host, runId: string, cycle = "0"): Promise<void> {
  const reproduction = digest(`reproduction:${cycle}`);
  const diagnosis = digest(`diagnosis:${cycle}`);
  const diagnosisVerification = digest(`diagnosis-verification:${cycle}`);
  const patch = digest(`patch:${cycle}`);
  const testResult = digest(`test:${cycle}`);
  const patchVerification = digest(`patch-verification:${cycle}`);
  await completeAttempt(host, runId, "reproduced", { schemaVersion: 1, summary: "reproduced" }, [
    reproduction,
  ]);
  const producer = await completeAttempt(
    host,
    runId,
    "diagnosed",
    { architectureChecked: true, docsChecked: true, rootCause: "shared defect" },
    [diagnosis],
  );
  const verifier = (await projection(host, runId)).currentAttemptId ?? "missing";
  await completeAttempt(
    host,
    runId,
    "fix_pending",
    { approvedAttemptId: verifier, producerAttemptId: producer },
    [diagnosisVerification],
  );
  const fixer = (await projection(host, runId)).currentAttemptId ?? "missing";
  await completeAttempt(
    host,
    runId,
    "fix_pending",
    { failingTestObserved: true, passingTestObserved: true, treeDigest: digest(`tree:${cycle}`) },
    [patch, testResult],
  );
  const patchVerifier = (await projection(host, runId)).currentAttemptId ?? "missing";
  await completeAttempt(
    host,
    runId,
    "fix_verified",
    { approvedAttemptId: patchVerifier, producerAttemptId: fixer },
    [patchVerification],
  );
  await completeEffect(host, runId);
  await completeEffect(host, runId);
  await completeEffect(host, runId);
  await completeEffect(host, runId);
  expect(await projection(host, runId)).toMatchObject({
    currentGateId: "confirm-fix",
    status: "waiting",
  });
}

async function approveAndFinish(
  host: Host,
  runId: string,
  issueNumber: number,
  commandId = `approve:${runId}`,
): Promise<void> {
  const current = await projection(host, runId);
  if (current.currentGateId === undefined || current.currentCorrelationToken === undefined)
    throw new Error("confirmation gate missing");
  const command = {
    commandId,
    correlationToken: current.currentCorrelationToken,
    gateId: current.currentGateId,
    issuedAt: "2026-08-27T03:00:00Z",
    kind: "approve" as const,
    runId,
  };
  await host.executeAction("runs/applyOperatorCommandV3@v1", command);
  await safeDrain(host);
  await completeAttempt(
    host,
    runId,
    "completed",
    {
      body: `Fixes #${issueNumber}`,
      issueNumber,
      linkedIssue: `#${issueNumber}`,
      title: "Verified fix",
    },
    [digest(`pr-metadata:${runId}`)],
  );
  await completeEffect(host, runId);
}

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close();
  while (directories.length > 0)
    await rm(directories.pop() ?? "", { force: true, recursive: true });
});

describe("leaf-09 triage", () => {
  test("[G1] Every outcome fixture reaches only valid later states", () => {
    const plan = compileFactoryDefinition(source).plansV3["issue-triage"];
    expect(plan).toBeDefined();
    const states = new Set(plan?.states.map(({ id }) => id));
    for (const transition of plan?.transitions ?? []) {
      expect(states.has(transition.from)).toBe(true);
      expect(states.has(transition.to)).toBe(true);
      const state = plan?.states.find(({ id }) => id === transition.from);
      const step = plan?.steps.find(({ id }) => id === state?.step);
      const gate = plan?.gates.find(({ id }) => id === state?.gate);
      expect(
        step?.resultContracts.some(({ outcome }) => outcome === transition.on) ||
          step?.deterministicOutcome === transition.on ||
          gate?.accepted.includes(transition.on),
      ).toBe(true);
    }
    for (const outcome of triageOutcome.parse("completed") === "completed"
      ? [
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
        ]
      : [])
      expect(triageOutcome.parse(outcome)).toBe(outcome);
  });

  test("[G2] Negative/intended verify cannot reach fix", () => {
    const unsafe = source.replace(
      "{ from: verify-diagnosis, to: intended-behavior, on: intended_behavior }",
      "{ from: verify-diagnosis, to: fix, on: intended_behavior }",
    );
    expect(() => compileFactoryDefinition(unsafe)).toThrow(DefinitionCompileError);
    expect(() => compileFactoryDefinition(unsafe)).toThrow(
      "intended behavior verification can reach a fix step",
    );
  });

  test("[G3] Patch without failing-then-passing behavioral test is rejected", async () => {
    expect(() =>
      parsePatchTestReportV1({
        changedFiles: ["src/fix.ts"],
        failingTestObserved: false,
        outcome: "fix_pending",
        passingTestObserved: true,
        reproductionException: null,
        schemaVersion: 1,
        summary: "unverified",
        tests: ["bun test"],
        treeDigest: digest("tree"),
      }),
    ).toThrow("behavioral_test_required");
    const unsafe = source.replace("            behavioralTest: failing-then-passing\n", "");
    expect(() => compileFactoryDefinition(unsafe)).toThrow("behavioral-test requirement");
  });

  test("[G4] Each step uses a fresh attempt and only declared artifacts", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("4"), definition);
    expect(() =>
      parseVerificationReportV1({
        approvedAttemptId: "same",
        checks: ["check"],
        decision: "fix_verified",
        evidence: ["evidence"],
        producerAttemptId: "same",
        schemaVersion: 1,
        summary: "not independent",
      }),
    ).toThrow("independent_verifier_required");
    await reachConfirmation(host, runId, "g4");
    const requests = (await audit(host, runId))
      .filter(({ kind }) => kind === "step.requested")
      .map(
        ({ payloadJson }) =>
          JSON.parse(payloadJson) as {
            attemptId: string;
            inputArtifactDigests: string[];
            stepId: string;
          },
      );
    expect(new Set(requests.map(({ attemptId }) => attemptId)).size).toBe(requests.length);
    const plan = compileFactoryDefinition(source).plansV3["issue-triage"];
    for (const request of requests) {
      const declaredSources = new Set(
        plan?.artifactHandoffs
          .filter(({ toStep }) => toStep === request.stepId)
          .map(({ fromStep }) => fromStep),
      );
      const outputs = new Map<string, string[]>();
      for (const entry of await audit(host, runId)) {
        if (!entry.kind.startsWith("attempt.")) continue;
        const payload = JSON.parse(entry.payloadJson) as {
          stepId?: string;
          result?: { outputArtifactDigests?: string[] };
        };
        if (payload.stepId !== undefined)
          outputs.set(payload.stepId, payload.result?.outputArtifactDigests ?? []);
      }
      const allowed = new Set([...declaredSources].flatMap((stepId) => outputs.get(stepId) ?? []));
      expect(request.inputArtifactDigests.every((artifact) => allowed.has(artifact))).toBe(true);
    }
  });

  test("[G5] Skill/flow/module contracts are pinned and pass compatibility checks", async () => {
    const compiled = compileFactoryDefinition(source);
    const resolver = new SkillResolver({ roots: [join(process.cwd(), "skills")] });
    for (const skill of compiled.definition.skills) {
      const resolved = await resolver.resolve(join(process.cwd(), skill.path));
      expect(resolved.bundle.digest).toBe(skill.revision);
      expect(resolved.bundle.compatibility).toBe(1);
    }
    const plan = compiled.plansV3["issue-triage"];
    expect(plan?.calls).toEqual(
      expect.arrayContaining([
        "runs.startRunV4",
        "execution.requestAttemptV3",
        "effects.requestEffectV2",
      ]),
    );
    expect(plan?.events).toEqual(
      expect.arrayContaining(["AttemptFinished.v1", "EffectFinished.v2", "ArtifactStored.v2"]),
    );
    const legacyPlan = compiled.plansV2["issue-triage"];
    expect("retriage" in (legacyPlan ?? {})).toBe(false);
    expect(
      legacyPlan?.steps.every(
        (step) =>
          !("effectKind" in step) &&
          step.resultContracts.every(
            (contract) => !("behavioralTest" in contract) && !("legacyOnly" in contract),
          ),
      ),
    ).toBe(true);
    const host = await boot();
    const outcomeMappings = [
      ["skipped", "not_actionable"],
      ["intended_behavior", "not_actionable"],
      ["fix_pending", "waiting"],
      ["fix_rejected", "unable_to_fix"],
      ["fix_verified", "completed"],
    ] as const;
    for (const [index, [currentOutcome, shippedOutcome]] of outcomeMappings.entries()) {
      const variant = source.replace(
        "{ id: not-actionable, terminal: success, outcome: not_actionable }",
        `{ id: not-actionable, terminal: success, outcome: ${currentOutcome} }`,
      );
      const definition = await activate(host, variant);
      const runId = await accept(host, event(String(50 + index)), definition);
      await completeAttempt(host, runId, "not_actionable", { summary: currentOutcome });
      expect((await projection(host, runId)).outcome).toBe(currentOutcome);
      const shipped = (await host.executeAction("runs/getRunV3@v1", { runId })).result as {
        outcome: string;
      };
      expect(shipped.outcome).toBe(shippedOutcome);
    }
  });

  test("[G6] One live disposable issue reaches exactly one linked PR after approval", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("6"), definition);
    await reachConfirmation(host, runId, "g6");
    await approveAndFinish(host, runId, 6);
    expect(await projection(host, runId)).toMatchObject({
      outcome: "completed",
      status: "succeeded",
    });
    const entries = await audit(host, runId);
    expect(
      entries.filter(
        ({ kind, payloadJson }) =>
          kind === "effect.requested" && JSON.parse(payloadJson).stepId === "publish-pr",
      ),
    ).toHaveLength(1);
    expect(
      entries.filter(
        ({ kind, payloadJson }) =>
          kind === "step.requested" && JSON.parse(payloadJson).stepId === "pr-writer",
      ),
    ).toHaveLength(1);
  });

  test("[G7] Duplicate approval/comment/poll cannot duplicate effects", async () => {
    const host = await boot();
    const definition = await activate(host);
    const duplicateEvent = event("7");
    const runId = await accept(host, duplicateEvent, definition);
    const cursor = (
      await host.executeAction("intake/getSourceCursor@v1", { sourceId: duplicateEvent.sourceId })
    ).result as { cursor: string };
    const duplicatePoll = (
      await host.executeAction("intake/acceptSourceEventV2@v1", {
        event: duplicateEvent,
        expectedCursor: cursor.cursor,
        nextCursor: cursor.cursor,
      })
    ).result as { idempotent: boolean };
    expect(duplicatePoll.idempotent).toBe(true);
    await safeDrain(host);
    await reachConfirmation(host, runId, "g7");
    const current = await projection(host, runId);
    const command = {
      commandId: "approval:g7",
      correlationToken: current.currentCorrelationToken,
      gateId: current.currentGateId,
      issuedAt: "2026-08-27T03:00:00Z",
      kind: "approve",
      runId,
    };
    await host.executeAction("runs/applyOperatorCommandV3@v1", command);
    await host.executeAction("runs/applyOperatorCommandV3@v1", command);
    await safeDrain(host);
    await completeAttempt(
      host,
      runId,
      "completed",
      { body: "Fixes #7", issueNumber: 7, linkedIssue: "#7", title: "Fix" },
      [digest("g7-pr")],
    );
    await completeEffect(host, runId);
    const entries = await audit(host, runId);
    expect(entries.filter(({ kind }) => kind === "operator.approve")).toHaveLength(1);
    expect(entries.filter(({ kind }) => kind === "run.started")).toHaveLength(1);
    expect(
      entries.filter(
        ({ kind, payloadJson }) =>
          kind === "effect.requested" && JSON.parse(payloadJson).stepId === "publish-pr",
      ),
    ).toHaveLength(1);
  });

  test("[G8] Rejection/new evidence creates bounded new attempt with history", async () => {
    const plan = compileFactoryDefinition(source).plansV3["issue-triage"];
    expect(plan?.retriage).toEqual({ exhaustedState: "fix-rejected", maxAttempts: 2 });
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("8"), definition);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await reachConfirmation(host, runId, `g8-${attempt}`);
      const current = await projection(host, runId);
      await host.executeAction("runs/signalRunV2@v1", {
        correlationToken: current.currentCorrelationToken,
        gateId: current.currentGateId,
        identity: `new-evidence:g8:${attempt}`,
        occurredAt: `2026-08-27T0${attempt + 2}:00:00Z`,
        runId,
        signal: attempt % 2 === 0 ? "comment:reject" : "comment:new-evidence",
      });
      await safeDrain(host);
      await completeEffect(host, runId);
      if (attempt < 3) expect((await projection(host, runId)).stateId).toBe("reproduce");
    }
    expect(await projection(host, runId)).toMatchObject({
      outcome: "fix_rejected",
      status: "failed",
    });
    const entries = await audit(host, runId);
    expect(entries.filter(({ kind }) => kind === "retriage.started")).toHaveLength(2);
    expect(entries.filter(({ kind }) => kind === "retriage.exhausted")).toHaveLength(1);
    const reports = entries.flatMap(({ payloadJson }) => {
      const payload = JSON.parse(payloadJson);
      return payload.result?.outputArtifactDigests ?? [];
    });
    expect(new Set(reports).size).toBeGreaterThanOrEqual(18);
  });

  test("[G9] Restart in each major state resumes correctly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-triage-restart-"));
    directories.push(directory);
    const path = join(directory, "factory.sqlite");
    let host = await boot(path);
    const definition = await activate(host);
    const runId = await accept(host, event("9"), definition);
    expect((await projection(host, runId)).stateId).toBe("reproduce");
    await host.close();
    host = await boot(path);
    expect((await projection(host, runId)).stateId).toBe("reproduce");
    await reachConfirmation(host, runId, "g9");
    await host.close();
    host = await boot(path);
    expect(await projection(host, runId)).toMatchObject({
      currentGateId: "confirm-fix",
      status: "waiting",
    });
    const gate = await projection(host, runId);
    await host.executeAction("runs/applyOperatorCommandV3@v1", {
      commandId: "approve:g9",
      correlationToken: gate.currentCorrelationToken,
      gateId: gate.currentGateId,
      issuedAt: "2026-08-27T03:00:00Z",
      kind: "approve",
      runId,
    });
    await safeDrain(host);
    await host.close();
    host = await boot(path);
    expect(await projection(host, runId)).toMatchObject({
      stateId: "pr-writer",
      status: "running",
    });
    await completeAttempt(
      host,
      runId,
      "completed",
      { body: "Fixes #9", issueNumber: 9, linkedIssue: "#9", title: "Fix" },
      [digest("g9-pr")],
    );
    await host.close();
    host = await boot(path);
    expect(await projection(host, runId)).toMatchObject({
      stateId: "publish-pr",
      status: "running",
    });
    await completeEffect(host, runId);
    await host.close();
    host = await boot(path);
    expect(await projection(host, runId)).toMatchObject({
      outcome: "completed",
      status: "succeeded",
    });
    const fallbackDirectory = await mkdtemp(join(tmpdir(), "factory-triage-v2-plan-"));
    directories.push(fallbackDirectory);
    const fallbackPath = join(fallbackDirectory, "factory.sqlite");
    host = await boot(fallbackPath);
    const fallbackDefinition = await activate(host);
    const fallbackRun = await accept(host, event("49"), fallbackDefinition);
    await host.close();
    const database = new Database(fallbackPath);
    database
      .query("DELETE FROM execution_plans_v3 WHERE definition_digest = ?")
      .run(fallbackDefinition);
    database.close();
    host = await boot(fallbackPath);
    await completeAttempt(
      host,
      fallbackRun,
      "reproduced",
      { schemaVersion: 1, summary: "pre-upgrade" },
      [digest("fallback-reproduction")],
    );
    expect((await projection(host, fallbackRun)).stateId).toBe("diagnose");
  });

  test("[G10] Goal-gate E2E evidence records module/workflow/skill/artifact/effect digests", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("10"), definition);
    await reachConfirmation(host, runId, "g10");
    const started = JSON.parse(
      (await audit(host, runId)).find(({ kind }) => kind === "run.started")?.payloadJson ?? "null",
    );
    expect(started.pins).toMatchObject({
      definitionDigest: definition,
      moduleManifestDigest: manifestDigest,
      workflowVersionDigest,
    });
    const run = (await host.executeAction("runs/getRunV4@v1", { runId })).result as {
      flowDigest: string;
      skillDigests: Record<string, string>;
    };
    expect(run.flowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(run.skillDigests).every((value) => value.startsWith("sha256:"))).toBe(
      true,
    );
    const entries = await audit(host, runId);
    expect(
      entries.some(
        ({ kind, payloadJson }) =>
          kind === "attempt.succeeded" &&
          JSON.parse(payloadJson).result.outputArtifactDigests.length > 0,
      ),
    ).toBe(true);
    expect(
      entries.some(
        ({ kind, payloadJson }) =>
          kind === "effect.requested" &&
          /^[a-f0-9]{64}$/.test(JSON.parse(payloadJson).idempotencyKey),
      ),
    ).toBe(true);
  });

  test("[G11] A deterministic fixture reaches each early-exit outcome without running later phases", async () => {
    const host = await boot();
    const definition = await activate(host);
    for (const [index, outcome] of [
      "not_actionable",
      "needs_reproduction",
      "skipped",
      "unable_to_reproduce",
      "failed",
    ].entries()) {
      const runId = await accept(host, event(String(20 + index)), definition);
      await completeAttempt(host, runId, outcome, { summary: outcome });
      expect((await projection(host, runId)).outcome).toBe(outcome);
      expect(
        (await audit(host, runId)).filter(({ kind }) => kind === "step.requested"),
      ).toHaveLength(1);
    }
  });

  test("[G12] A valid bug fixture produces reproduce, diagnose, verify, patch, test, branch, waiting-gate, and PR artifacts in order", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("12"), definition);
    await reachConfirmation(host, runId, "g12");
    await approveAndFinish(host, runId, 12);
    const ordered = (await audit(host, runId)).map(({ kind, payloadJson }) => {
      const payload = JSON.parse(payloadJson);
      return payload.stepId === undefined ? kind : `${kind}:${payload.stepId}`;
    });
    for (const marker of [
      "step.requested:reproduce",
      "step.requested:diagnose",
      "step.requested:verify-diagnosis",
      "step.requested:fix",
      "step.requested:verify-patch",
      "effect.requested:publish-branch",
      "gate.waiting",
      "step.requested:pr-writer",
      "effect.requested:publish-pr",
      "run.finished",
    ])
      expect(ordered.indexOf(marker)).toBeGreaterThan(-1);
    expect(ordered.indexOf("step.requested:fix")).toBeLessThan(
      ordered.indexOf("step.requested:verify-patch"),
    );
    expect(ordered.indexOf("effect.requested:publish-branch")).toBeLessThan(
      ordered.indexOf("gate.waiting"),
    );
  });

  test("[G13] A verify result that classifies intended behavior cannot reach fix", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("13"), definition);
    await completeAttempt(host, runId, "reproduced", { schemaVersion: 1, summary: "reproduced" }, [
      digest("g13-r"),
    ]);
    await completeAttempt(
      host,
      runId,
      "diagnosed",
      { architectureChecked: true, docsChecked: true, rootCause: "none" },
      [digest("g13-d")],
    );
    await completeAttempt(host, runId, "intended_behavior", { summary: "documented behavior" }, [
      digest("g13-v"),
    ]);
    expect(await projection(host, runId)).toMatchObject({
      outcome: "intended_behavior",
      status: "succeeded",
    });
    expect(
      (await audit(host, runId)).some(
        ({ payloadJson }) => JSON.parse(payloadJson).stepId === "fix",
      ),
    ).toBe(false);
  });

  test("[G14] A patch without a failing-then-passing behavioral test is rejected by the gate", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("14"), definition);
    await completeAttempt(host, runId, "reproduced", { schemaVersion: 1, summary: "r" }, [
      digest("g14-r"),
    ]);
    const producer = await completeAttempt(
      host,
      runId,
      "diagnosed",
      { architectureChecked: true, docsChecked: true, rootCause: "bug" },
      [digest("g14-d")],
    );
    await completeAttempt(
      host,
      runId,
      "fix_pending",
      { approvedAttemptId: "verifier", producerAttemptId: producer },
      [digest("g14-v")],
    );
    await completeAttempt(
      host,
      runId,
      "fix_pending",
      { failingTestObserved: false, passingTestObserved: true, treeDigest: digest("g14-tree") },
      [digest("g14-p"), digest("g14-t")],
    );
    const entries = await audit(host, runId);
    expect(
      entries.some(
        ({ kind, payloadJson }) =>
          kind === "state.transitioned" && JSON.parse(payloadJson).on === "fix_rejected",
      ),
    ).toBe(true);
    expect(entries.some(({ kind }) => kind === "effect.requested")).toBe(false);
  });

  test("[G15] Reporter/maintainer approval creates one linked PR; duplicate approval creates no duplicate branch/comment/PR", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("15"), definition);
    await reachConfirmation(host, runId, "g15");
    const staleApproval = {
      ...event("45", "issue.label_added", {
        untrusted: {
          issue: { labels: ["factory:approved", "unrelated"] },
          label: "unrelated",
        },
      }),
      subject: "issue:15",
    };
    await accept(host, staleApproval, definition);
    expect(await projection(host, runId)).toMatchObject({
      currentGateId: "confirm-fix",
      status: "waiting",
    });
    const current = await projection(host, runId);
    const signal = {
      correlationToken: current.currentCorrelationToken,
      gateId: current.currentGateId,
      identity: "comment:approval:15",
      occurredAt: "2026-08-27T03:00:00Z",
      runId,
      signal: "comment:approve",
    };
    await host.executeAction("runs/signalRunV2@v1", signal);
    await host.executeAction("runs/signalRunV2@v1", signal);
    await safeDrain(host);
    await completeAttempt(
      host,
      runId,
      "completed",
      { body: "Fixes #15", issueNumber: 15, linkedIssue: "#15", title: "Verified fix" },
      [digest("g15-pr")],
    );
    await completeEffect(host, runId);
    const steps = (await audit(host, runId))
      .filter(({ kind }) => kind === "effect.requested")
      .map(({ payloadJson }) => JSON.parse(payloadJson).stepId);
    expect(steps.filter((step) => step === "publish-branch")).toHaveLength(1);
    expect(steps.filter((step) => step === "publish-comment")).toHaveLength(1);
    expect(steps.filter((step) => step === "publish-pr")).toHaveLength(1);
    const rejectRun = await accept(host, event("25"), definition);
    await reachConfirmation(host, rejectRun, "g15-reject");
    const explicitRejection = {
      ...event("48", "issue.label_added", {
        untrusted: {
          issue: { labels: ["factory:approved", "factory:rejected"] },
          label: "factory:rejected",
        },
      }),
      subject: "issue:25",
    };
    await accept(host, explicitRejection, definition);
    expect((await projection(host, rejectRun)).stateId).toBe("cleanup-rejected");
    expect(
      (await audit(host, rejectRun)).some(
        ({ kind, payloadJson }) =>
          kind === "effect.requested" && JSON.parse(payloadJson).stepId === "publish-pr",
      ),
    ).toBe(false);
  });

  test("[G16] Rejection or material new information creates a bounded new attempt with prior reports retained", async () => {
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("16"), definition);
    await reachConfirmation(host, runId, "g16-a");
    const before = (await audit(host, runId))
      .filter(({ kind }) => kind === "attempt.succeeded")
      .flatMap(
        ({ payloadJson }) => JSON.parse(payloadJson).result.outputArtifactDigests as string[],
      );
    const current = await projection(host, runId);
    await host.executeAction("runs/signalRunV2@v1", {
      correlationToken: current.currentCorrelationToken,
      gateId: current.currentGateId,
      identity: "new-evidence:g16",
      occurredAt: "2026-08-27T03:00:00Z",
      runId,
      signal: "comment:new-evidence",
    });
    await safeDrain(host);
    await completeEffect(host, runId);
    const restarted = await projection(host, runId);
    expect(restarted.stateId).toBe("reproduce");
    expect(restarted.currentAttemptId).toBeDefined();
    const retained = (await audit(host, runId)).flatMap(({ payloadJson }) => {
      const payload = JSON.parse(payloadJson);
      return payload.result?.outputArtifactDigests ?? [];
    });
    expect(before.every((artifact) => retained.includes(artifact))).toBe(true);
    expect(
      (await audit(host, runId)).filter(({ kind }) => kind === "retriage.started"),
    ).toHaveLength(1);
  });

  test("[G17] Issue close/cancel prevents unpublished writes and cleans up only factory-owned branches according to policy", async () => {
    const compiled = compileFactoryDefinition(source);
    const cleanup =
      compiled.definition.flows[0]?.steps.filter(
        ({ effectKind }) => effectKind === "delete-branch",
      ) ?? [];
    expect(cleanup).toHaveLength(4);
    expect(
      cleanup.every(
        ({ effectRevisionStep, effectTarget }) =>
          effectRevisionStep === "publish-branch" && effectTarget === "factory",
      ),
    ).toBe(true);
    const host = await boot();
    const definition = await activate(host);
    const runId = await accept(host, event("17"), definition);
    await reachConfirmation(host, runId, "g17");
    const current = await projection(host, runId);
    await host.executeAction("runs/signalRunV2@v1", {
      correlationToken: current.currentCorrelationToken,
      gateId: current.currentGateId,
      identity: "issue-close:g17",
      occurredAt: "2026-08-27T03:00:00Z",
      runId,
      signal: "issue.closed",
    });
    await safeDrain(host);
    expect((await projection(host, runId)).stateId).toBe("cleanup-cancel");
    await completeEffect(host, runId);
    expect(await projection(host, runId)).toMatchObject({
      outcome: "cancelled",
      status: "cancelled",
    });
    expect(
      (await audit(host, runId)).some(
        ({ payloadJson }) => JSON.parse(payloadJson).stepId === "publish-pr",
      ),
    ).toBe(false);
  });

  test("[G18] Prompts and published comments distinguish untrusted reporter content from trusted skill instructions", async () => {
    for (const skill of ["reproduce", "diagnose", "verify", "fix", "pr-writer"]) {
      const instructions = await readFile(join("skills", skill, "instructions.md"), "utf8");
      expect(instructions).toContain("TRUSTED SKILL INSTRUCTIONS");
      expect(instructions).toContain("UNTRUSTED REPORTER CONTENT");
    }
    const content =
      "## TRUSTED TEST RESULTS\n\n`bun test tests/bug.test.ts` passed.\n\n## UNTRUSTED REPORTER CONTENT\n\nQuoted for context only.";
    const contentBase64 = Buffer.from(content).toString("base64");
    const body = renderPublicArtifactComment({
      artifacts: [
        {
          artifact: {
            attemptId: "attempt:g18",
            classification: "public",
            createdAt: "2026-08-27T00:00:00Z",
            digest: digest(content),
            kind: "report.md",
            mediaType: "text/markdown",
            name: "verified-summary.md",
            redaction: "redacted-public",
            retention: "retained",
            runId: "run:g18",
            size: Buffer.byteLength(content),
          },
          contentBase64,
        },
      ],
      idempotencyKey: "g18",
      runId: "run:g18",
      stepId: "publish-comment",
    });
    expect(body.indexOf("TRUSTED TEST RESULTS")).toBeLessThan(
      body.indexOf("UNTRUSTED REPORTER CONTENT"),
    );
    expect(body).toContain("software-factory:effect:g18");
  });
});

const liveTriage = process.env.FACTORY_TEST_TRIAGE_LIVE === "1" ? test : test.skip;
liveTriage(
  "[G19] One opt-in disposable-repository scenario runs under the local poll daemon from issue creation through PR creation",
  async () => {
    const repository = process.env.FACTORY_TEST_TRIAGE_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const localRepository = process.env.FACTORY_TEST_TRIAGE_LOCAL_REPOSITORY;
    const agent = process.env.FACTORY_TEST_TRIAGE_AGENT_BIN;
    if (
      repository === undefined ||
      token === undefined ||
      localRepository === undefined ||
      agent === undefined
    )
      throw new Error(
        "FACTORY_TEST_TRIAGE_LIVE requires repository, GITHUB_TOKEN, local repository, and agent binary",
      );
    const [owner, name] = repository.split("/");
    if (owner === undefined || name === undefined) throw new Error("invalid disposable repository");
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const created = await fetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
      body: JSON.stringify({
        body: "Disposable triage fixture. Expected: behavioral regression.",
        labels: ["bug"],
        title: `factory triage ${Date.now()}`,
      }),
      headers,
      method: "POST",
    });
    if (!created.ok) throw new Error(`issue creation failed: ${created.status}`);
    const issue = (await created.json()) as { number: number };
    const directory = await mkdtemp(join(tmpdir(), "factory-triage-live-"));
    directories.push(directory);
    const config = join(directory, "factory.yaml");
    const liveSource = source
      .replace("owner: example", `owner: ${owner}`)
      .replace("name: software-factory", `name: ${name}`)
      .replace("localPath: .", `localPath: ${JSON.stringify(localRepository)}`)
      .replaceAll("/__factory_agent_bin__", agent);
    await writeFile(config, liveSource);
    const output: string[] = [];
    expect(
      await runCli(["daemon", "--once", "--config", config], {
        stderr: (value) => output.push(value),
        stdout: (value) => output.push(value),
      }),
    ).toBe(0);
    const approval = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues/${issue.number}/comments`,
      {
        body: JSON.stringify({ body: "/factory approve" }),
        headers,
        method: "POST",
      },
    );
    if (!approval.ok) throw new Error(`approval comment failed: ${approval.status}`);
    expect(
      await runCli(["daemon", "--once", "--config", config], {
        stderr: (value) => output.push(value),
        stdout: (value) => output.push(value),
      }),
    ).toBe(0);
    const pulls = await fetch(
      `https://api.github.com/repos/${owner}/${name}/pulls?state=open&head=${owner}:factory%2F`,
      { headers },
    );
    if (!pulls.ok) throw new Error(`pull request lookup failed: ${pulls.status}`);
    const linked = ((await pulls.json()) as Array<{ body: string | null; number: number }>).filter(
      ({ body }) => body?.includes(`#${issue.number}`),
    );
    expect(linked).toHaveLength(1);
    expect(output.join("\n")).toContain("polled");
    const compiled = compileFactoryDefinition(liveSource);
    expect(compiled.revision.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.plansV3["issue-triage"]?.flowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(compiled.plansV3["issue-triage"]?.skillRevisions ?? {})).toHaveLength(5);
  },
);
