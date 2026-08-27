import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChimpbase } from "chimpbase/runtime/bun";
import { parseDocument } from "yaml";

import { createSoftwareFactoryApp, FACTORY_RUNS_V2_WORKFLOW_DIGEST } from "../chimpbase.app.ts";
import { GitHubEventNormalizer } from "../src/adapters/github-event-normalizer.ts";
import { GitHubInvocationEventSource } from "../src/adapters/github-invocation-event-source.ts";
import type {
  AgentRuntime,
  GitHubIssueRecord,
  GitHubPage,
  GitHubReadTransport,
} from "../src/adapters/seams.ts";
import { type CliDependencies, type RunOnceHostConfiguration, runCli } from "../src/cli.ts";
import { compileFactoryDefinition } from "../src/compiler.ts";
import {
  factoryConcurrencyKey,
  parseRunOnceInvocationEnvelope,
  parseRunOnceResult,
  RUN_ONCE_MAX_OUTPUT_BYTES,
  type RunOnceInvocationEnvelope,
  type RunOnceResult,
} from "../src/contracts/index.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";
import { FakeGitHubReadTransport, MemoryArtifactByteDriver } from "../src/testing/fakes.ts";

const directories: string[] = [];
const observedAt = "2026-08-26T12:00:00.000Z";
const issueRecord: GitHubIssueRecord = {
  author: { login: "octocat", type: "user" },
  body: "untrusted body with GITHUB_TOKEN=must-not-leak",
  closedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  id: "101",
  isPullRequest: false,
  labels: ["bug"],
  number: 7,
  repository: { fullName: "example/repo", id: "factory", name: "repo", owner: "example" },
  state: "open",
  stateReason: null,
  title: "Issue",
  updatedAt: "2026-08-26T10:00:00.000Z",
};

interface Scenario {
  readonly config: string;
  readonly database: string;
  readonly directory: string;
  readonly envelope: RunOnceInvocationEnvelope;
  readonly source: string;
}

interface RunOptions {
  readonly acquireDaemonLock?: CliDependencies["acquireDaemonLock"];
  readonly runtime?: AgentRuntime;
  readonly source?: RunOnceInvocationEnvelope["source"];
}

async function scenario(kind: "completed" | "effect" | "retry" | "waiting"): Promise<Scenario> {
  const directory = await mkdtemp(join(tmpdir(), "factory-run-once-"));
  directories.push(directory);
  const config = join(directory, "factory.yaml");
  const source = definition(kind);
  await writeFile(config, source);
  const normalized = parseDocument(source, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  }).toString();
  const definitionRevision = compileFactoryDefinition(normalized, { sourceName: config }).revision
    .definitionDigest;
  return {
    config,
    database: join(directory, "factory.sqlite"),
    directory,
    envelope: invocation(definitionRevision, "issues", "opened", "github-actions"),
    source,
  };
}

