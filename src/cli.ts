#!/usr/bin/env node
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { syncChimpbaseModuleArtifacts } from "chimpbase/tooling/modules";

import moduleApp, { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import { GitHubEventNormalizer } from "./adapters/github-event-normalizer.ts";
import {
  FetchGitHubReadTransport,
  GitHubAppInstallationTokenProvider,
  type GitHubTokenProvider,
  PersonalAccessTokenProvider,
} from "./adapters/github-read-transport.ts";
import {
  canonicalJson,
  compileFactoryDefinition,
  DefinitionCompileError,
  type FactoryDefinition,
} from "./compiler.ts";
import { type FactoryEvent, factoryEvent } from "./contracts/index.ts";

export interface CliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

interface CliHost {
  close(): Promise<void>;
  executeAction(name: string, args?: unknown): Promise<{ readonly result: unknown }>;
}

export interface CliDependencies {
  readonly checkModules: () => Promise<void>;
  readonly createAbortController?: () => AbortController;
  readonly installShutdown?: (abort: () => void) => () => void;
  readonly openHost?: (
    repositories: Readonly<Record<string, string>>,
    signal: AbortSignal,
    sourceRepositories?: Readonly<Record<string, string>>,
  ) => Promise<CliHost>;
  readonly readStdin?: () => Promise<string>;
  readonly readText: (path: string) => Promise<string>;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
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
  installShutdown(abort) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    return () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    };
  },
  async openHost(repositories, signal, sourceRepositories = {}) {
    const clock = () => new Date();
    const tokenProvider = tokenProviderFromEnvironment();
    const readTransport = new FetchGitHubReadTransport({ clock, repositories, tokenProvider });
    const path = process.env.FACTORY_DB_PATH ?? ".factory/factory.sqlite";
    await mkdir(dirname(resolve(path)), { recursive: true });
    // Runtime adapters import incompatible platform built-ins, so load only the active one.
    const runtime =
      "Bun" in globalThis
        ? await import("chimpbase/runtime/bun")
        : await import("chimpbase/runtime/node");
    return await runtime.createChimpbase({
      app: createSoftwareFactoryApp({ clock, readTransport, signal, sourceRepositories }),
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path },
      subscriptions: { dispatch: "async" },
    });
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
    if (command === "modules" && rest.length === 1 && rest[0] === "check") {
      await dependencies.checkModules();
      io.stdout("Chimpbase modules: 0 fail\n");
      return 0;
    }
    io.stderr(
      "Usage: factory validate --config <path> | factory plan --config <path> [--json] | factory poll --once [--config <path>] [--repository <id>] | factory daemon [--once] [--config <path>] [--repository <id>] | factory trigger --event <file|stdin> [--config <path>] [--repository <id>] | factory modules check\n",
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
  const composition = repositoryComposition(repositories);
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
  );
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
  const composition = repositoryComposition(repositories);
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const removeShutdown = (dependencies.installShutdown ?? defaultDependencies.installShutdown)(() =>
    controller.abort(),
  );
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
  );
  const intervalMs = positiveInteger(
    process.env.FACTORY_POLL_INTERVAL_MS ?? "30000",
    "FACTORY_POLL_INTERVAL_MS",
  );
  try {
    do {
      const accepted = await pollOnce(host, repositories, new Date().toISOString());
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
    await host.close();
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
    },
    strict: true,
  });
  if (values.event === undefined) throw new Error("trigger requires --event <file|stdin>");
  const definition = await loadDefinition(values.config, dependencies);
  const repositories = githubRepositories(definition, values.repository);
  const composition = repositoryComposition(repositories);
  const source =
    values.event === "stdin"
      ? await (dependencies.readStdin ?? defaultDependencies.readStdin)()
      : await dependencies.readText(values.event);
  const raw: unknown = JSON.parse(source);
  const observedAt = new Date().toISOString();
  const events = manualEvents(raw, values.repository ?? repositories[0]?.id, observedAt);
  if (events.length === 0) throw new Error("event did not normalize to an accepted FactoryEvent");
  const controller = (
    dependencies.createAbortController ?? defaultDependencies.createAbortController
  )();
  const host = await (dependencies.openHost ?? defaultDependencies.openHost)(
    composition.repositories,
    controller.signal,
    composition.sourceRepositories,
  );
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
    io.stdout(`triggered ${accepted} events\n`);
    return 0;
  } finally {
    controller.abort();
    await host.close();
  }
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
  return compileFactoryDefinition(source, { sourceName: config }).definition;
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
    .map((repository) => ({
      fullName: `${repository.owner}/${repository.name}`,
      id: repository.id,
      sourceIds: definition.sources
        .filter((source) => source.type === "github" && source.repository === repository.id)
        .map((source) => source.id),
    }));
  if (repositories.length === 0) throw new Error("no configured GitHub repository matched");
  return repositories;
}

function repositoryComposition(
  repositories: readonly {
    readonly fullName: string;
    readonly id: string;
    readonly sourceIds: readonly string[];
  }[],
) {
  return {
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
