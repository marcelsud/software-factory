#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { syncChimpbaseModuleArtifacts } from "chimpbase/tooling/modules";
import { parseDocument } from "yaml";

import moduleApp, {
  createSoftwareFactoryApp,
  FACTORY_RUNS_V2_WORKFLOW_DIGEST,
} from "../chimpbase.app.ts";
import {
  LocalArtifactByteDriver,
  MemoryArtifactByteDriver,
} from "./adapters/artifact-byte-driver.ts";
import { GitHubEventNormalizer } from "./adapters/github-event-normalizer.ts";
import {
  FetchGitHubReadTransport,
  GitHubAppInstallationTokenProvider,
  type GitHubTokenProvider,
  PersonalAccessTokenProvider,
} from "./adapters/github-read-transport.ts";
import { LocalProcessAgentRuntime } from "./adapters/local-process-agent-runtime.ts";
import type { AgentRuntime } from "./adapters/seams.ts";
import {
  type ResolvedSkill,
  type SkillInspection,
  SkillResolver,
} from "./assets/skill-resolver.ts";
import {
  canonicalJson,
  compileFactoryDefinition,
  DefinitionCompileError,
  type FactoryDefinition,
} from "./compiler.ts";
import {
  agentResult,
  effectResultV3,
  type FactoryEvent,
  factoryEvent,
  type OperationsHealth,
  type ReplayEvent,
  replayEvent,
} from "./contracts/index.ts";
import {
  DeterministicReplayClock,
  DeterministicReplayIds,
  parseReplayBundle,
  type TrustedReplayPins,
  verifyReplayBundle,
  verifyReplayObservation,
} from "./replay.ts";
import {
  FakeAgentRuntime,
  FakeGitHubReadTransport,
  FakeGitHubWriteTransport,
  FakeGitPublisher,
} from "./testing/fakes.ts";

export interface CliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

interface CliHost {
  close(): Promise<void>;
  executeAction(name: string, args?: unknown): Promise<{ readonly result: unknown }>;
  startWorker?(): Promise<() => Promise<void>>;
}

export interface CliDependencies {
  readonly checkModules: () => Promise<void>;
  readonly createAbortController?: () => AbortController;
  readonly installShutdown?: (abort: () => void) => () => void;
  readonly openHost?: (
    repositories: Readonly<Record<string, string>>,
    signal: AbortSignal,
    sourceRepositories?: Readonly<Record<string, string>>,
    repositoryEvents?: Readonly<Record<string, readonly string[]>>,
    localRepositories?: Readonly<Record<string, string>>,
  ) => Promise<CliHost>;
  readonly readStdin?: () => Promise<string>;
  readonly readText: (path: string) => Promise<string>;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly acquireDaemonLock?: () => Promise<() => Promise<void>>;
  readonly inspectDaemonLock?: () => Promise<"active" | "clear" | "stale">;
  readonly credentialsPresent?: () => boolean | Promise<boolean>;
  readonly repositoryReachability?: (
    repositories: Readonly<Record<string, string>>,
  ) => Promise<Record<string, "reachable" | "unreachable">>;
}

const defaultIo: CliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

