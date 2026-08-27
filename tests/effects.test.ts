import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { chimpbaseModuleResourceName, defineChimpbaseApp } from "chimpbase/core";
import { action } from "chimpbase/runtime";
import { createChimpbase } from "chimpbase/runtime/bun";

import { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import { GitHubEventNormalizer } from "../src/adapters/github-event-normalizer.ts";
import {
  FetchGitHubWriteTransport,
  GitHubWriteError,
} from "../src/adapters/github-write-transport.ts";
import type { AgentRuntime, GitHubWriteTransport } from "../src/adapters/seams.ts";
import {
  type EffectIntentV3,
  type EffectOperationV3,
  type EffectReceiptV3,
  effectFinished,
  effectFinishedV2,
  effectFinishedV3,
  effectIntent,
  effectIntentV2,
  effectIntentV3,
  effectOutcome,
  effectReceipt,
  effectReceiptV2,
  effectResultV3,
} from "../src/contracts/index.ts";
import { effectMarker } from "../src/effects/comment-renderer.ts";
import { compileEffectPolicy, effectPayloadDigest } from "../src/effects/policy.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";
import {
  FakeAgentRuntime,
  FakeGitHubWriteTransport,
  FakeGitPublisher,
} from "../src/testing/fakes.ts";

const factorySource = await readFile(new URL("../factory.yaml", import.meta.url), "utf8");
const policy = compileEffectPolicy(factorySource);
const now = "2026-08-27T12:00:00.000Z";

const injectLegacyEffectForTest = action({
  name: "test.injectLegacyEffect",
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

type Host = Awaited<ReturnType<typeof createChimpbase>>;
async function boot(
  input: {
    effectPolicy?: typeof policy;
    agentRuntime?: AgentRuntime;
    pinnedPolicy?: boolean;
    gitPublisher?: FakeGitPublisher;
    syncSubscriptions?: boolean;
    transport?: GitHubWriteTransport;
  } = {},
) {
  const transport = input.transport ?? new FakeGitHubWriteTransport();
  const gitPublisher = input.gitPublisher ?? new FakeGitPublisher();
  const softwareFactoryApp = createSoftwareFactoryApp({
    ...(input.agentRuntime === undefined ? {} : { agentRuntime: input.agentRuntime }),
    ...(input.pinnedPolicy === true ? {} : { effectPolicy: input.effectPolicy ?? policy }),
    gitPublisher,
    githubWriteTransport: transport,
    moduleManifestDigest: "manifest:g10-engine",
    now: () => new Date(now),
    readTransport: unavailableGitHubReadTransport,
    workflowVersionDigest: "workflow-digest:g10-engine",
  });
  const host = await createChimpbase({
    app: defineChimpbaseApp({
      ...softwareFactoryApp,
      registrations: [...softwareFactoryApp.registrations, injectLegacyEffectForTest],
    }),
    projectDir: process.cwd(),
    storage: { engine: "memory" },
    subscriptions: { dispatch: input.syncSubscriptions === true ? "sync" : "async" },
  });
  return { gitPublisher, host, transport };
}

function operation(kind: EffectOperationV3["kind"], suffix = "a"): EffectOperationV3 {
  switch (kind) {
    case "add-label":
    case "remove-label":
      return { kind, payload: { issueNumber: 26, label: `label-${suffix}` } };
    case "create-comment":
      return { kind, payload: { artifactDigests: [], issueNumber: 26 } };
    case "update-comment":
      return {
        kind,
        payload: { artifactDigests: [], commentId: `comment-${suffix}`, issueNumber: 26 },
      };
    case "create-branch":
      return { kind, payload: { baseRevision: `base-${suffix}`, branch: `factory/${suffix}` } };
    case "delete-branch":
      return { kind, payload: { branch: `factory/${suffix}`, headRevision: `head-${suffix}` } };
    case "push-verified-commit":
      return {
        kind,
        payload: {
          baseRevision: `base-${suffix}`,
          branch: `factory/${suffix}`,
          commitMessage: `verified ${suffix}`,
          treeDigest: `tree-${suffix}`,
          verified: true,
        },
      };
    case "create-pull-request":
      return {
        kind,
        payload: { artifactDigests: [], base: "main", head: `factory/${suffix}`, title: suffix },
      };
    case "update-pull-request":
      return {
        kind,
        payload: { artifactDigests: [], pullRequestNumber: 41, title: suffix },
      };
  }
}

function capability(kind: EffectOperationV3["kind"]): string {
  if (kind === "add-label" || kind === "remove-label") return "issue.label";
  if (kind === "create-comment" || kind === "update-comment") return "issue.comment";
  if (kind === "create-pull-request" || kind === "update-pull-request") return "pull-request.write";
  return "repository.write";
}

function stepId(kind: EffectOperationV3["kind"]): string {
  if (kind === "add-label" || kind === "remove-label") return "label-fix-pending";
  if (kind === "create-comment" || kind === "update-comment") return "publish-comment";
  if (kind === "create-pull-request" || kind === "update-pull-request") return "publish-pr";
  return "publish-branch";
}

function intent(
  id: string,
  effect: EffectOperationV3 = operation("add-label", id),
  patch: Partial<EffectIntentV3> = {},
): EffectIntentV3 {
  return {
    capability: capability(effect.kind),
    correlationToken: `correlation:${id}`,
    dryRun: false,
    expectedExternalRevision: null,
    idempotencyKey: `effect:${id}`,
    operation: effect,
    payloadDigest: effectPayloadDigest(effect),
    provenance: {
      agentProfileId: null,
      definitionDigest: policy.definitionDigest,
      flowId: "issue-triage",
      requestedBy: "runs",
      runId: `run:${id}`,
      stepId: stepId(effect.kind),
    },
    requestedAt: now,
    target: { repository: "factory", subject: "issue:26" },
    ...patch,
  };
}

async function request(host: Host, value: EffectIntentV3): Promise<EffectReceiptV3> {
  return (await host.executeAction("effects/requestEffectV3@v1", value)).result as EffectReceiptV3;
}

async function receipt(host: Host, idempotencyKey: string): Promise<EffectReceiptV3 | null> {
  return (await host.executeAction("effects/getReceiptV3@v1", { idempotencyKey }))
    .result as EffectReceiptV3 | null;
}
async function finish(host: Host, idempotencyKey: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await receipt(host, idempotencyKey);
    if (current?.status === "finished") return current;
    await host.processNextQueueJob();
  }
  throw new Error(`effect did not finish: ${idempotencyKey}`);
}

function applied(id: string, outcome: "applied" | "already_applied" = "applied") {
  return effectResultV3.parse({
    externalId: `external:${id}`,
    externalRevision: `revision:${id}`,
    externalUrl: `https://example.invalid/${id}`,
    failureCategory: null,
    outcome,
  });
}

async function storePrivateArtifact(
  host: Host,
  id: string,
  content: string,
  kind: "log" | "report.md" = "report.md",
) {
  const bytes = Buffer.from(content, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await host.executeAction("assets/storeArtifactV2@v1", {
    artifact: {
      attemptId: `attempt:${id}`,
      classification: "private",
      createdAt: now,
      digest,
      kind,
      mediaType: "text/plain; charset=utf-8",
      name: `${id}.${kind === "log" ? "log" : "md"}`,
      redaction: "raw-private",
      retention: "retained",
      runId: `run:${id}`,
      size: bytes.byteLength,
    },
    contentBase64: bytes.toString("base64"),
  });
  return digest;
}

const kinds: EffectOperationV3["kind"][] = [
  "add-label",
  "remove-label",
  "create-comment",
  "update-comment",
  "create-branch",
  "delete-branch",
  "push-verified-commit",
  "create-pull-request",
  "update-pull-request",
];

describe("leaf-07 effects", () => {
  test("[G1] Duplicate intent produces one queued/applied receipt", async () => {
    const { host, transport } = await boot();
    try {
      const value = intent("g1");
      expect((await request(host, value)).status).toBe("queued");
      const existing = await receipt(host, value.idempotencyKey);
      expect(existing).not.toBeNull();
      if (existing === null) throw new Error("strict receipt was not persisted");
      expect(await request(host, value)).toEqual(existing);
      expect((await finish(host, value.idempotencyKey)).outcome).toBe("applied");
      expect(
        (transport as FakeGitHubWriteTransport).calls.filter(({ method }) => method === "apply"),
      ).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test("[G2] Undeclared capability and stale precondition reject before adapter invocation", async () => {
    const transport = new FakeGitHubWriteTransport({ inspections: [{ revision: "human-new" }] });
    const { host } = await boot({ transport });
    try {
      const forbidden = intent("g2-forbidden", operation("add-label"), {
        capability: "repository.write",
      });
      await expect(request(host, forbidden)).rejects.toThrow("effect_forbidden");
      expect(transport.calls).toHaveLength(0);
      const stale = intent("g2-stale", operation("add-label"), {
        expectedExternalRevision: "old",
      });
      await request(host, stale);
      expect((await finish(host, stale.idempotencyKey)).outcome).toBe("conflict");
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  test("[G3] Dry-run records planned result and calls no adapter", async () => {
    const { host, transport } = await boot();
    try {
      const value = intent("g3", operation("add-label"), { dryRun: true });
      await request(host, value);
      expect((await finish(host, value.idempotencyKey)).outcome).toBe("applied");
      expect((transport as FakeGitHubWriteTransport).calls).toHaveLength(0);
      const plan = (
        await host.executeAction("effects/getDryRunV3@v1", {
          idempotencyKey: value.idempotencyKey,
        })
      ).result;
      expect(plan).toEqual({
        idempotencyKey: value.idempotencyKey,
        operation: value.operation,
        payloadDigest: value.payloadDigest,
        plannedAt: now,
        target: value.target,
      });
    } finally {
      await host.close();
    }
  });

  test("[G4] Agents cannot construct executable credentials or bypass policy", async () => {
    const transport = new FakeGitHubWriteTransport();
    const { host } = await boot({ transport });
    try {
      const injected = {
        ...intent("g4"),
        credentials: { token: "secret-token" },
      };
      const queued = await host.executeAction("effects/requestEffectV3@v1", injected);
      expect(JSON.stringify(queued.emittedEvents)).not.toContain("secret-token");
      expect((await request(host, intent("g4"))).status).toBe("queued");
      await finish(host, injected.idempotencyKey);
      expect(JSON.stringify(transport.calls)).not.toContain("secret-token");
      await expect(
        request(
          host,
          intent("g4-agent", operation("add-label"), {
            provenance: {
              ...intent("g4-agent").provenance,
              agentProfileId: "verification-agent",
            },
          }),
        ),
      ).rejects.toThrow("agent profile");
    } finally {
      await host.close();
    }
    const pinned = await boot({ pinnedPolicy: true });
    try {
      await pinned.host.executeAction("definitions/compileDefinition@v1", {
        source: factorySource,
        sourceName: "factory.yaml",
      });
      const value = intent("g4-pinned", operation("add-label"), { dryRun: true });
      await request(pinned.host, value);
      expect((await finish(pinned.host, value.idempotencyKey)).outcome).toBe("applied");
      expect((pinned.transport as FakeGitHubWriteTransport).calls).toHaveLength(0);
    } finally {
      await pinned.host.close();
    }
  });

  test("[G5] Contract tests cover every effect kind/outcome", () => {
    for (const kind of kinds) {
      const parsed = effectIntentV3.parse(intent(`g5-${kind}`, operation(kind, kind)));
      expect(parsed.operation.kind).toBe(kind);
    }
    for (const outcome of ["applied", "already_applied", "conflict", "rejected", "failed"] as const)
      expect(effectResultV3.parse({ ...applied(outcome), outcome }).outcome).toBe(outcome);
    expect(() =>
      effectIntentV3.parse({ ...intent("bad"), operation: { kind: "merge", payload: {} } }),
    ).toThrow();
    const shippedSchemas = {
      effectFinished: [
        effectFinished,
        "da0e39d586b747fa3ad2cc3496bfe898e75248f3bdd27808433acc926bdeded5",
      ],
      effectFinishedV2: [
        effectFinishedV2,
        "ef7fdb2245fa800488cbf1b23ceff4ac8a96439bbb274128a5b60061eac90f14",
      ],
      effectIntent: [
        effectIntent,
        "214d2879c516b084ee2c408150905d155df13c8bcb9bf2830975d01879fe30bd",
      ],
      effectIntentV2: [
        effectIntentV2,
        "848fc0bade3744091995bc80281b4e8d457c42b0acee287dc6e93fc691cd2ba3",
      ],
      effectReceipt: [
        effectReceipt,
        "533c2802143b8761d75766cbc0ce4a22f3ff3e3b011749dc283c02d0703b41c0",
      ],
      effectReceiptV2: [
        effectReceiptV2,
        "5e50d9741d7f53d2fe8e0058845ff13e1b6e4b75a20a0f3ab99fc9981ac16146",
      ],
    } as const;
    for (const [validator, digest] of Object.values(shippedSchemas))
      expect(createHash("sha256").update(JSON.stringify(validator.schema)).digest("hex")).toBe(
        digest,
      );
  });

  test("[G6] Crash/network ambiguity reconciles one external write/receipt", async () => {
    const transport = new FakeGitHubWriteTransport({
      applies: [new GitHubWriteError("accepted then disconnected", "ambiguous_network")],
      probes: [null, applied("g6")],
    });
    const { host } = await boot({ transport });
    try {
      const value = intent("g6");
      await request(host, value);
      expect((await finish(host, value.idempotencyKey)).outcome).toBe("applied");
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test("[G7] Stale branch/issue revision cannot overwrite human changes", async () => {
    const transport = new FakeGitHubWriteTransport({ inspections: [{ revision: "issue:human" }] });
    const gitPublisher = new FakeGitPublisher();
    const { host } = await boot({ gitPublisher, transport });
    try {
      const issue = intent("g7-issue", operation("add-label"), {
        expectedExternalRevision: "issue:old",
      });
      await request(host, issue);
      expect((await finish(host, issue.idempotencyKey)).outcome).toBe("conflict");
      const branchOperation = operation("create-branch", "g7-branch");
      gitPublisher.branches.set("factory:factory/g7-branch", "human-head");
      const branch = intent("g7-branch", branchOperation, {
        expectedExternalRevision: "base-g7-branch",
      });
      await request(host, branch);
      expect((await finish(host, branch.idempotencyKey)).outcome).toBe("conflict");
      expect(gitPublisher.mutations).toHaveLength(0);
      expect(gitPublisher.observations).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test("[G8] Replay returns already-applied without duplicates", async () => {
    const transport = new FakeGitHubWriteTransport();
    const { host } = await boot({ transport });
    try {
      const value = intent("g8");
      await request(host, value);
      await finish(host, value.idempotencyKey);
      expect((await request(host, value)).outcome).toBe("already_applied");
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test("[G9] Bot-authored events correlate to receipts and do not retrigger", async () => {
    const transport = new FakeGitHubWriteTransport({ applies: [applied("g9")] });
    const { host } = await boot({ transport });
    try {
      const value = intent("g9");
      await request(host, value);
      await finish(host, value.idempotencyKey);
      const correlated = (
        await host.executeAction("effects/correlateBotEventV3@v1", {
          actorType: "bot",
          body: effectMarker(value.idempotencyKey),
          externalId: "external:g9",
          observedAt: now,
        })
      ).result as { idempotencyKey: string } | null;
      expect(correlated?.idempotencyKey).toBe(value.idempotencyKey);
      expect(
        new GitHubEventNormalizer().normalize({
          current: {
            author: { login: "software-factory[bot]", type: "bot" },
            body: effectMarker(value.idempotencyKey),
            createdAt: now,
            id: "external:g9",
            issueNumber: 26,
            repository: {
              fullName: "example/software-factory",
              id: "factory",
              name: "software-factory",
              owner: "example",
            },
            updatedAt: now,
          },
          kind: "comment",
          observedAt: now,
          previous: null,
          repositoryId: "factory",
        }),
      ).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("[G10] Permission/rate/conflict cases yield typed outcomes consumed by runs workflow", async () => {
    const transport = new FakeGitHubWriteTransport({
      applies: [new GitHubWriteError("denied", "permission")],
    });
    const { host } = await boot({ transport });
    try {
      const value = intent("g10");
      const revision = (
        await host.executeAction("definitions/compileDefinition@v1", {
          source: factorySource,
          sourceName: "factory.yaml",
        })
      ).result as { definitionDigest: string; flowDigests: Record<string, string> };
      const plan = (
        await host.executeAction("definitions/getExecutionPlan@v1", {
          definitionDigest: revision.definitionDigest,
          flowId: "issue-triage",
        })
      ).result as {
        agentProfileDigests: Record<string, string>;
        flowDigest: string;
        skillRevisions: Record<string, string>;
      };
      await host.executeAction("runs/startRunV2@v1", {
        agentProfileDigests: plan.agentProfileDigests,
        correlation: {
          correlationToken: value.correlationToken,
          effectKey: value.idempotencyKey,
          stepId: "publish",
        },
        definitionDigest: revision.definitionDigest,
        factoryEventId: "event:g10",
        flowDigest: plan.flowDigest,
        flowId: "issue-triage",
        moduleManifestDigest: "manifest:g10",
        runId: value.provenance.runId,
        skillDigests: plan.skillRevisions,
        startedAt: now,
        workflowId: "workflow:g10",
        workflowVersion: 1,
        workflowVersionDigest: "workflow-digest:g10",
      });
      await request(host, value);
      expect((await finish(host, value.idempotencyKey)).outcome).toBe("rejected");
      for (let index = 0; index < 30; index += 1) await host.processNextQueueJob();
      const run = (await host.executeAction("runs/getRunV2@v1", { runId: value.provenance.runId }))
        .result as { status: string };
      expect(run.status).toBe("failed");
    } finally {
      await host.close();
    }
    const legacy = await boot({ syncSubscriptions: true });
    try {
      const revision = (
        await legacy.host.executeAction("definitions/compileDefinition@v1", {
          source: factorySource,
          sourceName: "factory.yaml",
        })
      ).result as { definitionDigest: string; flowDigests: Record<string, string> };
      const plan = (
        await legacy.host.executeAction("definitions/getExecutionPlan@v1", {
          definitionDigest: revision.definitionDigest,
          flowId: "issue-triage",
        })
      ).result as {
        agentProfileDigests: Record<string, string>;
        flowDigest: string;
        skillRevisions: Record<string, string>;
      };
      const legacyIntent = {
        capability: "issue.comment",
        correlationToken: "correlation:g10-legacy",
        expectedExternalRevision: null,
        idempotencyKey: "effect:g10-legacy",
        payloadDigest: "payload:g10-legacy",
        provenance: "run:g10-legacy/step:publish",
        requestedAt: now,
        runId: "run:g10-legacy",
        target: "factory",
      };
      await legacy.host.executeAction("runs/startRunV2@v1", {
        agentProfileDigests: plan.agentProfileDigests,
        correlation: {
          correlationToken: legacyIntent.correlationToken,
          effectKey: legacyIntent.idempotencyKey,
          stepId: "publish",
        },
        definitionDigest: revision.definitionDigest,
        factoryEventId: "event:g10-legacy",
        flowDigest: plan.flowDigest,
        flowId: "issue-triage",
        moduleManifestDigest: "manifest:g10-legacy",
        runId: legacyIntent.runId,
        skillDigests: plan.skillRevisions,
        startedAt: now,
        workflowId: "workflow:g10-legacy",
        workflowVersion: 1,
        workflowVersionDigest: "workflow-digest:g10-legacy",
      });
      await legacy.host.executeAction("effects/requestEffectV2@v1", legacyIntent);
      await legacy.host.executeAction("test.injectLegacyEffect", {
        externalRevision: null,
        finishedAt: now,
        idempotencyKey: legacyIntent.idempotencyKey,
        outcome: "ambiguous",
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await legacy.host.processNextQueueJob();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("effect_adapter_unavailable"))
            throw error;
        }
        const projection = (
          await legacy.host.executeAction("runs/getRunV2@v1", {
            runId: legacyIntent.runId,
          })
        ).result as { status: string };
        if (projection.status === "waiting") break;
      }
      expect(
        (
          await legacy.host.executeAction("runs/getRunV2@v1", {
            runId: legacyIntent.runId,
          })
        ).result,
      ).toMatchObject({
        currentEffectKey: legacyIntent.idempotencyKey,
        status: "waiting",
      });
    } finally {
      await legacy.host.close();
    }

    const publisher = new FakeGitPublisher();
    const strict = await boot({ gitPublisher: publisher, pinnedPolicy: true });
    try {
      const source = `${factorySource.replaceAll(
        "flows: [issue-triage]",
        "flows: [issue-triage, effect-only]",
      )}
  - id: effect-only
    initialState: publish
    triggers:
      - { source: manual-triage, predicates: [] }
    concurrency: { key: repository, limit: 1 }
    artifactHandoffs: []
    steps:
      - id: publish
        kind: effect
        capabilities: [repository.write]
        effectCapability: repository.write
        effectTarget: factory
        effectPayloadDigest: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
        retry: { maxAttempts: 1, backoffMs: 0 }
        results:
          - { outcome: applied, requiredData: [] }
          - { outcome: rejected, requiredData: [] }
    gates: []
    states:
      - { id: publish, step: publish }
      - { id: done, terminal: success, outcome: completed }
      - { id: rejected, terminal: failure, outcome: failed }
    transitions:
      - { from: publish, to: done, on: applied }
      - { from: publish, to: rejected, on: rejected }
`;
      const revision = (
        await strict.host.executeAction("definitions/compileDefinition@v1", {
          source,
          sourceName: "factory.yaml",
        })
      ).result as { definitionDigest: string };
      await strict.host.executeAction("definitions/activateDefinition@v1", {
        definitionDigest: revision.definitionDigest,
      });
      await strict.host.executeAction("runs/startRunV3@v1", {
        definitionDigest: revision.definitionDigest,
        factoryEventId: "event:g10-engine",
        flowId: "effect-only",
        moduleManifestDigest: "manifest:g10-engine",
        repository: "factory",
        repositorySha: "base:g10-engine",
        runId: "run:g10-engine",
        startedAt: now,
        subject: "issue:26",
        workflowId: "workflow:g10-engine",
        workflowVersionDigest: "workflow-digest:g10-engine",
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await strict.host.processNextQueueJob();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("effect_adapter_unavailable"))
            throw error;
        }
        const projection = (
          await strict.host.executeAction("runs/getRunV3@v1", {
            runId: "run:g10-engine",
          })
        ).result as { status: string };
        if (projection.status === "succeeded") break;
      }
      expect(publisher.publications).toHaveLength(0);
      expect(
        (
          await strict.host.executeAction("runs/getRunV3@v1", {
            runId: "run:g10-engine",
          })
        ).result,
      ).toMatchObject({ status: "failed" });
      expect(
        (
          await strict.host.executeAction("runs/getRunAudit@v1", {
            runId: "run:g10-engine",
          })
        ).result,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "effect.rejected" })]));
    } finally {
      await strict.host.close();
    }
    const finalTree = "b".repeat(40);
    const multiPublisher = new FakeGitPublisher();
    const multiRuntime = new FakeAgentRuntime((request) => ({
      attemptId: request.attemptId,
      changedFiles: [],
      commit: { sha: request.stepId === "first" ? "a".repeat(40) : finalTree },
      logs: {
        stderrBytes: 0,
        stderrDigest: "empty",
        stderrTruncated: false,
        stdoutBytes: 0,
        stdoutDigest: "empty",
      },
      outcome: {
        data: {},
        outcome: "next",
        outputArtifactDigests: [],
        summary: request.stepId,
      },
      resources: { cpuMs: 0, maxRssBytes: 0 },
      status: "succeeded",
      tests: [],
      timing: {
        durationMs: 0,
        finishedAt: now,
        startedAt: now,
      },
    }));
    const multi = await boot({
      agentRuntime: multiRuntime,
      gitPublisher: multiPublisher,
      pinnedPolicy: true,
    });
    try {
      const source = `${factorySource.replaceAll(
        "flows: [issue-triage]",
        "flows: [issue-triage, multi-tree]",
      )}
  - id: multi-tree
    initialState: first
    triggers:
      - { source: manual-triage, predicates: [] }
    concurrency: { key: repository, limit: 1 }
    artifactHandoffs:
      - { fromStep: first, toStep: second }
      - { fromStep: second, toStep: publish }
    steps:
      - id: first
        kind: agent
        agentProfile: triage-agent
        capabilities: [repository.read]
        retry: { maxAttempts: 1, backoffMs: 0 }
        results:
          - { outcome: next, requiredData: [] }
      - id: second
        kind: agent
        agentProfile: triage-agent
        capabilities: [repository.read]
        retry: { maxAttempts: 1, backoffMs: 0 }
        results:
          - { outcome: next, requiredData: [] }
      - id: publish
        kind: effect
        capabilities: [repository.write]
        effectCapability: repository.write
        effectTarget: factory
        effectPayloadDigest: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
        retry: { maxAttempts: 1, backoffMs: 0 }
        results:
          - { outcome: applied, requiredData: [] }
          - { outcome: rejected, requiredData: [] }
    gates: []
    states:
      - { id: first, step: first }
      - { id: second, step: second }
      - { id: publish, step: publish }
      - { id: done, terminal: success, outcome: completed }
      - { id: rejected, terminal: failure, outcome: failed }
    transitions:
      - { from: first, to: second, on: next }
      - { from: second, to: publish, on: next }
      - { from: publish, to: done, on: applied }
      - { from: publish, to: rejected, on: rejected }
`;
      const revision = (
        await multi.host.executeAction("definitions/compileDefinition@v1", {
          source,
          sourceName: "factory.yaml",
        })
      ).result as { definitionDigest: string };
      await multi.host.executeAction("definitions/activateDefinition@v1", {
        definitionDigest: revision.definitionDigest,
      });
      await multi.host.executeAction("runs/startRunV3@v1", {
        definitionDigest: revision.definitionDigest,
        factoryEventId: "event:g10-multi",
        flowId: "multi-tree",
        moduleManifestDigest: "manifest:g10-engine",
        repository: "factory",
        repositorySha: "base:g10-multi",
        runId: "run:g10-multi",
        startedAt: now,
        subject: "issue:26",
        workflowId: "workflow:g10-multi",
        workflowVersionDigest: "workflow-digest:g10-engine",
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await multi.host.processNextQueueJob();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("effect_adapter_unavailable"))
            throw error;
        }
        const projection = (
          await multi.host.executeAction("runs/getRunV3@v1", {
            runId: "run:g10-multi",
          })
        ).result as { status: string };
        if (projection.status === "succeeded") break;
      }
      expect(multiPublisher.publications).toHaveLength(1);
      expect(multiPublisher.publications[0]?.treeDigest).toBe(finalTree);
    } finally {
      await multi.host.close();
    }
  });

  test("[G11] Replaying the same intent after success returns the existing receipt and does not duplicate labels, comments, branches, commits, or PRs", async () => {
    const transport = new FakeGitHubWriteTransport();
    const gitPublisher = new FakeGitPublisher();
    const { host } = await boot({ gitPublisher, transport });
    try {
      for (const kind of kinds) {
        const id = `g11-${kind}`;
        let currentOperation = operation(kind, id);
        if ("artifactDigests" in currentOperation.payload) {
          const digest = await storePrivateArtifact(host, id, `public result for ${kind}`);
          currentOperation = {
            ...currentOperation,
            payload: { ...currentOperation.payload, artifactDigests: [digest] },
          } as EffectOperationV3;
        }
        const value = intent(id, currentOperation);
        await request(host, value);
        await finish(host, value.idempotencyKey);
        expect((await request(host, value)).outcome).toBe("already_applied");
      }
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(6);
      expect(gitPublisher.mutations).toHaveLength(1);
      expect(gitPublisher.publications).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test("[G12] A crash after GitHub accepts a write but before local receipt commit reconciles the external state and records one receipt", async () => {
    const transport = new FakeGitHubWriteTransport({
      applies: [new GitHubWriteError("socket closed", "ambiguous_network")],
      probes: [null, applied("g12")],
    });
    const { host } = await boot({ transport });
    try {
      const value = intent("g12");
      await request(host, value);
      const first = await finish(host, value.idempotencyKey);
      const reconciled = (
        await host.executeAction("effects/reconcileEffectV3@v1", {
          idempotencyKey: value.idempotencyKey,
          observedAt: "2026-08-27T12:01:00.000Z",
        })
      ).result;
      expect(reconciled).toEqual(first);
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
    } finally {
      await host.close();
    }
    const urls: string[] = [];
    const marker = effectMarker("effect:g12-pages");
    const paged = new FetchGitHubWriteTransport({
      fetch: async (url) => {
        urls.push(String(url));
        const page = new URL(String(url)).searchParams.get("page");
        const comments =
          page === "1"
            ? Array.from({ length: 100 }, (_, index) => ({
                body: `human ${index}`,
                id: index,
                updated_at: now,
              }))
            : [{ body: marker, id: 101, updated_at: now }];
        return new Response(JSON.stringify(comments), { status: 200 });
      },
      repositories: { factory: "example/software-factory" },
      tokenProvider: {
        async getToken() {
          return "write-token";
        },
      },
    });
    const pagedIntent = intent("g12-pages", operation("create-comment"));
    expect((await paged.probe({ intent: pagedIntent, marker }))?.outcome).toBe("already_applied");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`since=${encodeURIComponent(now)}`);
    expect(urls[1]).toContain("page=2");
  });

  test("[G13] A stale expected issue/branch revision reports a conflict and cannot silently overwrite external work", async () => {
    const transport = new FakeGitHubWriteTransport({ inspections: [{ revision: "human-edit" }] });
    const { host } = await boot({ transport });
    try {
      const value = intent("g13", operation("update-comment"), {
        expectedExternalRevision: "factory-old",
      });
      await request(host, value);
      expect(await finish(host, value.idempotencyKey)).toMatchObject({
        failureCategory: "conflict",
        outcome: "conflict",
      });
      expect(transport.calls.filter(({ method }) => method === "apply")).toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  test("[G14] Dry-run records exactly what would change while a fake/real transport observes zero writes", async () => {
    let fetchCalls = 0;
    const real = new FetchGitHubWriteTransport({
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      repositories: { factory: "example/software-factory" },
      tokenProvider: {
        async getToken() {
          return "write-token";
        },
      },
    });
    const globalPolicy = compileEffectPolicy(
      factorySource.replace("dryRun: false", "dryRun: true"),
    );
    const { host } = await boot({ effectPolicy: globalPolicy, transport: real });
    try {
      const base = intent("g14", operation("add-label"));
      const value = {
        ...base,
        provenance: { ...base.provenance, definitionDigest: globalPolicy.definitionDigest },
      };
      await request(host, value);
      await finish(host, value.idempotencyKey);
      expect(fetchCalls).toBe(0);
      expect(
        (
          await host.executeAction("effects/getDryRunV3@v1", {
            idempotencyKey: value.idempotencyKey,
          })
        ).result,
      ).toMatchObject({ operation: value.operation, target: value.target });
    } finally {
      await host.close();
    }
  });

  test("[G15] An intent lacking the declared capability is rejected before transport invocation", async () => {
    const transport = new FakeGitHubWriteTransport();
    const { host } = await boot({ transport });
    try {
      await expect(
        request(
          host,
          intent("g15", operation("create-pull-request"), { capability: "issue.comment" }),
        ),
      ).rejects.toThrow("effect_forbidden");
      expect(transport.calls).toHaveLength(0);
    } finally {
      await host.close();
    }
    const narrowedPolicy = policy;
    const narrowed = await boot({ effectPolicy: narrowedPolicy });
    try {
      const base = intent("g15-step-scope", operation("add-label"));
      await expect(
        request(narrowed.host, {
          ...base,
          provenance: {
            ...base.provenance,
            definitionDigest: narrowedPolicy.definitionDigest,
            stepId: "publish-comment",
          },
        }),
      ).rejects.toThrow("effect_forbidden");
      expect((narrowed.transport as FakeGitHubWriteTransport).calls).toHaveLength(0);
    } finally {
      await narrowed.host.close();
    }
  });

  test("[G16] Comments include run/step provenance and links to public artifacts, but no credentials, raw private logs, or hidden reasoning", async () => {
    const transport = new FakeGitHubWriteTransport();
    const { host } = await boot({ transport });
    try {
      const digest = await storePrivateArtifact(host, "g16", "verified result\ntoken=secret-value");
      const effect = operation("create-comment") as Extract<
        EffectOperationV3,
        { kind: "create-comment" }
      >;
      const value = intent("g16", {
        ...effect,
        payload: { ...effect.payload, artifactDigests: [digest] },
      });
      await request(host, value);
      expect((await finish(host, value.idempotencyKey)).outcome).toBe("applied");
      const body = transport.calls.find(({ method }) => method === "apply")?.input.body ?? "";
      expect(body).toContain("run:g16");
      expect(body).toContain("publish");
      expect(body).toContain("artifact://");
      expect(body).not.toContain("secret-value");
      const logDigest = await storePrivateArtifact(host, "g16-log", "raw private log", "log");
      const logEffect = operation("create-comment") as Extract<
        EffectOperationV3,
        { kind: "create-comment" }
      >;
      const logIntent = intent("g16-log", {
        ...logEffect,
        payload: { ...logEffect.payload, artifactDigests: [logDigest] },
      });
      await request(host, logIntent);
      expect((await finish(host, logIntent.idempotencyKey)).outcome).toBe("rejected");
    } finally {
      await host.close();
    }
  });

  test("[G17] Bot-authored event fixtures do not start a feedback loop", async () => {
    const normalizer = new GitHubEventNormalizer({ botLogins: ["factory-writer"] });
    const events = normalizer.normalize({
      kind: "actions",
      observedAt: now,
      payload: {
        action: "created",
        comment: {
          body: effectMarker("effect:g17"),
          created_at: now,
          id: 17,
          updated_at: now,
          user: { login: "factory-writer", type: "Bot" },
        },
        issue: {
          created_at: now,
          id: 26,
          number: 26,
          state: "open",
          title: "fixture",
          updated_at: now,
          user: { login: "human", type: "User" },
        },
        repository: {
          full_name: "example/software-factory",
          name: "software-factory",
          owner: { login: "example" },
        },
        sender: { login: "factory-writer", type: "Bot" },
      },
      repositoryId: "factory",
    });
    expect(events).toEqual([]);
  });

  test("[G18] Contract tests cover success, already-applied, conflict, rate-limit retry, permission failure, and ambiguous network failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const real = new FetchGitHubWriteTransport({
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { headers: { "retry-after": "60" }, status: 429 })
          : new Response(
              JSON.stringify({
                html_url: "https://example.invalid/label",
                id: 18,
                updated_at: now,
              }),
              { status: 200 },
            );
      },
      repositories: { factory: "example/software-factory" },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      tokenProvider: {
        async getToken() {
          return "separate-write-token";
        },
      },
    });
    const value = intent("g18-rate");
    expect(
      (await real.apply({ intent: value, marker: effectMarker(value.idempotencyKey) })).outcome,
    ).toBe("applied");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2_000]);
    let pullProbeUrl = "";
    const pullMarker = effectMarker("effect:g18-pr");
    const pullTransport = new FetchGitHubWriteTransport({
      fetch: async (url) => {
        pullProbeUrl = String(url);
        return new Response(JSON.stringify([{ body: pullMarker, id: 18, updated_at: now }]), {
          status: 200,
        });
      },
      repositories: { factory: "example/software-factory" },
      tokenProvider: {
        async getToken() {
          return "separate-write-token";
        },
      },
    });
    const pullIntent = intent("g18-pr", operation("create-pull-request", "g18-pr"));
    expect((await pullTransport.probe({ intent: pullIntent, marker: pullMarker }))?.outcome).toBe(
      "already_applied",
    );
    expect(pullProbeUrl).toContain("per_page=100");
    expect(pullProbeUrl).toContain("head=example%3Afactory%2Fg18-pr");
    for (const [category, outcome] of [
      ["conflict", "conflict"],
      ["permission", "rejected"],
      ["ambiguous_network", "failed"],
    ] as const) {
      const transport = new FakeGitHubWriteTransport({
        applies: [new GitHubWriteError(category, category)],
      });
      const { host } = await boot({ transport });
      try {
        const current = intent(`g18-${category}`);
        await request(host, current);
        expect((await finish(host, current.idempotencyKey)).outcome).toBe(outcome);
      } finally {
        await host.close();
      }
    }
    expect(
      effectFinishedV3.parse({
        correlationToken: "c",
        effectId: "e",
        externalId: "x",
        externalRevision: "r",
        externalUrl: "u",
        failureCategory: null,
        finishedAt: now,
        idempotencyKey: "k",
        outcome: "already_applied",
        recordedAt: now,
        runId: "run",
      }).outcome,
    ).toBe("already_applied");
    expect(effectIntent.schema).toBeDefined();
    expect(effectIntentV2.schema).toBeDefined();
    expect(effectReceipt.schema).toBeDefined();
    expect(effectReceiptV2.schema).toBeDefined();
  });
});
