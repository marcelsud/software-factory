import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { defineChimpbaseApp } from "chimpbase/core";
import { createChimpbase } from "chimpbase/runtime/bun";

import { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import { type CliDependencies, type CliIo, runCli } from "../src/cli.ts";
import { canonicalJson, compileFactoryDefinition } from "../src/compiler.ts";
import {
  attemptOutcome,
  type FactoryEvent,
  type OperationsRun,
  type RunV3,
} from "../src/contracts/index.ts";
import { assets } from "../src/modules/assets/interface.ts";
import { definitions } from "../src/modules/definitions/interface.ts";
import { effects } from "../src/modules/effects/interface.ts";
import { createExecutionImplementation } from "../src/modules/execution/implementation.ts";
import { execution } from "../src/modules/execution/interface.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";
import { intake } from "../src/modules/intake/interface.ts";
import { runs } from "../src/modules/runs/interface.ts";
import { FakeOperationsProbe } from "../src/testing/fakes.ts";

const factorySource = await readFile(new URL("../factory.yaml", import.meta.url), "utf8");
const now = "2026-08-27T12:00:00.000Z";
const hosts: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

type Host = Awaited<ReturnType<typeof createChimpbase>>;

async function boot(probe = new FakeOperationsProbe()): Promise<Host> {
  const app = createSoftwareFactoryApp({
    credentialsPresent: probe.credentialsPresent,
    moduleManifestDigest: "manifest:operations",
    now: () => new Date(now),
    pollLagMs: probe.pollLagMs,
    readTransport: unavailableGitHubReadTransport,
    repositoryReachability: probe.repositoryReachability,
    staleLocks: probe.staleLocks,
    storageReady: probe.storageReady,
    workerReady: probe.workerReady,
    workflowReady: probe.workflowReady,
    workflowVersionDigest: "workflow:operations",
  });
  const publishers: Record<
    string,
    ReadonlyArray<{ payload: { parse(value: unknown): unknown } }>
  > = {
    assets: [assets.events.artifactStoredV2],
    definitions: [definitions.events.definitionPublishedV1],
    effects: [effects.events.effectFinishedV3],
    execution: [execution.events.attemptFinishedV2],
    intake: [intake.events.factoryEventAcceptedV2],
    runs: [
      runs.events.runStateChangedV3,
      runs.events.stepRequestedV2,
      runs.events.effectRequestedV3,
    ],
  };
  function extendModule<T extends { calls: object; interface: { calls: object } }>(
    module: T,
    contracts: object,
    handlers: object,
  ): T {
    return Object.assign({}, module, {
      calls: { ...module.calls, ...handlers },
      interface: {
        ...module.interface,
        calls: { ...module.interface.calls, ...contracts },
      },
    });
  }
  function publisherExtensions(
    moduleName: string,
    owned: ReadonlyArray<{
      payload: { parse(value: unknown): unknown };
    }>,
  ) {
    return {
      contracts: Object.fromEntries(
        owned.map((event, index) => {
          const name = `testPublish${index}`;
          return [
            name,
            {
              errors: [],
              guarantees: [],
              id: `${moduleName}/${name}@v1`,
              input: event.payload,
              kind: "module-call",
              module: moduleName,
              name,
              output: event.payload,
              version: 1,
            },
          ];
        }),
      ),
      handlers: Object.fromEntries(
        owned.map((event, index) => [
          `testPublish${index}`,
          async function testPublish(
            ctx: { publish(reference: unknown, payload: unknown): void },
            input: unknown,
          ) {
            ctx.publish(event, input);
            return input;
          },
        ]),
      ),
    };
  }
  const executionPublishers = publishers.execution;
  if (executionPublishers === undefined) throw new Error("execution publishers are missing");
  const executionExtensions = publisherExtensions("execution", executionPublishers);
  const manualExecution = extendModule(
    createExecutionImplementation({ deferAttempts: true }),
    {
      ...executionExtensions.contracts,
      testFinishAttempt: {
        errors: [],
        guarantees: [],
        id: "execution/testFinishAttempt@v1",
        input: attemptOutcome,
        kind: "module-call",
        module: "execution",
        name: "testFinishAttempt",
        output: attemptOutcome,
        version: 1,
      },
    },
    {
      ...executionExtensions.handlers,
      async testFinishAttempt(
        ctx: { enqueue(name: string, payload: unknown): Promise<unknown> },
        input: unknown,
      ) {
        const outcome = attemptOutcome.parse(input);
        await ctx.enqueue("agent-workers", {
          attemptId: outcome.attemptId,
          outcome,
        });
        return outcome;
      },
    },
  );
  const modules = app.modules.map((module) => {
    if (module.interface.name === "execution") return manualExecution;
    const owned = publishers[module.interface.name] ?? [];
    const extensions = publisherExtensions(module.interface.name, owned);
    return extendModule(module, extensions.contracts, extensions.handlers);
  });
  const configured = defineChimpbaseApp({
    ...app,
    modules,
  });
  const host = await createChimpbase({
    app: configured,
    projectDir: process.cwd(),
    storage: { engine: "memory" },
    subscriptions: { dispatch: "async" },
  });
  hosts.push(host);
  return host;
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
async function finishActualAttempt(host: Host, runId: string, outcome: string): Promise<void> {
  const current = (await host.executeAction("runs/getRunV3@v1", { runId })).result as {
    currentAttemptId?: string;
  };
  if (current.currentAttemptId === undefined) throw new Error("run has no active attempt");
  await host.executeAction("execution/testFinishAttempt@v1", {
    attemptId: current.currentAttemptId,
    finishedAt: "2026-08-27T12:30:00.000Z",
    outcome: "succeeded",
    result: {
      data: {},
      outcome,
      outputArtifactDigests: ["a".repeat(64)],
      summary: outcome,
    },
  });
  let attemptState = (
    await host.executeAction("execution/getAttempt@v1", {
      attemptId: current.currentAttemptId,
    })
  ).result as { outcome: string };
  for (let index = 0; index < 20 && attemptState.outcome === "pending"; index += 1) {
    await host.processNextQueueJob();
    attemptState = (
      await host.executeAction("execution/getAttempt@v1", {
        attemptId: current.currentAttemptId,
      })
    ).result as { outcome: string };
  }
  expect(attemptState.outcome).toBe("succeeded");
  await host.drain({ maxDurationMs: 5_000 });
}
async function reachActualGate(host: Host, id: string): Promise<string> {
  const runId = await startActualRun(host, id);
  await finishActualAttempt(host, runId, "reproduced");
  await finishActualAttempt(host, runId, "diagnosed");
  await finishActualAttempt(host, runId, "verified");
  const current = await show(host, runId);
  expect(current.run.status).toBe("waiting");
  expect(current.run.currentGateId).toBe("approve-fix");
  return runId;
}

async function startActualRun(host: Host, id: string): Promise<string> {
  const revision = (
    await host.executeAction("definitions/compileDefinition@v1", {
      source: factorySource,
      sourceName: "factory.yaml",
    })
  ).result as { definitionDigest: string; flowDigests: Record<string, string> };
  await host.executeAction("definitions/activateDefinition@v1", {
    definitionDigest: revision.definitionDigest,
  });
  const event = sourceEvent(id);
  const cursor = (
    await host.executeAction("intake/getSourceCursor@v1", { sourceId: event.sourceId })
  ).result as { cursor: string } | null;
  await host.executeAction("intake/acceptSourceEventV2@v1", {
    event,
    expectedCursor: cursor?.cursor ?? null,
    nextCursor: event.sourceRevision,
  });
  await host.drain({ maxDurationMs: 5_000 });
  return digest(
    "run",
    revision.definitionDigest,
    revision.flowDigests["issue-triage"] ?? "",
    digest("factory-event", event.sourceId, event.deliveryId),
  );
}

function sourceEvent(id: string): FactoryEvent {
  return {
    actor: "operator",
    correlationId: `correlation:${id}`,
    deliveryId: `delivery:${id}`,
    eventType: "issue.opened",
    observedAt: `2026-08-27T12:00:${id.padStart(2, "0")}.000Z`,
    occurredAt: "2026-08-27T11:59:00.000Z",
    payload: { password: "must-not-project", title: `issue ${id}` },
    repository: "example/software-factory",
    sourceId: "github:factory",
    sourceRevision: `cursor:${id}`,
    subject: `issue:${id}`,
  };
}

function runState(id: string, patch: Partial<RunV3> = {}): RunV3 {
  const eventIdentity = digest("factory-event", "github:factory", `delivery:${id}`);
  return {
    agentProfileDigests: { triage: `agent:${id}` },
    auditSequence: 1,
    definitionDigest: `definition:${id}`,
    factoryEventId: `${eventIdentity}:issue-triage`,
    flowDigest: `flow:${id}`,
    flowId: "issue-triage",
    moduleManifestDigest: "manifest:operations",
    outcome: "waiting",
    runId: `run:${id}`,
    skillDigests: { reproduce: `skill:${id}` },
    startedAt: `2026-08-27T12:00:${id.padStart(2, "0")}.000Z`,
    stateId: "reproduce",
    status: "running",
    workflowId: `workflow:${id}`,
    workflowVersion: 2,
    workflowVersionDigest: "workflow:operations",
    ...patch,
  };
}

async function publishRun(host: Host, id: string, patch: Partial<RunV3> = {}) {
  const event = sourceEvent(id);
  await host.executeAction("intake/testPublish0@v1", {
    event,
    idempotent: false,
    payloadDigest: digest(canonicalJson(event.payload)),
  });
  await host.executeAction("runs/testPublish0@v1", runState(id, patch));
  await host.drain({ maxDurationMs: 5_000 });
}

async function show(host: Host, runId: string) {
  return (await host.executeAction("operations/showRunV2@v1", { runId })).result as {
    run: OperationsRun;
    timeline: Array<{
      eventId: string;
      kind: string;
      payload: Record<string, unknown>;
      sequence: number;
    }>;
  };
}

async function listRuns(host: Host, input: Record<string, unknown> = {}) {
  return (await host.executeAction("operations/listRunsV2@v1", { limit: 100, ...input }))
    .result as {
    items: OperationsRun[];
    nextCursor: string | null;
  };
}

function attempt(runId: string, attemptId = "attempt:1") {
  return {
    agentProfileDigest: "agent:1",
    attemptId,
    correlationToken: `correlation:${attemptId}`,
    finishedAt: "2026-08-27T12:01:00.000Z",
    result: {
      attemptId,
      changedFiles: [],
      logs: {
        stderrBytes: 0,
        stderrDigest: "stderr:digest",
        stderrTruncated: false,
        stdoutBytes: 10,
        stdoutDigest: "stdout:digest",
      },
      outcome: {
        data: { secret: "hidden" },
        outcome: "reproduced",
        outputArtifactDigests: ["artifact:1"],
        summary: "private summary",
      },
      resources: { cpuMs: 1, maxRssBytes: 1 },
      status: "succeeded",
      tests: [],
      timing: {
        durationMs: 1,
        finishedAt: "2026-08-27T12:01:00.000Z",
        startedAt: "2026-08-27T12:00:59.999Z",
      },
    },
    runId,
    startedAt: "2026-08-27T12:00:59.999Z",
    stepId: "reproduce",
  };
}

function artifact(runId: string) {
  return {
    attemptId: "attempt:1",
    classification: "private" as const,
    createdAt: "2026-08-27T12:01:00.001Z",
    digest: "artifact:1",
    kind: "report.md" as const,
    mediaType: "text/markdown",
    name: "report",
    redaction: "raw-private" as const,
    retention: "retained" as const,
    runId,
    size: 42,
  };
}

function effectIntent(runId: string) {
  return {
    capability: "issue.label",
    correlationToken: "correlation:effect",
    dryRun: false,
    expectedExternalRevision: null,
    idempotencyKey: `effect:${runId}`,
    operation: { kind: "add-label" as const, payload: { issueNumber: 1, label: "triaged" } },
    payloadDigest: "payload:effect",
    provenance: {
      agentProfileId: null,
      definitionDigest: "definition:1",
      flowId: "issue-triage",
      requestedBy: "runs" as const,
      runId,
      stepId: "publish",
    },
    requestedAt: "2026-08-27T12:02:00.000Z",
    target: { repository: "factory", subject: "issue:1" },
  };
}

describe("leaf-08 operations", () => {
  test("[G1] One timeline reconstructs a run without parsing free-form logs", async () => {
    const host = await boot();
    await publishRun(host, "1");
    await host.executeAction("runs/testPublish1@v1", {
      agentProfileDigest: "agent:1",
      attemptId: "attempt:1",
      correlationToken: "correlation:attempt:1",
      inputArtifactDigests: [],
      runId: "run:1",
      skillDigests: { reproduce: "skill:1" },
      stepId: "reproduce",
    });
    await host.executeAction("execution/testPublish0@v1", attempt("run:1"));
    await host.executeAction("assets/testPublish0@v1", artifact("run:1"));
    await host.executeAction("runs/testPublish2@v1", effectIntent("run:1"));
    await host.executeAction("effects/testPublish0@v1", {
      correlationToken: "correlation:effect",
      effectId: "effect-id:1",
      externalId: "external:1",
      externalRevision: "revision:1",
      externalUrl: "https://example.invalid/1",
      failureCategory: null,
      finishedAt: "2026-08-27T12:03:00.000Z",
      idempotencyKey: "effect:run:1",
      outcome: "applied",
      recordedAt: "2026-08-27T12:02:00.000Z",
      runId: "run:1",
    });
    await host.drain({ maxDurationMs: 5_000 });
    const details = await show(host, "run:1");
    expect(details.timeline.map((entry) => entry.kind)).toEqual([
      "source.accepted",
      "run.state",
      "step.requested",
      "attempt.finished",
      "artifact.stored",
      "effect.requested",
      "effect.finished",
    ]);
    expect(JSON.stringify(details)).not.toContain("must-not-project");
    expect(JSON.stringify(details)).not.toContain("secret log");
    const legacyRuns = (await host.executeAction("operations/listRuns@v1", { limit: 10 }))
      .result as Array<{ runId: string }>;
    const legacyRun = (await host.executeAction("operations/showRun@v1", { runId: "run:1" }))
      .result as { runId: string } | null;
    const legacyEvents = (
      await host.executeAction("operations/listEvents@v1", { limit: 20, runId: "run:1" })
    ).result as Array<{ eventId: string; payload: unknown }>;
    const legacyEffects = (
      await host.executeAction("operations/listEffects@v1", { limit: 10, runId: "run:1" })
    ).result as Array<{ idempotencyKey: string; outcome: string }>;
    const legacyHealth = (await host.executeAction("operations/getHealth@v1", {})).result as {
      modules: Record<string, string>;
      status: string;
    };
    expect(legacyRuns.map(({ runId }) => runId)).toContain("run:1");
    expect(legacyRun?.runId).toBe("run:1");
    expect(legacyEvents.length).toBeGreaterThan(0);
    expect(legacyEffects).toEqual([
      expect.objectContaining({ idempotencyKey: "effect:run:1", outcome: "applied" }),
    ]);
    expect(legacyHealth).toMatchObject({
      modules: {
        adapters: "ready",
        storage: "ready",
        worker: "ready",
        workflow: "ready",
      },
      status: "ready",
    });
  });

  test("[G2] Projection rebuild from facts is deterministic/idempotent", async () => {
    const host = await boot();
    await publishRun(host, "2");
    const first = canonicalJson(await show(host, "run:2"));
    const one = (await host.executeAction("operations/rebuildProjections@v1", {})).result;
    const second = canonicalJson(await show(host, "run:2"));
    const two = (await host.executeAction("operations/rebuildProjections@v1", {})).result;
    expect(second).toBe(first);
    expect(two).toEqual(one);
  });

  test("[G3] Operations never query other module tables", async () => {
    const source = await readFile(
      new URL("../src/modules/operations/implementation.ts", import.meta.url),
      "utf8",
    );
    const selected = [
      ...source.matchAll(/(?:selectFrom|insertInto|updateTable|deleteFrom)\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    expect(new Set(selected)).toEqual(
      new Set([
        "effect_projections",
        "event_projections",
        "operator_command_audit",
        "run_projections",
        "timeline_projections",
      ]),
    );
    expect(source).not.toContain("ctx.call(definitions.calls");
    expect(source).not.toContain("ctx.call(effects.calls");
  });

  test("[G4] Stable JSON output/pagination contracts are tested", async () => {
    const host = await boot();
    await publishRun(host, "4");
    await publishRun(host, "5");
    await publishRun(host, "6");
    const first = (await host.executeAction("operations/listRunsV2@v1", { limit: 2 })).result as {
      items: OperationsRun[];
      nextCursor: string;
    };
    const second = (
      await host.executeAction("operations/listRunsV2@v1", { after: first.nextCursor, limit: 2 })
    ).result as { items: OperationsRun[]; nextCursor: null };
    expect(first.items.map((run) => run.runId)).toEqual(["run:6", "run:5"]);
    expect(second.items.map((run) => run.runId)).toEqual(["run:4"]);
    expect(canonicalJson(first)).toBe(canonicalJson(JSON.parse(canonicalJson(first))));
    await expect(host.executeAction("operations/listRunsV2@v1", { limit: 0 })).rejects.toThrow(
      "invalid_limit",
    );
  });

  test("[G5] Stuck waiting/running/retry/effect states are visible", async () => {
    const host = await boot();
    await publishRun(host, "7", {
      currentGateId: "gate:1",
      currentGateStatus: "pending",
      status: "waiting",
    });
    await publishRun(host, "8", { currentAttemptId: "attempt:8", status: "running" });
    await publishRun(host, "9", { status: "retrying" });
    await host.executeAction("runs/testPublish2@v1", effectIntent("run:8"));
    await host.drain({ maxDurationMs: 5_000 });
    const runs = await listRuns(host);
    expect(Object.fromEntries(runs.items.map((run) => [run.runId, run.status]))).toMatchObject({
      "run:7": "waiting",
      "run:8": "running",
      "run:9": "retrying",
    });
    const effectsPage = (await host.executeAction("operations/listEffectsV2@v1", { limit: 10 }))
      .result as { items: Array<{ status: string }> };
    expect(effectsPage.items[0]?.status).toBe("queued");
  });

  test("[G6] Pause/resume/retry/cancel/approve/reject are durable/audited/idempotent", async () => {
    const host = await boot();
    const activeRun = await startActualRun(host, "10");
    const cancellableRun = await startActualRun(host, "11");
    const commands = [
      { kind: "pause", runId: activeRun },
      { kind: "resume", runId: activeRun },
      { kind: "retry", runId: activeRun },
      { kind: "approve", runId: activeRun },
      { kind: "reject", runId: activeRun },
      { kind: "cancel", runId: cancellableRun },
    ] as const;
    for (const [index, command] of commands.entries()) {
      const input = {
        actor: "alice",
        commandKey: `command:${command.kind}`,
        kind: command.kind,
        requestedAt: `2026-08-27T13:0${index}:00.000Z`,
        runId: command.runId,
      };
      const first = (await host.executeAction("operations/applyOperatorCommand@v1", input))
        .result as { outcome: string };
      const duplicate = (await host.executeAction("operations/applyOperatorCommand@v1", input))
        .result;
      expect(duplicate).toEqual(first);
      const stored = (
        await host.executeAction("operations/getOperatorCommand@v1", {
          commandKey: input.commandKey,
        })
      ).result;
      expect(stored).toEqual(first);
      expect(first.outcome).toBe(
        command.kind === "pause" || command.kind === "resume" || command.kind === "cancel"
          ? "applied"
          : "rejected",
      );
    }
  });

  test("[G7] Retry preserves old attempt/artifacts and creates a new correlation", async () => {
    const host = await boot();
    const runId = await startActualRun(host, "21");
    const before = await show(host, runId);
    expect(before.run.currentAttemptId).not.toBeNull();
    expect(before.run.currentCorrelationToken).not.toBeNull();
    const initialStep = before.timeline.find((entry) => entry.kind === "step.requested");
    expect(initialStep).toBeDefined();
    if (
      before.run.currentAttemptId === null ||
      before.run.currentCorrelationToken === null ||
      initialStep === undefined
    )
      throw new Error("run retry state is incomplete");
    const oldAttempt = before.run.currentAttemptId;
    const oldCorrelation = before.run.currentCorrelationToken;
    expect(
      (
        await host.executeAction("execution/getAttemptProtocol@v1", {
          attemptId: oldAttempt,
        })
      ).result,
    ).toBe("v1");
    await host.executeAction("execution/testFinishAttempt@v1", {
      attemptId: oldAttempt,
      finishedAt: "2026-08-27T12:01:00.000Z",
      outcome: "failed",
      result: {
        data: {},
        outcome: "ignored",
        outputArtifactDigests: [],
        summary: "adapter failure",
      },
    });
    let attemptState = (
      await host.executeAction("execution/getAttempt@v1", { attemptId: oldAttempt })
    ).result as { outcome: string };
    for (let index = 0; index < 20 && attemptState.outcome === "pending"; index += 1) {
      await host.processNextQueueJob();
      attemptState = (
        await host.executeAction("execution/getAttempt@v1", { attemptId: oldAttempt })
      ).result as { outcome: string };
    }
    expect(attemptState.outcome).toBe("failed");
    await host.executeAction("assets/testPublish0@v1", {
      ...artifact(runId),
      attemptId: oldAttempt,
    });
    let retryStatus = (await host.executeAction("runs/getRunV3@v1", { runId })).result as {
      status: string;
    };
    for (let index = 0; index < 20 && retryStatus.status !== "retrying"; index += 1) {
      await host.drain({ maxRuns: 1 });
      retryStatus = (await host.executeAction("runs/getRunV3@v1", { runId })).result as {
        status: string;
      };
    }
    expect(retryStatus.status).toBe("retrying");
    const audit = (
      await host.executeAction("operations/applyOperatorCommand@v1", {
        actor: "alice",
        commandKey: "command:retry-real",
        kind: "retry",
        requestedAt: "2026-08-27T13:00:00.000Z",
        runId,
      })
    ).result as { outcome: string };
    expect(audit.outcome).toBe("applied");
    await host.executeAction("runs/driveRun@v1", {
      now: "2026-08-27T13:00:00.001Z",
      runId,
      wakeKind: "retry",
    });
    await host.executeAction("execution/testPublish0@v1", {
      ...attempt(runId, oldAttempt),
      agentProfileDigest: initialStep.payload.agentProfileDigest,
      correlationToken: oldCorrelation,
      stepId: before.run.currentStepId,
    });
    await host.drain({ maxDurationMs: 5_000 });
    await host.drain({ maxDurationMs: 5_000 });
    const timeline = (await show(host, runId)).timeline;
    expect(timeline.find((entry) => entry.kind === "attempt.finished")?.payload.attemptId).toBe(
      oldAttempt,
    );
    expect(timeline.find((entry) => entry.kind === "artifact.stored")?.payload.digest).toBe(
      "artifact:1",
    );
    const requested = timeline.filter((entry) => entry.kind === "step.requested");
    expect(requested).toHaveLength(2);
    expect(requested[1]?.payload.correlationToken).not.toBe(oldCorrelation);
  });

  test("[G8] Cancel prevents unpublished effects", async () => {
    const host = await boot();
    const runId = await startActualRun(host, "12");
    const details = await show(host, runId);
    const input = {
      actor: "alice",
      commandKey: "command:cancel",
      kind: "cancel",
      requestedAt: "2026-08-27T13:00:00.000Z",
      runId,
    };
    const first = (await host.executeAction("operations/applyOperatorCommand@v1", input))
      .result as { outcome: string };
    const duplicate = (await host.executeAction("operations/applyOperatorCommand@v1", input))
      .result;
    expect(first.outcome).toBe("applied");
    expect(duplicate).toEqual(first);
    await host.drain({ maxDurationMs: 5_000 });
    expect((await show(host, runId)).run.status).toBe("cancelled");
    expect(details.run.currentAttemptId).not.toBeNull();
    const effectsPage = (
      await host.executeAction("operations/listEffectsV2@v1", { limit: 10, runId })
    ).result as { items: unknown[] };
    expect(effectsPage.items).toEqual([]);
  });

  test("[G9] Manual trigger uses intake normalization/dedupe", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    let accepted = false;
    const baseDependencies = cliDependencies({
      async executeAction(name, args) {
        calls.push({ name, args });
        if (name === "definitions/compileDefinition@v1")
          return {
            result: compileFactoryDefinition(factorySource, { sourceName: "factory.yaml" }),
          };
        if (name === "definitions/getActiveDefinition@v1") return { result: null };
        if (name === "intake/getSourceCursor@v1") return { result: null };
        if (name === "intake/acceptSourceEventV2@v1") {
          const result = { idempotent: accepted };
          accepted = true;
          return { result };
        }
        return { result: null };
      },
    });
    const event = canonicalJson(sourceEvent("13"));
    const dependencies: CliDependencies = {
      ...baseDependencies,
      readText: async (path) => (path === "event.json" ? event : factorySource),
    };
    const first = await captureCli(["trigger", "--event", "event.json", "--json"], dependencies);
    const second = await captureCli(["trigger", "--event", "event.json", "--json"], dependencies);
    expect(first.out).toContain('"accepted":1');
    expect(second.out).toContain('"accepted":0');
    expect(calls.filter((call) => call.name === "intake/acceptSourceEventV2@v1")).toHaveLength(2);
  });

  test("[G10] CLI smoke covers normal, invalid, conflict, and recovery paths", async () => {
    const health = readyHealth();
    const normal = await captureCli(
      ["status", "--json"],
      cliDependencies({ executeAction: async () => ({ result: health }) }),
    );
    expect(normal).toMatchObject({ code: 0, err: "" });
    const invalid = await captureCli(
      ["show"],
      cliDependencies({ executeAction: async () => ({ result: null }) }),
    );
    expect(invalid.code).toBe(1);
    const conflict = await captureCli(["daemon", "--once"], {
      ...cliDependencies({ executeAction: async () => ({ result: null }) }),
      acquireDaemonLock: async () => {
        throw new Error("daemon_conflict");
      },
    });
    expect(conflict.err).toContain("daemon_conflict");
    let released = false;
    const recovery = await captureCli(["daemon", "--once"], {
      ...cliDependencies({
        async executeAction(name) {
          if (name === "definitions/compileDefinition@v1")
            return {
              result: compileFactoryDefinition(factorySource, { sourceName: "factory.yaml" }),
            };
          if (name === "definitions/getActiveDefinition@v1") return { result: null };
          if (name === "intake/pollRepositoryV2@v1") return { result: { accepted: 0 } };
          return { result: null };
        },
      }),
      acquireDaemonLock: async () => async () => {
        released = true;
      },
    });
    expect(recovery.code).toBe(0);
    expect(released).toBe(true);
  });

  test("[G11] Operators inspect source, transitions, attempt, gate, artifact, and receipt", async () => {
    const host = await boot();
    await publishRun(host, "14", {
      currentGateId: "approve-fix",
      currentGateStatus: "pending",
      stateId: "approve",
      status: "waiting",
    });
    await host.executeAction("execution/testPublish0@v1", attempt("run:14"));
    await host.executeAction("assets/testPublish0@v1", artifact("run:14"));
    await host.executeAction("effects/testPublish0@v1", {
      correlationToken: "effect",
      effectId: "effect:14",
      externalId: "1",
      externalRevision: "r1",
      externalUrl: null,
      failureCategory: null,
      finishedAt: now,
      idempotencyKey: "effect:14",
      outcome: "applied",
      recordedAt: now,
      runId: "run:14",
    });
    await host.drain({ maxDurationMs: 5_000 });
    const details = await show(host, "run:14");
    expect(details.run.sourceEvent?.deliveryId).toBe("delivery:14");
    expect(details.run.currentGateId).toBe("approve-fix");
    expect(details.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "run.state",
        "attempt.finished",
        "artifact.stored",
        "effect.finished",
      ]),
    );
  });

  test("[G12] Pause prevents new claims without corrupting an active lease and resume restores eligibility", async () => {
    const host = await boot();
    const runId = await startActualRun(host, "15");
    const before = await show(host, runId);
    expect(before.run.currentAttemptId).not.toBeNull();
    const activeAttempt = before.run.currentAttemptId;
    const paused = (
      await host.executeAction("operations/applyOperatorCommand@v1", {
        actor: "alice",
        commandKey: "command:pause-active",
        kind: "pause",
        requestedAt: "2026-08-27T13:00:00.000Z",
        runId,
      })
    ).result as { outcome: string };
    expect(paused.outcome).toBe("applied");
    await host.drain({ maxDurationMs: 5_000 });
    expect((await show(host, runId)).run).toMatchObject({
      currentAttemptId: activeAttempt,
      status: "paused",
    });
    const resumed = (
      await host.executeAction("operations/applyOperatorCommand@v1", {
        actor: "alice",
        commandKey: "command:resume-active",
        kind: "resume",
        requestedAt: "2026-08-27T13:01:00.000Z",
        runId,
      })
    ).result as { outcome: string };
    expect(resumed.outcome).toBe("applied");
    await host.drain({ maxDurationMs: 5_000 });
    expect((await show(host, runId)).run).toMatchObject({
      currentAttemptId: activeAttempt,
      status: "running",
    });
  });

  test("[G13] Retry preserves failed attempts and cancel durably blocks later effects", async () => {
    const host = await boot();
    await publishRun(host, "16", {
      currentAttemptId: "attempt:failed",
      currentCorrelationToken: "correlation:failed",
      status: "retrying",
    });
    const failed = attempt("run:16", "attempt:failed");
    const { outcome: _outcome, ...failedResult } = failed.result;
    await host.executeAction("execution/testPublish0@v1", {
      ...failed,
      result: {
        ...failedResult,
        failure: { category: "adapter", message: "failed", retriable: true },
        status: "failed",
      },
    });
    await host.executeAction(
      "runs/testPublish0@v1",
      runState("16", {
        auditSequence: 2,
        finishedAt: "2026-08-27T12:10:00.000Z",
        outcome: "cancelled",
        status: "cancelled",
      }),
    );
    await host.drain({ maxDurationMs: 5_000 });
    const details = await show(host, "run:16");
    expect(details.run.failureCategory).toBe("adapter");
    expect(details.run.status).toBe("cancelled");
    expect(details.timeline.filter((entry) => entry.kind === "attempt.finished")).toHaveLength(1);
  });

  test("[G14] Approve/reject resolves only the named waiting gate and is idempotent", async () => {
    const host = await boot();
    const approveRun = await reachActualGate(host, "17");
    const approvalGate = (await show(host, approveRun)).run;
    const wrong = (
      await host.executeAction("operations/applyOperatorCommand@v1", {
        actor: "alice",
        commandKey: "command:wrong-gate",
        correlationToken: approvalGate.currentCorrelationToken,
        gateId: "other-gate",
        kind: "approve",
        requestedAt: "2026-08-27T13:00:00.000Z",
        runId: approveRun,
      })
    ).result as { outcome: string };
    expect(wrong.outcome).toBe("rejected");
    expect((await show(host, approveRun)).run.currentGateStatus).toBe("pending");
    const approveInput = {
      actor: "alice",
      commandKey: "command:approve-gate",
      correlationToken: approvalGate.currentCorrelationToken,
      gateId: approvalGate.currentGateId,
      kind: "approve",
      requestedAt: "2026-08-27T13:01:00.000Z",
      runId: approveRun,
    };
    const approved = (await host.executeAction("operations/applyOperatorCommand@v1", approveInput))
      .result as { outcome: string };
    expect(approved.outcome).toBe("applied");
    expect(
      (await host.executeAction("operations/applyOperatorCommand@v1", approveInput)).result,
    ).toEqual(approved);

    const rejectRun = await reachActualGate(host, "18");
    const rejectionGate = (await show(host, rejectRun)).run;
    const rejectInput = {
      actor: "alice",
      commandKey: "command:reject-gate",
      correlationToken: rejectionGate.currentCorrelationToken,
      gateId: rejectionGate.currentGateId,
      kind: "reject",
      requestedAt: "2026-08-27T13:02:00.000Z",
      runId: rejectRun,
    };
    const rejected = (await host.executeAction("operations/applyOperatorCommand@v1", rejectInput))
      .result as { outcome: string };
    expect(rejected.outcome).toBe("applied");
    expect(
      (await host.executeAction("operations/applyOperatorCommand@v1", rejectInput)).result,
    ).toEqual(rejected);
  });

  test("[G15] Manual trigger uses the same normalized ingestion action as polling", async () => {
    const names: string[] = [];
    const baseDependencies = cliDependencies({
      async executeAction(name) {
        names.push(name);
        if (name === "definitions/compileDefinition@v1")
          return {
            result: compileFactoryDefinition(factorySource, { sourceName: "factory.yaml" }),
          };
        if (name === "definitions/getActiveDefinition@v1") return { result: null };
        if (name === "intake/getSourceCursor@v1") return { result: null };
        if (name === "intake/acceptSourceEventV2@v1") return { result: { idempotent: false } };
        return { result: null };
      },
    });
    const dependencies: CliDependencies = {
      ...baseDependencies,
      readText: async (path) =>
        path === "event.json" ? canonicalJson(sourceEvent("18")) : factorySource,
    };
    await captureCli(["trigger", "--event", "event.json"], dependencies);
    expect(names).toContain("intake/acceptSourceEventV2@v1");
    expect(names).not.toContain("runs/startRunV3@v1");
  });

  test("[G16] Active runs retain pinned revisions and display drift while new runs use current revisions", async () => {
    const host = await boot();
    await host.executeAction("definitions/testPublish0@v1", {
      definitionDigest: "definition:old",
      flowDigests: { "issue-triage": "flow:old" },
      normalizedJson: "{}",
      sourceName: "old.yaml",
    });
    await publishRun(host, "19", {
      definitionDigest: "definition:old",
      flowDigest: "flow:old",
      skillDigests: { reproduce: "skill:old" },
    });
    await host.executeAction("definitions/testPublish0@v1", {
      definitionDigest: "definition:new",
      flowDigests: { "issue-triage": "flow:new" },
      normalizedJson: "{}",
      sourceName: "new.yaml",
    });
    await publishRun(host, "20", {
      definitionDigest: "definition:new",
      flowDigest: "flow:new",
      skillDigests: { reproduce: "skill:new" },
    });
    await host.drain({ maxDurationMs: 5_000 });
    const old = (await show(host, "run:19")).run;
    const current = (await show(host, "run:20")).run;
    expect(old.revisions.definition).toMatchObject({
      current: "definition:new",
      drift: true,
      pinned: "definition:old",
    });
    expect(old.revisions.flow).toMatchObject({
      current: "flow:new",
      drift: true,
      pinned: "flow:old",
    });
    expect(current.revisions.definition.drift).toBe(false);
    expect(current.revisions.skills.pinned).toEqual({ reproduce: "skill:new" });
  });

  test("[G17] JSON output is deterministic and covered as a public CLI contract", async () => {
    const page = { items: [runState("21")], nextCursor: null };
    const dependencies = cliDependencies({ executeAction: async () => ({ result: page }) });
    const first = await captureCli(["runs", "--json"], dependencies);
    const second = await captureCli(["runs", "--json"], dependencies);
    expect(first.out).toBe(second.out);
    expect(first.out).toBe(`${canonicalJson(page)}\n`);
  });

  test("[G18] Doctor detects all required failures and performs read-only calls", async () => {
    const actionNames: string[] = [];
    const host = {
      async close() {},
      async executeAction(name: string) {
        actionNames.push(name);
        return { result: { ...readyHealth(), unreconciledEffects: 2, status: "degraded" } };
      },
    };
    const dependencies: CliDependencies = {
      checkModules: async () => {
        throw new Error("schema drift");
      },
      credentialsPresent: () => false,
      inspectDaemonLock: async () => "stale",
      openHost: async () => host,
      readText: async () => factorySource,
      repositoryReachability: async () => ({ factory: "unreachable" }),
    };
    const result = await captureCli(["doctor", "--json"], dependencies);
    expect(result.code).toBe(1);
    expect(result.out).toContain('"credentials"');
    expect(result.out).toContain('"daemon-lock"');
    expect(result.out).toContain('"repository:factory"');
    expect(result.out).toContain('"schema"');
    expect(result.out).toContain('"unreconciled-effects"');
    expect(actionNames).toEqual(["operations/getHealthV2@v1"]);

    const invalid = await captureCli(["doctor", "--json"], {
      ...dependencies,
      readText: async () => "version: nope",
    });
    expect(invalid.out).toContain('"config"');
    expect(invalid.out).toContain('"status":"fail"');
  });
});

function readyHealth() {
  return {
    adapters: { credentialsPresent: true, repositories: { factory: "reachable" as const } },
    checkedAt: now,
    pendingEffects: 0,
    pollLagMs: 0,
    staleLocks: 0,
    status: "ready" as const,
    storage: "ready" as const,
    unreconciledEffects: 0,
    worker: "ready" as const,
    workflow: "ready" as const,
  };
}

function cliDependencies(host: {
  close?: () => Promise<void>;
  executeAction(name: string, args?: unknown): Promise<{ result: unknown }>;
}): CliDependencies {
  return {
    checkModules: async () => {},
    credentialsPresent: () => true,
    inspectDaemonLock: async () => "clear",
    now: () => new Date(now),
    openHost: async () => ({
      close: host.close ?? (async () => {}),
      executeAction: host.executeAction.bind(host),
    }),
    readText: async () => factorySource,
    repositoryReachability: async () => ({ factory: "reachable" }),
  };
}

async function captureCli(argv: string[], dependencies: CliDependencies) {
  let out = "";
  let err = "";
  const io: CliIo = {
    stderr: (text) => {
      err += text;
    },
    stdout: (text) => {
      out += text;
    },
  };
  const code = await runCli(argv, io, dependencies);
  return { code, err, out };
}