const defaultDependencies: Required<CliDependencies> = {
  async checkModules() {
    await syncChimpbaseModuleArtifacts(moduleApp, process.cwd(), {
      artifactsDir: "module-contracts",
      check: true,
      compositionRoot: "chimpbase.app.ts",
      modulesDir: "src/modules",
    });
  },
  createAbortController: () => new AbortController(),
  now: () => new Date(),
  acquireDaemonLock,
  inspectDaemonLock: defaultInspectDaemonLock,
  credentialsPresent: environmentCredentialsPresent,
  async repositoryReachability(repositories) {
    const transport = new FetchGitHubReadTransport({
      clock: () => new Date(),
      repositories,
      tokenProvider: tokenProviderFromEnvironment(),
    });
    return Object.fromEntries(
      await Promise.all(
        Object.keys(repositories)
          .sort()
          .map(async (repositoryId) => {
            try {
              const diagnostic = await transport.diagnoseReadPermission({ repositoryId });
              return [
                repositoryId,
                diagnostic.canReadIssues ? "reachable" : "unreachable",
              ] as const;
            } catch {
              return [repositoryId, "unreachable"] as const;
            }
          }),
      ),
    );
  },
  installShutdown(abort) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    return () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    };
  },
  async openHost(
    repositories,
    signal,
    sourceRepositories = {},
    repositoryEvents = {},
    localRepositories = {},
  ) {
    const clock = () => new Date();
    const tokenProvider = tokenProviderFromEnvironment();
    const readTransport = new FetchGitHubReadTransport({ clock, repositories, tokenProvider });
    const path = process.env.FACTORY_DB_PATH ?? ".factory/factory.sqlite";
    await mkdir(dirname(resolve(path)), { recursive: true });
    const runtime =
      "Bun" in globalThis
        ? await import("chimpbase/runtime/bun")
        : await import("chimpbase/runtime/node");
    const manifest = await readFile(new URL("../module-contracts/manifest.json", import.meta.url));
    const agentExecutable = await realpath(process.env.FACTORY_AGENT_BIN ?? process.execPath);
    const workspaceRoot = resolve(process.env.FACTORY_WORKSPACE_ROOT ?? ".factory/workspaces");
    const runtimes = new Map<string, LocalProcessAgentRuntime>();
    const repositoryPins: Record<string, string> = {};
    for (const [fullName, configuredPath] of Object.entries(localRepositories)) {
      const repositoryRoot = await realpath(configuredPath);
      repositoryPins[fullName] = (
        await promisify(execFile)("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])
      ).stdout.trim();
      runtimes.set(
        fullName,
        new LocalProcessAgentRuntime({
          repositoryRoot,
          trustedRuntimePaths: ["/usr", "/bin", "/lib", "/lib64", dirname(agentExecutable)],
          workspaceRoot: resolve(
            workspaceRoot,
            createHash("sha256").update(fullName).digest("hex"),
          ),
        }),
      );
    }
    const attemptOwners = new Map<string, LocalProcessAgentRuntime>();
    const agentRuntime: AgentRuntime = {
      async run(request, attemptSignal) {
        const selected = runtimes.get(request.repository.id);
        if (selected === undefined)
          throw new Error(
            `agent_runtime_unavailable: no configured local runtime for ${request.repository.id}`,
          );
        attemptOwners.set(request.attemptId, selected);
        return await selected.run(request, attemptSignal);
      },
      async cancel(attemptId) {
        await attemptOwners.get(attemptId)?.cancel(attemptId);
      },
    };
    let workflowRegistered = false;
    const workflowVersionDigest = FACTORY_RUNS_V2_WORKFLOW_DIGEST;
    const factoryApp = createSoftwareFactoryApp({
      artifactByteDriver: new LocalArtifactByteDriver(
        resolve(process.env.FACTORY_ARTIFACT_ROOT ?? ".factory/artifacts"),
      ),
      agentRuntime,
      clock,
      credentialsPresent: environmentCredentialsPresent,
      moduleManifestDigest: createHash("sha256").update(manifest).digest("hex"),
      readTransport,
      repositoryEvents,
      repositoryPins,
      repositoryReachability: () => defaultDependencies.repositoryReachability(repositories),
      signal,
      sourceRepositories,
      staleLocks: async () => ((await defaultInspectDaemonLock()) === "stale" ? 1 : 0),
      workflowReady: () => workflowRegistered,
      workflowVersionDigest,
    });
    workflowRegistered = factoryApp.modules
      .flatMap((module) => module.registrations)
      .some(
        (registration) =>
          registration.kind === "workflow" &&
          registration.definition.name === "factory-runs-v2" &&
          registration.definition.version === 2,
      );
    const host = await runtime.createChimpbase({
      app: factoryApp,
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path },
      subscriptions: { dispatch: "async" },
    });
    return {
      close: () => host.close(),
      executeAction: (name: string, args?: unknown) => host.executeAction(name, args),
      async startWorker() {
        const started = await host.start({ runWorker: true, serve: false });
        return () => started.stop();
      },
    };
  },
  async readStdin() {
    let source = "";
    for await (const chunk of process.stdin) source += chunk;
    return source;
  },
  readText: (path) => readFile(path, "utf8"),
  sleep: abortableSleep,
};

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === "validate") return await validateCommand(rest, io, dependencies);
    if (command === "plan") return await planCommand(rest, io, dependencies);
    if (command === "poll") return await pollCommand(rest, io, dependencies);
    if (command === "daemon") return await daemonCommand(rest, io, dependencies);
    if (command === "trigger") return await triggerCommand(rest, io, dependencies);
    if (command === "skills") return await skillsCommand(rest, io, dependencies);
    if (command === "replay") return await replayCommand(rest, io, dependencies);
    if (
      command === "status" ||
      command === "runs" ||
      command === "show" ||
      command === "events" ||
      command === "effects"
    )
      return await operationsReadCommand(command, rest, io, dependencies);
    if (
      command === "pause" ||
      command === "resume" ||
      command === "retry" ||
      command === "cancel" ||
      command === "approve" ||
      command === "reject"
    )
      return await operationsMutationCommand(command, rest, io, dependencies);
    if (command === "doctor") return await doctorCommand(rest, io, dependencies);
    if (command === "modules" && rest.length === 1 && rest[0] === "check") {
      await dependencies.checkModules();
      io.stdout("Chimpbase modules: 0 fail\n");
      return 0;
    }
    io.stderr(
      "Usage: factory validate|plan|skills|poll|daemon|trigger|status|runs|show|events|effects|pause|resume|retry|cancel|approve|reject|doctor|replay|modules check\n",
    );
    return 2;
  } catch (error) {
    if (error instanceof DefinitionCompileError) {
      for (const diagnostic of error.diagnostics) {
        io.stderr(
          `${diagnostic.path}: ${diagnostic.message}. Remediation: ${diagnostic.remediation}\n`,
        );
      }
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function replayCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (positionals.length !== 1) throw new Error("replay requires exactly one bundle path");
  const bundle = parseReplayBundle(await dependencies.readText(positionals[0] as string));
  const definition = compileFactoryDefinition(await dependencies.readText(values.config), {
    sourceName: values.config,
  });
  const plan = Object.values(definition.plansV3).find(
    (candidate) => candidate.flowDigest === bundle.pins.flowDigest,
  );
  if (plan === undefined) throw new Error("digest_mismatch: flow");
  const manifest = await readFile(new URL("../module-contracts/manifest.json", import.meta.url));
  const allowedCapabilities = [
    ...new Set([
      ...Object.values(plan.agentProfiles).flatMap((profile) => profile.capabilities),
      ...plan.effectPermissions.map((permission) => permission.capability),
    ]),
  ].sort();
  const trusted: TrustedReplayPins = {
    agentProfileDigests: plan.agentProfileDigests,
    allowedCapabilities,
    definitionDigest: definition.revision.definitionDigest,
    flowDigest: plan.flowDigest,
    moduleManifestDigest: createHash("sha256").update(manifest).digest("hex"),
    skillDigests: plan.skillRevisions,
    workflowVersionDigest: FACTORY_RUNS_V2_WORKFLOW_DIGEST,
  };
  verifyReplayBundle(bundle, trusted);

  const ids = new DeterministicReplayIds(bundle.fixtures.ids);
  const clock = new DeterministicReplayClock(bundle.fixtures.clock);
  const pendingAgentResults = bundle.fixtures.agentResults.map((value) => agentResult.parse(value));
  const agentRuntime =
    pendingAgentResults.length === 0
      ? new FakeAgentRuntime()
      : new FakeAgentRuntime((request) => {
          const next = pendingAgentResults.shift();
          if (next === undefined) throw new Error("replay_fixture_exhausted: agentResults");
          return agentResult.parse({
            ...next,
            attemptId: request.attemptId,
            timing: { ...next.timing, startedAt: request.startedAt },
          });
        });
  const effectResults = bundle.fixtures.effectResults.map((value) => effectResultV3.parse(value));
  const readTransport = new FakeGitHubReadTransport();
  const writeTransport = new FakeGitHubWriteTransport({ applies: effectResults });
  const gitPublisher = new FakeGitPublisher();
  const app = createSoftwareFactoryApp({
    agentRuntime,
    artifactByteDriver: new MemoryArtifactByteDriver(),
    clock: clock.now,
    credentialsPresent: () => false,
    gitPublisher,
    githubWriteTransport: writeTransport,
    moduleManifestDigest: trusted.moduleManifestDigest,
    now: clock.now,
    random: () => 0,
    readTransport,
    repositoryReachability: () => ({}),
    workflowVersionDigest: trusted.workflowVersionDigest,
  });
  const runtime =
    "Bun" in globalThis
      ? await import("chimpbase/runtime/bun")
      : await import("chimpbase/runtime/node");
  const host = await runtime.createChimpbase({
    app,
    projectDir: process.cwd(),
    storage: { engine: "memory" },
    subscriptions: { dispatch: "sync" },
  });
  try {
    await activateCheckedDefinition(host, values.config, dependencies);
    const projectedSources = bundle.events
      .filter((event) => event.kind === "source.accepted")
      .map((event) =>
        factoryEvent.parse({ ...(event.payload as Record<string, unknown>), payload: {} }),
      );
    const fixtureSources = bundle.fixtures.githubReads.map((value) => factoryEvent.parse(value));
    const sources = new Map<string, FactoryEvent>();
    for (const event of [...projectedSources, ...fixtureSources])
      sources.set(`${event.sourceId}\0${event.deliveryId}`, event);
    for (const event of sources.values()) {
      const cursor = (
        await host.executeAction("intake/getSourceCursor@v1", { sourceId: event.sourceId })
      ).result as { readonly cursor: string } | null;
      await host.executeAction("intake/acceptSourceEventV2@v1", {
        event,
        expectedCursor: cursor?.cursor ?? null,
        nextCursor: cursor?.cursor ?? event.sourceRevision,
      });
    }
    await host.drain({ maxDurationMs: 30_000 });
    const details = (await host.executeAction("operations/showRunV2@v1", { runId: bundle.runId }))
      .result as { readonly timeline: readonly ReplayEvent[] } | null;
    const observedEvents = (details?.timeline ?? []).map((event) => replayEvent.parse(event));
    const fakeWrites =
      writeTransport.calls.length +
      gitPublisher.mutations.length +
      gitPublisher.publications.length;
    const adapters: Readonly<Record<string, "fake" | "live">> = {
      agent: "fake",
      git: "fake",
      githubRead: "fake",
      githubWrite: "fake",
    };
    const liveWrites = Object.values(adapters).some((adapter) => adapter !== "fake")
      ? fakeWrites
      : 0;
    const result = verifyReplayObservation(bundle, trusted, observedEvents, {
      fake: fakeWrites,
      live: liveWrites,
    });
    const output = {
      replayId: ids.next(),
      ...result,
      infrastructure: "fake",
      storage: "memory",
    };
    io.stdout(
      values.json
        ? `${canonicalJson(output)}\n`
        : `replayed ${result.bundleDigest}\ntransitions: ${result.transitions.length}\neffects: ${result.effectIntents.length}\nfake writes: ${result.fakeWrites}\nlive writes: ${result.liveWrites}\n`,
    );
    return 0;
  } finally {
    await host.close();
  }
}

interface ConfiguredSkillResolution {
  readonly configuredId: string;
  readonly configuredPath: string;
  readonly configuredRevision: string;
  readonly inspection: SkillInspection;
  readonly resolved: ResolvedSkill;
}

async function configuredSkills(
  config: string,
  source: string,
): Promise<ConfiguredSkillResolution[]> {
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) throw new Error(`invalid or unsafe YAML: ${problems[0]?.message}`);
  const value = document.toJS({ maxAliasCount: 0 }) as { readonly skills?: readonly unknown[] };
  if (!Array.isArray(value.skills)) throw new Error("invalid config: skills must be a list");
  const configDirectory = dirname(resolve(config));
  const resolver = new SkillResolver({ roots: [resolve(configDirectory, "skills")] });
  const seen = new Set<string>();
  const skills: ConfiguredSkillResolution[] = [];
  for (const [index, entry] of value.skills.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`invalid config: skills[${index}] must be a mapping`);
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.path !== "string" ||
      typeof record.revision !== "string"
    )
      throw new Error(`invalid config: skills[${index}] requires id, path, and revision`);
    if (seen.has(record.id)) throw new Error(`duplicate skill id: ${record.id}`);
    seen.add(record.id);
    const resolved = await resolver.resolve(resolve(configDirectory, record.path));
    if (resolved.bundle.id !== record.id)
      throw new Error(`skill id mismatch: configured ${record.id}, manifest ${resolved.bundle.id}`);
    skills.push({
      configuredId: record.id,
      configuredPath: record.path,
      configuredRevision: record.revision,
      inspection: resolved.inspection,
      resolved,
    });
  }
  return skills;
}

