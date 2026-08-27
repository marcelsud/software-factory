import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { compileFactoryDefinition } from "../src/compiler.ts";

const [definitionSource, local, runOnce, actions] = await Promise.all([
  readFile("factory.yaml", "utf8"),
  readFile("docs/local-operation.md", "utf8"),
  readFile("docs/run-once.md", "utf8"),
  readFile("docs/github-actions-adapter.md", "utf8"),
]);
const all = `${local}\n${runOnce}\n${actions}`;

function covers(document: string, terms: readonly string[]): void {
  for (const term of terms) expect(document, `documentation must cover ${term}`).toContain(term);
}

test("[G12] Documentation covers the definition schema, state machine, operating procedure, recovery procedure, and future Actions adapter contract.", () => {
  covers(local, [
    "version",
    "dryRun",
    "repositories",
    "sources",
    "capabilities",
    "effectPermissions",
    "skills",
    "revision",
    "agentProfiles",
    "limits",
    "flows",
    "triggers",
    "concurrency",
    "artifactHandoffs",
    "steps",
    "gates",
    "states",
    "transitions",
    "Unknown keys",
    "Every reference must resolve",
    "subset",
    "matching checked permission",
  ]);

  const plan = compileFactoryDefinition(definitionSource).plansV3["issue-triage"];
  expect(plan).toBeDefined();
  for (const state of plan?.states ?? []) covers(local, [`\`${state.id}\``]);
  for (const gate of plan?.gates ?? []) covers(local, [gate.id]);
  for (const outcome of new Set(
    (plan?.states ?? []).flatMap((state) =>
      state.terminalOutcome === undefined ? [] : [state.terminalOutcome],
    ),
  ))
    covers(local, [outcome]);

  covers(local, [
    "factory daemon --config factory.yaml",
    "factory daemon --once --config factory.yaml",
    "SIGINT",
    "SIGTERM",
    "factory status --json",
    "factory doctor --json",
    "factory runs",
    "factory show",
    "factory pause",
    "factory resume",
    "factory retry",
    "factory approve",
    "factory reject",
    "factory cancel",
    "audit record",
    "Operators never edit SQLite directly",
  ]);
  covers(local, [
    "Runnable or active attempt",
    "Waiting gate",
    "Retry-delayed",
    "Effect pending or ambiguous",
    "Stale workflow/worker lease",
    "Stale daemon lock",
    "lease to expire",
    "idempotency key",
    "compare-and-swap",
  ]);
  covers(local, [
    "operations/exportReplayBundle@v1",
    "operations/importReplayBundle@v1",
    "factory replay replay-bundle.json",
    "deterministic fake GitHub read/write",
    "liveWrites",
    "credentials",
    "prompts",
    "hidden reasoning",
    "private artifact bytes",
  ]);

  covers(runOnce, [
    "same `createSoftwareFactoryApp` composition",
    "strict data-only JSON envelope",
    "same SQLite database or shared PostgreSQL store resumes",
    "Result class",
    "Exit code",
    "`completed`",
    "`waiting`",
    "`no-match`",
    "`retryable-infrastructure-failure`",
    "`policy-rejection`",
    "`terminal-failure`",
    "same delivery identity",
  ]);
  covers(actions, [
    "Check out the exact repository revision",
    "chimpbase modules check",
    "contents: read",
    "issues: read",
    "issues: write",
    "pull-requests: write",
    "contents: write",
    "id-token: write",
    "short-lived GitHub App installation token",
    "shared PostgreSQL",
    "shared durable artifact storage",
    "repository/subject/flow",
    "public artifact export",
    "must not change module contracts",
    "does not ship a GitHub Actions workflow",
  ]);

  covers(all, [
    "[local factory operation and recovery](local-operation.md)",
    "[run-once operation](run-once.md)",
    "[the future Actions adapter contract](github-actions-adapter.md)",
  ]);
});