function definition(kind: "completed" | "effect" | "retry" | "waiting"): string {
  const common = `version: 1
dryRun: false
repositories:
  - { id: factory, owner: example, name: repo, defaultBranch: main, localPath: . }
sources:
  - { id: github-issues, type: github, repository: factory, events: [issue.opened, issue_comment.created] }
`;
  if (kind === "completed")
    return `${common}capabilities: []
effectPermissions: []
skills: []
agentProfiles: []
flows:
  - id: once
    initialState: done
    triggers:
      - { source: github-issues, predicates: [{ field: eventType, operator: equals, value: issue.opened }] }
    concurrency: { key: repository-and-subject, limit: 1 }
    steps: []
    gates: []
    states:
      - { id: done, terminal: success, outcome: completed }
    transitions: []
`;
  if (kind === "waiting")
    return `${common}capabilities: []
effectPermissions: []
skills: []
agentProfiles: []
flows:
  - id: once
    initialState: await-comment
    triggers:
      - { source: github-issues, predicates: [{ field: eventType, operator: equals, value: issue.opened }] }
    concurrency: { key: repository-and-subject, limit: 1 }
    steps: []
    gates:
      - { id: comment, kind: event, accepted: [issue_comment.created] }
    states:
      - { id: await-comment, gate: comment }
      - { id: done, terminal: success, outcome: completed }
    transitions:
      - { from: await-comment, to: done, on: issue_comment.created, mode: signal }
`;
  if (kind === "effect")
    return `${common}capabilities:
  - { id: issue.comment, description: Publish a comment }
effectPermissions:
  - { capability: issue.comment, targets: [factory], flows: [once], effects: [create-comment] }
skills: []
agentProfiles: []
flows:
  - id: once
    initialState: publish
    triggers:
      - { source: github-issues, predicates: [{ field: eventType, operator: equals, value: issue.opened }] }
    concurrency: { key: repository-and-subject, limit: 1 }
    steps:
      - id: publish
        kind: effect
        capabilities: [issue.comment]
        effectCapability: issue.comment
        effectKind: create-comment
        effectTarget: factory
        effectPayloadDigest: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        retry: { maxAttempts: 2, backoffMs: 100000 }
        results: [{ outcome: applied }, { outcome: already_applied }, { outcome: rejected }]
    gates: []
    states:
      - { id: publish, step: publish }
      - { id: done, terminal: success, outcome: completed }
      - { id: rejected, terminal: failure, outcome: fix_rejected }
    transitions:
      - { from: publish, to: done, on: applied }
      - { from: publish, to: done, on: already_applied }
      - { from: publish, to: rejected, on: rejected }
`;
  return `${common}capabilities:
  - { id: repository.read, description: Read the repository }
effectPermissions: []
skills: []
agentProfiles:
  - id: worker
    model: fake
    command: [${JSON.stringify(process.execPath)}]
    instructions: trusted
    limits: { timeoutMs: 1000, maxOutputBytes: 1024 }
    skills: []
    capabilities: [repository.read]
flows:
  - id: once
    initialState: work
    triggers:
      - { source: github-issues, predicates: [{ field: eventType, operator: equals, value: issue.opened }] }
    concurrency: { key: repository-and-subject, limit: 1 }
    steps:
      - id: work
        kind: agent
        agentProfile: worker
        capabilities: [repository.read]
        retry: { maxAttempts: 2, backoffMs: 100000 }
        results: [{ outcome: completed }, { outcome: failed }]
    gates: []
    states:
      - { id: work, step: work }
      - { id: done, terminal: success, outcome: completed }
      - { id: failed, terminal: failure, outcome: failed }
    transitions:
      - { from: work, to: done, on: completed }
      - { from: work, to: failed, on: failed }
`;
}

function invocation(
  definitionRevision: string,
  name: "issue_comment" | "issues",
  action: "created" | "opened",
  source: RunOnceInvocationEnvelope["source"],
): RunOnceInvocationEnvelope {
  const payload: Record<string, unknown> = {
    action,
    issue: {
      body: "untrusted body with GITHUB_TOKEN=must-not-leak",
      closed_at: null,
      created_at: issueRecord.createdAt,
      id: 101,
      labels: [{ name: "bug" }],
      number: issueRecord.number,
      state: "open",
      title: issueRecord.title,
      updated_at: issueRecord.updatedAt,
      user: { login: "octocat", type: "User" },
    },
    repository: { full_name: "example/repo", name: "repo", owner: { login: "example" } },
    sender: { login: "octocat", type: "User" },
  };
  if (name === "issue_comment")
    payload.comment = {
      body: "continue",
      created_at: "2026-08-26T11:00:00.000Z",
      id: 501,
      updated_at: "2026-08-26T11:00:00.000Z",
      user: { login: "octocat", type: "User" },
    };
  return {
    actor: { login: "octocat", type: "user" },
    context: { job: "factory", runAttempt: "1", runId: "42", workflow: "future-adapter" },
    correlationId: `invocation:${name}:${action}`,
    definitionRevision,
    deliveryId: `delivery:${name}:${action}`,
    event:
      name === "issues"
        ? { action: "opened", name: "issues" }
        : { action: "created", name: "issue_comment" },
    installation: { id: "9001" },
    observedAt,
    payload,
    repository: { fullName: "example/repo", id: "factory" },
    schemaVersion: 1,
    source,
    subject: { id: "101", number: 7 },
  };
}