async function skillsCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "list" && subcommand !== "inspect" && subcommand !== "verify")
    throw new Error("skills requires list, inspect, or verify");
  const { values } = parseArgs({
    allowPositionals: false,
    args: rest,
    options: {
      config: { type: "string" },
      id: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.config === undefined) throw new Error(`skills ${subcommand} requires --config <path>`);
  const source = await dependencies.readText(values.config);
  const configured = await configuredSkills(values.config, source);
  const selected = configured.filter(
    (skill) => values.id === undefined || skill.configuredId === values.id,
  );
  if (values.id !== undefined && selected.length === 0)
    throw new Error(`skill not found: ${values.id}`);
  if (subcommand === "verify") {
    for (const skill of selected) {
      if (skill.configuredRevision === "unpinned")
        throw new Error(`skill revision is unpinned: ${skill.configuredId}`);
      if (skill.configuredRevision !== skill.inspection.digest)
        throw new Error(
          `skill digest mismatch: ${skill.configuredId} claims ${skill.configuredRevision}, resolved ${skill.inspection.digest}`,
        );
    }
  }
  const output =
    subcommand === "list"
      ? selected.map((skill) => ({
          digest: skill.inspection.digest,
          id: skill.configuredId,
          sourcePath: skill.inspection.sourcePath,
          version: skill.inspection.version,
        }))
      : selected.map((skill) => skill.inspection);
  if (values.json) {
    io.stdout(`${canonicalJson(output)}\n`);
    return 0;
  }
  for (const skill of selected) {
    if (subcommand === "list") {
      io.stdout(
        `${skill.configuredId} ${skill.inspection.digest} v${skill.inspection.version} compatibility=${skill.inspection.compatibility} ${skill.inspection.sourcePath}\n`,
      );
      continue;
    }
    if (subcommand === "verify") {
      io.stdout(`verified ${skill.configuredId} ${skill.inspection.digest}\n`);
      continue;
    }
    io.stdout(`${skill.configuredId} ${skill.inspection.digest}\n`);
    io.stdout(`  source: ${skill.inspection.sourcePath}\n`);
    io.stdout(`  version: ${skill.inspection.version}\n`);
    io.stdout(`  compatibility: ${skill.inspection.compatibility}\n`);
    io.stdout(`  capabilities: ${skill.inspection.capabilities.join(", ")}\n`);
    io.stdout(`  input artifact kinds: ${skill.inspection.inputArtifactKinds.join(", ")}\n`);
    io.stdout(`  result schema: ${canonicalJson(skill.inspection.resultSchema)}\n`);
    io.stdout(`  files: ${canonicalJson(skill.inspection.files)}\n`);
  }
  return 0;
}

async function validateCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: { config: { type: "string" } },
    strict: true,
  });
  if (values.config === undefined) throw new Error("validate requires --config <path>");
  const source = await dependencies.readText(values.config);
  const compiled = compileFactoryDefinition(source, { sourceName: values.config });
  io.stdout(`valid ${compiled.revision.definitionDigest}\n`);
  return 0;
}

