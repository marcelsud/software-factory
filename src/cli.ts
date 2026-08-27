#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { syncChimpbaseModuleArtifacts } from "chimpbase/tooling/modules";

import app from "../chimpbase.app.ts";
import { canonicalJson, compileFactoryDefinition, DefinitionCompileError } from "./compiler.ts";

export interface CliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

export interface CliDependencies {
  readonly checkModules: () => Promise<void>;
  readonly readText: (path: string) => Promise<string>;
}

const defaultIo: CliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

const defaultDependencies: CliDependencies = {
  async checkModules() {
    await syncChimpbaseModuleArtifacts(app, process.cwd(), {
      artifactsDir: "module-contracts",
      check: true,
      compositionRoot: "chimpbase.app.ts",
      modulesDir: "src/modules",
    });
  },
  readText: (path) => readFile(path, "utf8"),
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
    if (command === "modules" && rest.length === 1 && rest[0] === "check") {
      await dependencies.checkModules();
      io.stdout("Chimpbase modules: 0 fail\n");
      return 0;
    }
    io.stderr(
      "Usage: factory validate --config <path> | factory plan --config <path> [--json] | factory modules check\n",
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
    io.stdout(`  states: ${plan.states.join(", ")}\n`);
    io.stdout(`  calls: ${plan.calls.join(", ")}\n`);
    io.stdout(`  events: ${plan.events.join(", ")}\n`);
  }
  io.stdout(`${compiled.revision.normalizedJson}\n`);
  return 0;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