async function boot(
  configuration: RunOnceHostConfiguration,
  transport: GitHubReadTransport,
  runtime?: AgentRuntime,
) {
  let clockTick = 0;
  return await createChimpbase({
    app: createSoftwareFactoryApp({
      ...(runtime === undefined ? {} : { agentRuntime: runtime }),
      artifactByteDriver: new MemoryArtifactByteDriver(),
      clock: () => new Date(Date.parse(observedAt) + clockTick++),
      credentialsPresent: () => false,
      moduleManifestDigest: "run-once-manifest",
      readTransport: transport,
      repositoryEvents: configuration.repositoryEvents,
      repositoryPins: { "example/repo": "a".repeat(40) },
      sourceRepositories: configuration.sourceRepositories,
      workflowVersionDigest: FACTORY_RUNS_V2_WORKFLOW_DIGEST,
    }),
    projectDir: process.cwd(),
    storage: configuration.storage,
    subscriptions: { dispatch: "async" },
  });
}

async function runOnce(fixture: Scenario, envelope = fixture.envelope, options: RunOptions = {}) {
  const stdout: string[] = [];
  let opened = 0;
  let closed = 0;
  const code = await runCli(
    [
      "run-once",
      "--event",
      "stdin",
      "--config",
      fixture.config,
      "--storage-engine",
      "sqlite",
      "--storage-path",
      fixture.database,
      "--agent-runtime",
      "local-process",
      "--agent-bin",
      process.execPath,
      "--workspace-root",
      join(fixture.directory, "workspaces"),
      "--artifact-root",
      join(fixture.directory, "artifacts"),
      "--artifact-export",
      join(fixture.directory, "public"),
      "--credentials",
      "none",
      "--max-duration-ms",
      "5000",
      "--max-work",
      "100",
      "--json",
    ],
    { stderr: (text) => stdout.push(`stderr:${text}`), stdout: (text) => stdout.push(text) },
    {
      ...(options.acquireDaemonLock === undefined
        ? {}
        : { acquireDaemonLock: options.acquireDaemonLock }),
      checkModules: async () => undefined,
      createAbortController: () => new AbortController(),
      async openRunOnceHost(configuration) {
        opened += 1;
        const host = await boot(configuration, unavailableGitHubReadTransport, options.runtime);
        return {
          close: async () => {
            closed += 1;
            await host.close();
          },
          drain: (limits) => host.drain(limits),
          executeAction: (name, args) => host.executeAction(name, args),
        };
      },
      readStdin: async () =>
        JSON.stringify({ ...envelope, source: options.source ?? envelope.source }),
      readText: (path) => readFile(path, "utf8"),
    },
  );
  const json = stdout.find((entry) => entry.startsWith("{"));
  if (json === undefined) throw new Error(stdout.join(""));
  return { closed, code, opened, result: JSON.parse(json) as RunOnceResult };
}

async function resumeWaiting(fixture: Scenario) {
  const first = await runOnce(fixture);
  const secondEnvelope = invocation(
    fixture.envelope.definitionRevision,
    "issue_comment",
    "created",
    "github-actions",
  );
  const second = await runOnce(fixture, secondEnvelope);
  return { first, second };
}

function page<T>(items: readonly T[]): GitHubPage<T> {
  return {
    items,
    page: {
      etag: '"fixture"',
      nextPage: null,
      notModified: false,
      rate: { limit: 5000, remaining: 4999, resetAt: null, retryAfterMs: null },
    },
  };
}