async function planCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: { config: { type: "string" }, json: { type: "boolean", default: false } },
    strict: true,
  });
  if (values.config === undefined) throw new Error("plan requires --config <path>");
  const source = await dependencies.readText(values.config);
  const compiled = compileFactoryDefinition(source, { sourceName: values.config });
  if (values.json) {
    io.stdout(
      `${canonicalJson({ definition: compiled.definition, plans: compiled.plans, revision: compiled.revision })}\n`,
    );
    return 0;
  }
  io.stdout(`definition ${compiled.revision.definitionDigest}\n`);
  for (const flow of compiled.definition.flows) {
    const plan = compiled.plans[flow.id];
    if (plan === undefined) continue;
    io.stdout(`flow ${flow.id} ${plan.flowDigest}\n`);
    io.stdout(`  agent profiles: ${canonicalJson(plan.agentProfileDigests)}\n`);
    io.stdout(`  skills: ${canonicalJson(plan.skillRevisions)}\n`);
    io.stdout(`  states: ${plan.states.map((state) => state.id).join(", ")}\n`);
    io.stdout(`  calls: ${plan.calls.join(", ")}\n`);
    io.stdout(`  events: ${plan.events.join(", ")}\n`);
    io.stdout(
      `  graph: ${canonicalJson({
        concurrency: plan.concurrency,
        effectPermissions: plan.effectPermissions,
        gates: plan.gates,
        initialState: plan.initialState,
        states: plan.states,
        steps: plan.steps,
        transitions: plan.transitions,
      })}\n`,
    );
  }
  io.stdout(`${compiled.revision.normalizedJson}\n`);
  return 0;
}

async function pollCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const values = parseIntakeOptions(argv);
  if (!values.once) throw new Error("poll requires --once");
  const definition = await loadDefinition(values.config, dependencies);
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const repositories = githubRepositories(definition, values.repository);
  const composition = repositoryComposition(repositories, values.config);
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
    composition.repositoryEvents,
    composition.localRepositories,
  );
  await activateCheckedDefinition(host, values.config, dependencies);
  try {
    const accepted = await pollOnce(host, repositories, new Date().toISOString());
    io.stdout(`polled ${repositories.length} repositories; accepted ${accepted}\n`);
    return 0;
  } finally {
    controller.abort();
    await host.close();
  }
}

async function daemonCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const values = parseIntakeOptions(argv);
  const definition = await loadDefinition(values.config, dependencies);
  const repositories = githubRepositories(definition, values.repository);
  const composition = repositoryComposition(repositories, values.config);
  const releaseLock = await (
    dependencies.acquireDaemonLock ?? defaultDependencies.acquireDaemonLock
  )();
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const removeShutdown = (dependencies.installShutdown ?? defaultDependencies.installShutdown)(() =>
    controller.abort(),
  );
  let host: CliHost | undefined;
  let stopWorker: (() => Promise<void>) | undefined;
  try {
    host = await (dependencies.openHost ?? defaultDependencies.openHost)(
      composition.repositories,
      controller.signal,
      composition.sourceRepositories,
      composition.repositoryEvents,
      composition.localRepositories,
    );
    await activateCheckedDefinition(host, values.config, dependencies);
    stopWorker = await host.startWorker?.();
    const intervalMs = positiveInteger(
      process.env.FACTORY_POLL_INTERVAL_MS ?? "30000",
      "FACTORY_POLL_INTERVAL_MS",
    );
    do {
      const accepted = await pollOnce(
        host,
        repositories,
        (dependencies.now ?? defaultDependencies.now)().toISOString(),
      );
      await host.executeAction("operations/refreshWorkerHeartbeat@v1", {});
      io.stdout(`polled ${repositories.length} repositories; accepted ${accepted}\n`);
      if (values.once || controller.signal.aborted) break;
      await (dependencies.sleep ?? defaultDependencies.sleep)(intervalMs, controller.signal);
    } while (!controller.signal.aborted);
    return 0;
  } catch (error) {
    if (controller.signal.aborted && isAbortError(error)) return 0;
    throw error;
  } finally {
    removeShutdown();
    controller.abort();
    await stopWorker?.();
    await host?.close();
    await releaseLock();
  }
}

async function triggerCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: {
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      event: { type: "string" },
      repository: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.event === undefined) throw new Error("trigger requires --event <file|stdin>");
  const definition = await loadDefinition(values.config, dependencies);
  const repositories = githubRepositories(definition, values.repository);
  const composition = repositoryComposition(repositories, values.config);
  const source =
    values.event === "stdin"
      ? await (dependencies.readStdin ?? defaultDependencies.readStdin)()
      : await dependencies.readText(values.event);
  const raw: unknown = JSON.parse(source);
  const observedAt = (dependencies.now ?? defaultDependencies.now)().toISOString();
  const repositoryId = repositories[0]?.id;
  const allowedEvents =
    repositoryId === undefined ? undefined : composition.repositoryEvents[repositoryId];
  const events = manualEvents(raw, repositoryId, observedAt).filter(
    (event) =>
      allowedEvents === undefined ||
      allowedEvents.includes("*") ||
      allowedEvents.includes(event.eventType),
  );
  if (events.length === 0) throw new Error("event did not normalize to an enabled FactoryEvent");
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
    composition.repositoryEvents,
    composition.localRepositories,
  );
  await activateCheckedDefinition(host, values.config, dependencies);
  let accepted = 0;
  try {
    for (const event of events) {
      const cursor = (
        await host.executeAction("intake/getSourceCursor@v1", { sourceId: event.sourceId })
      ).result as { readonly cursor: string } | null;
      const result = (
        await host.executeAction("intake/acceptSourceEventV2@v1", {
          event,
          expectedCursor: cursor?.cursor ?? null,
          nextCursor: cursor?.cursor ?? event.sourceRevision,
        })
      ).result as { readonly idempotent: boolean };
      if (!result.idempotent) accepted += 1;
    }
    io.stdout(
      values.json
        ? `${canonicalJson({ accepted, normalized: events.length })}\n`
        : `triggered ${accepted} events\n`,
    );
    return 0;
  } finally {
    controller.abort();
    await host.close();
  }
}

type OperationsCommand = "status" | "runs" | "show" | "events" | "effects";

async function operationsHost(
  config: string,
  dependencies: CliDependencies,
): Promise<{ host: CliHost; controller: AbortController }> {
  const definition = await loadDefinition(config, dependencies);
  const repositories = githubRepositories(definition);
  const composition = repositoryComposition(repositories, config);
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
    composition.repositoryEvents,
    composition.localRepositories,
  );
  return { controller, host };
}