async function actionFiles(root = "."): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await actionFiles(path)));
    else if (
      entry.name === "action.yml" ||
      entry.name === "action.yaml" ||
      path.startsWith(join(".github", "workflows"))
    )
      files.push(path);
  }
  return files.sort();
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("run-once leaf gates", () => {
  test("[G1] one fixture boots app, ingests, runs, and emits bounded JSON", async () => {
    const result = await runOnce(await scenario("completed"));
    expect(result.code).toBe(0);
    expect(result.opened).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.result.resultClass).toBe("completed");
    expect(result.result.runIds).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result.result))).toBeLessThanOrEqual(
      RUN_ONCE_MAX_OUTPUT_BYTES,
    );
    expect(parseRunOnceResult(result.result)).toEqual(result.result);
  });

  test("[G2] waiting invocation resumes on later invocation with shared storage", async () => {
    const resumed = await resumeWaiting(await scenario("waiting"));
    expect(resumed.first.result.resultClass).toBe("waiting");
    expect(resumed.first.result.pending.gates).toHaveLength(1);
    expect(resumed.second.result.resultClass).toBe("completed");
    expect(resumed.second.result.runIds).toEqual(resumed.first.result.runIds);
  });

  test("[G3] output leaks no credentials or private logs", async () => {
    const result = await runOnce(await scenario("completed"));
    const output = JSON.stringify(result.result);
    expect(output).not.toContain("GITHUB_TOKEN");
    expect(output).not.toContain("must-not-leak");
    expect(output).not.toMatch(/prompt|reasoning|privateLog|credential|secret|token/i);
  });

  test("[G4] business module interfaces and workflow versions are identical to daemon mode", () => {
    const daemon = createSoftwareFactoryApp();
    const once = createSoftwareFactoryApp();
    expect(once.modules.map((module) => module.interface)).toEqual(
      daemon.modules.map((module) => module.interface),
    );
    expect(
      once.modules
        .flatMap((module) => module.registrations)
        .filter((entry) => entry.kind === "workflow"),
    ).toEqual(
      daemon.modules
        .flatMap((module) => module.registrations)
        .filter((entry) => entry.kind === "workflow"),
    );
    expect(FACTORY_RUNS_V2_WORKFLOW_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  });

  test("[G5] no GitHub Actions files are added", async () => {
    expect(await actionFiles()).toEqual([]);
  });

  test("[G6] parity fixture output is identical modulo invocation metadata", async () => {
    const leftFixture = await scenario("completed");
    const rightFixture = await scenario("completed");
    await writeFile(rightFixture.config, leftFixture.source);
    const webhook = { ...leftFixture.envelope, source: "github-webhook" as const };
    const actions = await runOnce(leftFixture);
    const webhookResult = await runOnce(
      { ...rightFixture, envelope: webhook, config: leftFixture.config },
      webhook,
    );
    const normalize = (result: RunOnceResult) => ({ ...result, invocation: undefined });
    expect(normalize(webhookResult.result)).toEqual(normalize(actions.result));
  });

  test("[G7] no local-daemon assumption appears in core modules or workflow", async () => {
    const [runs, intake, app] = await Promise.all([
      readFile("src/modules/runs/implementation.ts", "utf8"),
      readFile("src/modules/intake/implementation.ts", "utf8"),
      readFile("chimpbase.app.ts", "utf8"),
    ]);
    expect(`${runs}\n${intake}\n${app}`).not.toMatch(
      /daemon\.lock|process\.stdin|isTTY|FACTORY_DB_PATH/,
    );
  });

  test("[G8] waiting retry and effect-pending state resume across invocation processes", async () => {
    const retryFixture = await scenario("retry");
    const unavailableRuntime: AgentRuntime = {
      async cancel() {},
      async run() {
        throw new Error("adapter offline");
      },
    };
    const retryFirst = await runOnce(retryFixture, retryFixture.envelope, {
      runtime: unavailableRuntime,
    });
    const retrySecond = await runOnce(retryFixture, retryFixture.envelope, {
      runtime: unavailableRuntime,
    });
    expect(retryFirst.result.resultClass).toBe("waiting");
    expect(retryFirst.result.pending.retries).toHaveLength(1);
    expect(retrySecond.result.runIds).toEqual(retryFirst.result.runIds);
    expect(retrySecond.result.pending.retries).toHaveLength(1);

    const effectFixture = await scenario("effect");
    const effectFirst = await runOnce(effectFixture);
    const effectSecond = await runOnce(effectFixture);
    expect(effectFirst.result.pending.effects).toHaveLength(1);
    expect(effectSecond.result.runIds).toEqual(effectFirst.result.runIds);
    expect(effectSecond.result.pending.effects).toHaveLength(1);
  });

  test("[G9] documentation specifies a semantics-preserving future action", async () => {
    const docs = await readFile("docs/github-actions-adapter.md", "utf8");
    for (const phrase of [
      "Check out",
      "chimpbase modules check",
      "shared PostgreSQL",
      "public artifact export",
      "same delivery",
      "must not change module contracts",
      "does not ship a GitHub Actions workflow",
    ])
      expect(docs).toContain(phrase);
  });

  test("[G10] repository still contains no workflow or action bundle", async () => {
    expect(await actionFiles()).toEqual([]);
    const files = await readdir("src/adapters");
    expect(files.some((file) => /action\.(?:mjs|cjs|js)$/.test(file))).toBe(false);
  });

  test("[G11] long-poll and Actions normalize to one semantic event and pinned flow", async () => {
    const fixture = await scenario("completed");
    const longPoll = new GitHubEventNormalizer().normalize({
      current: issueRecord,
      kind: "issue",
      observedAt,
      previous: null,
      repositoryId: "factory",
    });
    const actions = new GitHubInvocationEventSource().normalize(fixture.envelope);
    expect(actions).toEqual(longPoll);
    const compiled = compileFactoryDefinition(fixture.source, { sourceName: fixture.config });
    expect(compiled.plansV3.once?.flowDigest).toBe(compiled.revision.flowDigests.once);
    expect(actions[0]?.eventType).toBe("issue.opened");
  });

  test("[G12] daemon once and run-once produce the same transitions artifacts and effects", async () => {
    const daemonFixture = await scenario("completed");
    const runFixture = await scenario("completed");
    await writeFile(runFixture.config, daemonFixture.source);
    const run = await runOnce(
      { ...runFixture, config: daemonFixture.config, envelope: daemonFixture.envelope },
      daemonFixture.envelope,
    );
    const daemonHostPath = daemonFixture.database;
    const daemonCode = await runCli(
      ["daemon", "--once", "--config", daemonFixture.config],
      { stderr: () => undefined, stdout: () => undefined },
      {
        acquireDaemonLock: async () => async () => undefined,
        checkModules: async () => undefined,
        createAbortController: () => new AbortController(),
        installShutdown: () => () => undefined,
        now: () => new Date(observedAt),
        async openHost(repositories, _signal, sourceRepositories = {}, repositoryEvents = {}) {
          const transport = new FakeGitHubReadTransport({
            comments: [page([])],
            issues: [page([issueRecord])],
          });
          const configuration: RunOnceHostConfiguration = {
            agentExecutable: process.execPath,
            artifactRoot: join(daemonFixture.directory, "artifacts"),
            credentialMode: "none",
            localRepositories: {},
            repositories,
            repositoryEvents,
            sourceRepositories,
            storage: { engine: "sqlite", path: daemonHostPath },
            workspaceRoot: join(daemonFixture.directory, "workspaces"),
          };
          const host = await boot(configuration, transport);
          return {
            close: () => host.close(),
            drain: (limits) => host.drain(limits),
            executeAction: (name: string, args?: unknown) => host.executeAction(name, args),
            async startWorker() {
              const worker = host.startWorker();
              return async () => {
                await worker.stop();
              };
            },
          };
        },
        readText: (path) => readFile(path, "utf8"),
      },
    );
    expect(daemonCode).toBe(0);
    const inspectionConfiguration: RunOnceHostConfiguration = {
      agentExecutable: process.execPath,
      artifactRoot: join(daemonFixture.directory, "inspect-artifacts"),
      credentialMode: "none",
      localRepositories: {},
      repositories: { factory: "example/repo" },
      repositoryEvents: { factory: ["issue.opened"] },
      sourceRepositories: { "github-issues": "factory" },
      storage: { engine: "sqlite", path: daemonHostPath },
      workspaceRoot: join(daemonFixture.directory, "inspect-workspaces"),
    };
    const inspection = await boot(inspectionConfiguration, unavailableGitHubReadTransport);
    try {
      const runs = (await inspection.executeAction("operations/listRunsV2@v1", { limit: 100 }))
        .result as {
        items: Array<{ runId: string }>;
      };
      const details = (
        await inspection.executeAction("operations/showRunV2@v1", { runId: runs.items[0]?.runId })
      ).result as { timeline: Array<{ kind: string; payload: Record<string, unknown> }> };
      const transitions: RunOnceResult["transitions"] = details.timeline
        .filter((entry) => entry.kind === "run.state")
        .map((entry) => ({
          auditSequence: entry.payload.auditSequence,
          outcome: entry.payload.outcome,
          runId: entry.payload.runId,
          stateId: entry.payload.stateId,
          status: entry.payload.status,
        }));
      expect(transitions).toEqual(run.result.transitions);
      expect(run.result.artifacts).toEqual([]);
      expect(run.result.effectIntents).toEqual([]);
    } finally {
      await inspection.close();
    }
  });

  test("[G13] run-once has no daemon cursor TTY or process-global dependency", async () => {
    const fixture = await scenario("completed");
    const result = await runOnce(fixture, fixture.envelope, {
      acquireDaemonLock: async () => {
        throw new Error("daemon lock must not be used");
      },
    });
    expect(result.code).toBe(0);
    expect(result.opened).toBe(1);
    expect(result.closed).toBe(1);
    const source = await readFile("src/run-once.ts", "utf8");
    expect(source).not.toMatch(/daemon|cursorPath|isTTY|process\.stdin|globalThis/);
  });

  test("[G14] waiting runs persist in the configured store for later resume", async () => {
    const fixture = await scenario("waiting");
    const resumed = await resumeWaiting(fixture);
    expect(resumed.first.result.runIds[0]).toBeDefined();
    expect(resumed.second.result.runIds).toEqual(resumed.first.result.runIds);
    expect(resumed.second.result.outcome).toBe("completed");
  });

  test("[G15] result validator enforces bounded redacted output and pending references", async () => {
    const result = (await runOnce(await scenario("waiting"))).result;
    expect(result.runIds).toHaveLength(1);
    expect(result.pending.gates).toHaveLength(1);
    expect(result.artifacts).toEqual([]);
    expect(result.effectReceipts).toEqual([]);
    expect(result.truncation.bytes).toBeLessThanOrEqual(RUN_ONCE_MAX_OUTPUT_BYTES);
    expect(() => parseRunOnceResult({ ...result, credentials: "leak" })).toThrow(/unknown key/);
    expect(() =>
      parseRunOnceInvocationEnvelope({
        ...invocation(result.invocation.definitionRevision, "issues", "opened", "github-actions"),
        command: ["sh"],
      }),
    ).toThrow(/unknown key/);
  });

  test("[G16] permission documentation separates read write git push and OIDC", async () => {
    const docs = await readFile("docs/github-actions-adapter.md", "utf8");
    for (const permission of [
      "contents: read",
      "issues: read",
      "issues: write",
      "pull-requests: write",
      "contents: write",
      "id-token: write",
      "short-lived GitHub App installation token",
      "Secrets are not written",
    ])
      expect(docs).toContain(permission);
  });

  test("[G17] repository contains no Actions workflow or bundled action implementation", async () => {
    expect(await actionFiles()).toEqual([]);
    expect(factoryConcurrencyKey("example/repo", "issue:101", "once")).toBe(
      "example%2Frepo/issue%3A101/once",
    );
  });
});