async function operationsReadCommand(
  command: OperationsCommand,
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      after: { type: "string" },
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "25" },
      run: { type: "string" },
      status: { type: "string" },
    },
    strict: true,
  });
  if (command === "runs" && values.run !== undefined)
    throw new Error("--run is not supported by runs");
  if ((command === "events" || command === "effects") && values.status !== undefined)
    throw new Error(`--status is not supported by ${command}`);
  const opened = await operationsHost(values.config, dependencies);
  try {
    let result: unknown;
    if (command === "status") {
      if (positionals.length !== 0) throw new Error("status accepts no positional arguments");
      result = (await opened.host.executeAction("operations/getHealthV2@v1", {})).result;
    } else if (command === "show") {
      if (positionals.length !== 1) throw new Error("show requires exactly one run id");
      result = (
        await opened.host.executeAction("operations/showRunV2@v1", {
          runId: positionals[0],
        })
      ).result;
      if (result === null) throw new Error(`run_not_found: ${positionals[0]}`);
    } else {
      if (positionals.length !== 0) throw new Error(`${command} accepts no positional arguments`);
      const input =
        command === "runs"
          ? {
              ...(values.after === undefined ? {} : { after: values.after }),
              limit: positiveInteger(values.limit, "limit"),
              ...(values.status === undefined ? {} : { status: values.status }),
            }
          : {
              ...(values.after === undefined ? {} : { after: values.after }),
              limit: positiveInteger(values.limit, "limit"),
              ...(values.run === undefined ? {} : { runId: values.run }),
            };
      const action =
        command === "runs"
          ? "operations/listRunsV2@v1"
          : command === "events"
            ? "operations/listEventsV2@v1"
            : "operations/listEffectsV2@v1";
      result = (await opened.host.executeAction(action, input)).result;
    }
    io.stdout(values.json ? `${canonicalJson(result)}\n` : renderOperations(command, result));
    return 0;
  } finally {
    opened.controller.abort();
    await opened.host.close();
  }
}

function renderOperations(command: OperationsCommand, value: unknown): string {
  if (command === "status") {
    const health = value as OperationsHealth;
    return `${[
      `status: ${health.status}`,
      `storage: ${health.storage}`,
      `workflow: ${health.workflow}`,
      `worker: ${health.worker}`,
      `pending effects: ${health.pendingEffects}`,
      `unreconciled effects: ${health.unreconciledEffects}`,
      `stale locks: ${health.staleLocks}`,
    ].join("\n")}\n`;
  }
  if (command === "show") {
    const details = value as {
      run: {
        runId: string;
        status: string;
        flowId: string;
        stateId: string;
        revisions: Record<string, { drift: boolean; pinned: unknown; current: unknown }>;
      };
      timeline: Array<{ kind: string; occurredAt: string }>;
    };
    const drift = Object.entries(details.run.revisions)
      .filter(([, revision]) => revision.drift)
      .map(([name]) => name)
      .sort();
    return `${[
      `run: ${details.run.runId}`,
      `status: ${details.run.status}`,
      `flow/state: ${details.run.flowId}/${details.run.stateId}`,
      `revision drift: ${drift.length === 0 ? "none" : drift.join(",")}`,
      ...details.timeline.map((entry) => `${entry.occurredAt}\t${entry.kind}`),
    ].join("\n")}\n`;
  }
  const page = value as { items: SafeCliRecord[]; nextCursor: string | null };
  if (command === "runs")
    return `${[
      "RUN\tSTATUS\tFLOW\tSTATE",
      ...page.items.map((item) => `${item.runId}\t${item.status}\t${item.flowId}\t${item.stateId}`),
      ...(page.nextCursor === null ? [] : [`next: ${page.nextCursor}`]),
    ].join("\n")}\n`;
  const id = command === "events" ? "eventId" : "idempotencyKey";
  const label = command === "events" ? "kind" : "status";
  return `${[
    `${id.toUpperCase()}\t${label.toUpperCase()}`,
    ...page.items.map((item) => `${item[id]}\t${item[label]}`),
    ...(page.nextCursor === null ? [] : [`next: ${page.nextCursor}`]),
  ].join("\n")}\n`;
}

type SafeCliRecord = Record<string, string | number | boolean | null | undefined>;
type MutationCommand = "pause" | "resume" | "retry" | "cancel" | "approve" | "reject";

async function operationsMutationCommand(
  command: MutationCommand,
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      actor: { type: "string", default: process.env.USER ?? "operator" },
      "command-key": { type: "string" },
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      correlation: { type: "string" },
      gate: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const runId = positionals[0];
  if (runId === undefined || positionals.length !== 1)
    throw new Error(`${command} requires exactly one run id`);
  const opened = await operationsHost(values.config, dependencies);
  try {
    const details = (await opened.host.executeAction("operations/showRunV2@v1", { runId }))
      .result as {
      run: {
        currentCorrelationToken: string | null;
        currentGateId: string | null;
        updatedAt: string;
      };
    } | null;
    if (details === null) throw new Error(`run_not_found: ${runId}`);
    const correlationToken = values.correlation ?? details.run.currentCorrelationToken ?? undefined;
    const gateId = values.gate ?? details.run.currentGateId ?? undefined;
    const requestedAt = (dependencies.now ?? defaultDependencies.now)().toISOString();
    const commandKey =
      values["command-key"] ??
      `cmd_${createHash("sha256")
        .update(
          canonicalJson({
            actor: values.actor,
            command,
            correlationToken,
            gateId,
            runId,
            state: details.run.updatedAt,
          }),
        )
        .digest("hex")}`;
    const request = {
      actor: values.actor,
      commandKey,
      ...(correlationToken === undefined ? {} : { correlationToken }),
      ...(gateId === undefined ? {} : { gateId }),
      kind: command,
      requestedAt,
      runId,
    };
    let audit: { error: string | null; outcome: string };
    try {
      audit = (await opened.host.executeAction("operations/applyOperatorCommand@v1", request))
        .result as { error: string | null; outcome: string };
    } catch (error) {
      audit = (
        await opened.host.executeAction("operations/recordOperatorCommandRejection@v1", {
          error: safeCliError(error),
          request,
        })
      ).result as { error: string | null; outcome: string };
    }
    io.stdout(
      values.json
        ? `${canonicalJson(audit)}\n`
        : `${command} ${runId}: ${audit.outcome}${audit.error === null ? "" : ` (${audit.error})`}\n`,
    );
    return audit.outcome === "applied" ? 0 : 1;
  } finally {
    opened.controller.abort();
    await opened.host.close();
  }
}

async function doctorCommand(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: {
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const checks: Array<{ detail: string; name: string; status: "ok" | "fail" }> = [];
  let definition: FactoryDefinition | null = null;
  try {
    definition = compileFactoryDefinition(await dependencies.readText(values.config), {
      allowUnpinnedSkills: true,
      sourceName: values.config,
    }).definition;
    checks.push({ detail: values.config, name: "config", status: "ok" });
  } catch (error) {
    checks.push({ detail: safeCliError(error), name: "config", status: "fail" });
  }
  const credentials = await (
    dependencies.credentialsPresent ?? defaultDependencies.credentialsPresent
  )();
  checks.push({
    detail: credentials ? "present" : "GitHub credentials are missing",
    name: "credentials",
    status: credentials ? "ok" : "fail",
  });
  try {
    await dependencies.checkModules();
    checks.push({ detail: "module manifest matches", name: "schema", status: "ok" });
  } catch (error) {
    checks.push({ detail: safeCliError(error), name: "schema", status: "fail" });
  }
  const lock = await (dependencies.inspectDaemonLock ?? defaultDependencies.inspectDaemonLock)();
  checks.push({
    detail: lock,
    name: "daemon-lock",
    status: lock === "stale" ? "fail" : "ok",
  });
  if (definition !== null) {
    const configured = githubRepositories(definition);
    const repositories = Object.fromEntries(configured.map((entry) => [entry.id, entry.fullName]));
    const reachability = await (
      dependencies.repositoryReachability ?? defaultDependencies.repositoryReachability
    )(repositories);
    for (const [repository, status] of Object.entries(reachability).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      checks.push({
        detail: status,
        name: `repository:${repository}`,
        status: status === "reachable" ? "ok" : "fail",
      });
    const composition = repositoryComposition(configured, values.config);
    const controller = (
      dependencies.createAbortController ?? defaultDependencies.createAbortController
    )();
    let host: CliHost | undefined;
    try {
      host = await (dependencies.openHost ?? defaultDependencies.openHost)(
        composition.repositories,
        controller.signal,
        composition.sourceRepositories,
        composition.repositoryEvents,
        composition.localRepositories,
      );
      const health = (await host.executeAction("operations/getHealthV2@v1", {}))
        .result as OperationsHealth;
      checks.push({
        detail: String(health.unreconciledEffects),
        name: "unreconciled-effects",
        status: health.unreconciledEffects === 0 ? "ok" : "fail",
      });
    } catch (error) {
      checks.push({ detail: safeCliError(error), name: "unreconciled-effects", status: "fail" });
    } finally {
      controller.abort();
      await host?.close();
    }
  } else {
    checks.push({ detail: "config invalid", name: "repositories", status: "fail" });
    checks.push({ detail: "config invalid", name: "unreconciled-effects", status: "fail" });
  }
  const result = { checks, ok: checks.every((check) => check.status === "ok") };
  io.stdout(
    values.json
      ? `${canonicalJson(result)}\n`
      : `${checks.map((check) => `${check.status === "ok" ? "OK" : "FAIL"}\t${check.name}\t${check.detail}`).join("\n")}\n`,
  );
  return result.ok ? 0 : 1;
}

function safeCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseIntakeOptions(argv: readonly string[]) {
  const { values } = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: {
      config: { type: "string", default: process.env.FACTORY_CONFIG ?? "factory.yaml" },
      once: { type: "boolean", default: false },
      repository: { type: "string" },
    },
    strict: true,
  });
  return values;
}

async function loadDefinition(
  config: string,
  dependencies: CliDependencies,
): Promise<FactoryDefinition> {
  const source = await dependencies.readText(config);
  return compileFactoryDefinition(source, {
    allowUnpinnedSkills: true,
    sourceName: config,
  }).definition;
}

async function activateCheckedDefinition(
  host: Pick<CliHost, "executeAction">,
  config: string,
  dependencies: CliDependencies,
): Promise<void> {
  let source = await dependencies.readText(config);
  const agentExecutable = await realpath(process.env.FACTORY_AGENT_BIN ?? process.execPath);
  source = source.replaceAll("/__factory_agent_bin__", agentExecutable);
  const configured = await configuredSkills(config, source);
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  for (const [index, skill] of configured.entries()) {
    if (skill.configuredRevision === "unpinned") {
      document.setIn(["skills", index, "revision"], skill.inspection.digest);
    } else if (skill.configuredRevision !== skill.inspection.digest) {
      throw new Error(
        `skill digest mismatch: ${skill.configuredId} claims ${skill.configuredRevision}, resolved ${skill.inspection.digest}`,
      );
    }
    await host.executeAction("assets/storeSkillBundleV2@v1", {
      bundle: skill.resolved.bundle,
      source: skill.configuredPath,
    });
  }
  source = document.toString();
  const revision = (
    await host.executeAction("definitions/compileDefinition@v1", {
      source,
      sourceName: config,
    })
  ).result as { readonly definitionDigest: string };
  await host.executeAction("definitions/activateDefinition@v1", {
    definitionDigest: revision.definitionDigest,
  });
}

function githubRepositories(definition: FactoryDefinition, selected?: string) {
  const githubRepositoryIds = new Set(
    definition.sources
      .filter((source) => source.type === "github" && source.repository !== undefined)
      .map((source) => source.repository as string),
  );
  const repositories = definition.repositories
    .filter((repository) => githubRepositoryIds.has(repository.id))
    .filter(
      (repository) =>
        selected === undefined ||
        repository.id === selected ||
        `${repository.owner}/${repository.name}` === selected,
    )
    .map((repository) => {
      const sources = definition.sources.filter(
        (source) => source.type === "github" && source.repository === repository.id,
      );
      if (repository.localPath === undefined)
        throw new Error(
          `repository ${repository.owner}/${repository.name} is missing required localPath`,
        );
      return {
        events: [...new Set(sources.flatMap((source) => source.events ?? ["*"]))].sort(),
        fullName: `${repository.owner}/${repository.name}`,
        id: repository.id,
        sourceIds: sources.map((source) => source.id),
        localPath: repository.localPath,
      };
    });
  if (repositories.length === 0) throw new Error("no configured GitHub repository matched");
  return repositories;
}

function repositoryComposition(
  repositories: readonly {
    readonly events: readonly string[];
    readonly fullName: string;
    readonly id: string;
    readonly localPath: string;
    readonly sourceIds: readonly string[];
  }[],
  config: string,
) {
  const localRepositories: Record<string, string> = {};
  for (const repository of repositories)
    localRepositories[repository.fullName] = resolve(dirname(config), repository.localPath);
  return {
    localRepositories,
    repositoryEvents: Object.fromEntries(repositories.map((entry) => [entry.id, entry.events])),
    repositories: Object.fromEntries(repositories.map((entry) => [entry.id, entry.fullName])),
    sourceRepositories: Object.fromEntries(
      repositories.flatMap((entry) => entry.sourceIds.map((sourceId) => [sourceId, entry.id])),
    ),
  };
}

async function pollOnce(
  host: CliHost,
  repositories: readonly { readonly id: string }[],
  observedAt: string,
): Promise<number> {
  let accepted = 0;
  for (const repository of repositories) {
    const summary = (
      await host.executeAction("intake/pollRepositoryV2@v1", {
        observedAt,
        repositoryId: repository.id,
      })
    ).result as { readonly accepted: number };
    accepted += summary.accepted;
  }
  return accepted;
}

function manualEvents(
  raw: unknown,
  repositoryId: string | undefined,
  observedAt: string,
): FactoryEvent[] {
  try {
    return [factoryEvent.parse(raw)];
  } catch {
    if (repositoryId === undefined)
      throw new Error("Actions event requires a configured repository");
    return new GitHubEventNormalizer().normalize({
      kind: "actions",
      observedAt,
      payload: raw,
      repositoryId,
    });
  }
}

function tokenProviderFromEnvironment(): GitHubTokenProvider {
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token.trim() !== "") return new PersonalAccessTokenProvider(token);
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId !== undefined && installationId !== undefined && privateKey !== undefined) {
    return new GitHubAppInstallationTokenProvider({ appId, installationId, privateKey });
  }
  return {
    async getToken() {
      throw new Error(
        "GitHub read authentication requires GITHUB_TOKEN or GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY",
      );
    },
  };
}

const daemonLockPath = () => resolve(process.env.FACTORY_DAEMON_LOCK ?? ".factory/daemon.lock");

function environmentCredentialsPresent(): boolean {
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token.trim() !== "") return true;
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_INSTALLATION_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY,
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultInspectDaemonLock(): Promise<"active" | "clear" | "stale"> {
  try {
    const value = JSON.parse(await readFile(daemonLockPath(), "utf8")) as {
      pid?: number;
      startedAt?: string;
    };
    return typeof value.startedAt === "string" && processIsAlive(value.pid ?? 0)
      ? "active"
      : "stale";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "clear" : "stale";
  }
}

export async function acquireDaemonLock(): Promise<() => Promise<void>> {
  const path = daemonLockPath();
  await mkdir(dirname(path), { recursive: true });
  const record = { pid: process.pid, startedAt: new Date().toISOString() };
  const bytes = Buffer.from(canonicalJson(record));
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observed: Buffer;
      try {
        observed = await readFile(path);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
        observed = Buffer.alloc(0);
      }
      if (observed.length > 0) {
        try {
          const value = JSON.parse(observed.toString("utf8")) as { pid?: number };
          if (processIsAlive(value.pid ?? 0))
            throw new Error("daemon_conflict: another factory daemon is active");
        } catch (parseError) {
          if (
            parseError instanceof Error &&
            parseError.message === "daemon_conflict: another factory daemon is active"
          )
            throw parseError;
        }
      }
      try {
        const current = await readFile(path);
        if (!current.equals(observed))
          throw new Error("daemon_conflict: another factory daemon is active");
        await unlink(path);
      } catch (takeoverError) {
        if ((takeoverError as NodeJS.ErrnoException).code !== "ENOENT") throw takeoverError;
      }
      try {
        await link(temporary, path);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("daemon_conflict: another factory daemon is active");
        throw linkError;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    try {
      const current = await readFile(path);
      if (current.equals(bytes)) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined) {
  try {
    if ((await realpath(invokedPath)) === (await realpath(fileURLToPath(import.meta.url)))) {
      process.exitCode = await runCli(process.argv.slice(2));
    }
  } catch {
    if (resolve(invokedPath) === fileURLToPath(import.meta.url)) {
      process.exitCode = await runCli(process.argv.slice(2));
    }
  }
}
