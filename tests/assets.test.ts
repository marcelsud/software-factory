import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChimpbase } from "chimpbase/runtime/bun";
import { generateChimpbaseModuleManifest } from "chimpbase/tooling/modules";

import { createSoftwareFactoryApp } from "../chimpbase.app.ts";
import {
  LocalArtifactByteDriver,
  MemoryArtifactByteDriver,
} from "../src/adapters/artifact-byte-driver.ts";
import type { AgentRuntime } from "../src/adapters/seams.ts";
import { type ResolvedSkill, SkillResolver } from "../src/assets/skill-resolver.ts";
import { runCli } from "../src/cli.ts";
import { compileFactoryDefinition } from "../src/compiler.ts";
import {
  type AgentRequestV2,
  type AgentResult,
  MODULE_RESOURCES,
  RESOURCE_OWNERS,
  validateSkillResult,
} from "../src/contracts/index.ts";
import { unavailableGitHubReadTransport } from "../src/modules/intake/implementation.ts";

const roots: string[] = [];
const now = "2026-08-27T00:00:00.000Z";

async function temporary(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `factory-assets-${name}-`));
  roots.push(root);
  return root;
}

async function skillFixture(
  name: string,
  skill = "reproduce",
): Promise<{ root: string; skill: string }> {
  const root = await temporary(name);
  const target = join(root, skill);
  await cp(join(process.cwd(), "skills", skill), target, { recursive: true });
  return { root, skill: target };
}

async function resolveFixture(name: string, skill = "reproduce"): Promise<ResolvedSkill> {
  const fixture = await skillFixture(name, skill);
  return await new SkillResolver({ roots: [fixture.root] }).resolve(fixture.skill);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function boot(driver = new MemoryArtifactByteDriver(), agentRuntime?: AgentRuntime) {
  const host = await createChimpbase({
    app: createSoftwareFactoryApp({
      artifactByteDriver: driver,
      ...(agentRuntime === undefined ? {} : { agentRuntime }),
      readTransport: unavailableGitHubReadTransport,
    }),
    projectDir: process.cwd(),
    storage: { engine: "memory" },
    subscriptions: { dispatch: "async" },
  });
  return { driver, host };
}

async function storePrivate(
  host: Awaited<ReturnType<typeof createChimpbase>>,
  content: string,
  runId = "run-a",
  attemptId = "attempt-a",
  kind: "log" | "report.md" = "report.md",
) {
  const bytes = Buffer.from(content, "utf8");
  const artifactDigest = digest(bytes);
  await host.executeAction("assets/storeArtifactV2@v1", {
    artifact: {
      attemptId,
      classification: "private",
      createdAt: now,
      digest: artifactDigest,
      kind,
      mediaType: "text/plain; charset=utf-8",
      name: kind,
      redaction: "raw-private",
      retention: "retained",
      runId,
      size: bytes.byteLength,
    },
    contentBase64: bytes.toString("base64"),
  });
  return artifactDigest;
}

function executionRequest(attemptId: string, skill: ResolvedSkill["bundle"]): AgentRequestV2 {
  const patches = skill.capabilities.includes("repository.patch");
  const tests = skill.capabilities.includes("process.test");
  const capabilities = patches
    ? ["repository.read", "repository.patch", "process.test"]
    : tests
      ? ["repository.read", "process.test"]
      : ["repository.read"];
  const capabilityPreset = patches ? "test" : tests ? "verify" : "read-only";
  return {
    agentProfile: {
      capabilities,
      capabilityPreset,
      command: ["/bin/false"],
      digest: "profile",
      environment: {},
      instructions: "Use only declared evidence.",
      limits: {
        cpuSeconds: 1,
        maxFileBytes: 1024 * 1024,
        maxInputBytes: 1024 * 1024,
        maxLogBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxPatchBytes: 1024 * 1024,
        maxPids: 8,
        maxWorkspaceBytes: 1024 * 1024,
        maxWorkspaceFiles: 100,
        memoryBytes: 1024 * 1024,
        timeoutMs: 1_000,
      },
      model: "trusted-composition-default",
      skills: [skill.id],
    },
    attemptId,
    budget: { maxDurationMs: 1_000, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024 },
    correlationToken: `correlation-${attemptId}`,
    declaredOutputPaths: [],
    inputArtifacts: [],
    repository: { id: "fixture", sha: "pinned-revision" },
    runId: `run-${attemptId}`,
    skills: [skill],
    startedAt: now,
    stepId: skill.id,
    task: { mediaType: "application/json", payload: {} },
  };
}

function fakeAgentRuntime(
  reports: Readonly<Record<string, Record<string, unknown>>>,
): AgentRuntime {
  return {
    async cancel() {},
    async run(request): Promise<AgentResult> {
      const skill = request.skills[0];
      if (skill === undefined) throw new Error("missing skill");
      const data = reports[skill.id] ?? {};
      return {
        attemptId: request.attemptId,
        changedFiles: [],
        logs: {
          stderrBytes: 0,
          stderrDigest: "empty",
          stderrTruncated: false,
          stdoutBytes: 0,
          stdoutDigest: "empty",
        },
        outcome: {
          data,
          outcome: "completed",
          outputArtifactDigests: [],
          summary: `${skill.id} report`,
        },
        resources: { cpuMs: 0, maxRssBytes: 0 },
        status: "succeeded",
        tests: [],
        timing: { durationMs: 0, finishedAt: now, startedAt: now },
      };
    },
  };
}

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { force: true, recursive: true })));
});

describe("assets", () => {
  test("[G1] referenced skill bytes determine the digest", async () => {
    const fixture = await skillFixture("g1");
    const resolver = new SkillResolver({ roots: [fixture.root] });
    const first = await resolver.resolve(fixture.skill);
    await writeFile(join(fixture.skill, "unrelated.txt"), "ignored");
    expect((await resolver.resolve(fixture.skill)).bundle.digest).toBe(first.bundle.digest);
    await writeFile(join(fixture.skill, "guidance.md"), "changed declared include\n");
    expect((await resolver.resolve(fixture.skill)).bundle.digest).not.toBe(first.bundle.digest);
  });

  test("[G2] stored runs retain an immutable pinned revision", async () => {
    const { host } = await boot();
    try {
      const first = await resolveFixture("g2");
      await host.executeAction("assets/storeSkillBundleV2@v1", {
        bundle: first.bundle,
        source: "skills/reproduce",
      });
      const fixture = await skillFixture("g2-edit");
      await writeFile(join(fixture.skill, "guidance.md"), "new revision\n");
      const second = await new SkillResolver({ roots: [fixture.root] }).resolve(fixture.skill);
      expect(second.bundle.digest).not.toBe(first.bundle.digest);
      const pinned = (
        await host.executeAction("assets/resolveSkillV2@v1", {
          digest: first.bundle.digest,
          id: first.bundle.id,
        })
      ).result as ResolvedSkill["bundle"];
      expect(pinned.digest).toBe(first.bundle.digest);
    } finally {
      await host.close();
    }
  });

  test("[G3] inspection exposes the complete execution contract", async () => {
    const inspection = (await resolveFixture("g3", "verify")).inspection;
    expect(inspection).toMatchObject({
      capabilities: ["process.test", "repository.read"],
      compatibility: 1,
      id: "verify",
      inputArtifactKinds: ["patch", "report.md"],
      version: 1,
    });
    expect(inspection.files.map(({ path }) => path)).toEqual([
      "guidance.md",
      "instructions.md",
      "skill.yaml",
    ]);
    expect(inspection.resultSchema.properties.passed?.type).toBe("boolean");
    const source = await readFile(join(process.cwd(), "factory.yaml"), "utf8");
    const plan = compileFactoryDefinition(source).plansV2["issue-triage"];
    const verifyStep = plan?.steps.find(({ id }) => id === "verify");
    const fixStep = plan?.steps.find(({ id }) => id === "fix");
    expect(verifyStep?.capabilities).toEqual(["repository.read", "process.test"]);
    expect(fixStep?.capabilities).toEqual(["repository.read", "repository.patch", "process.test"]);
  });

  test("[G4] unsafe and incompatible skill fixtures fail before execution", async () => {
    const traversal = await skillFixture("g4-traversal");
    await writeFile(
      join(traversal.skill, "skill.yaml"),
      (await readFile(join(traversal.skill, "skill.yaml"), "utf8")).replace(
        "instruction: instructions.md",
        "instruction: ../outside.md",
      ),
    );
    await expect(
      new SkillResolver({ roots: [traversal.root] }).resolve(traversal.skill),
    ).rejects.toThrow("skill_root_escape");

    const incompatible = await skillFixture("g4-version");
    await writeFile(
      join(incompatible.skill, "skill.yaml"),
      (await readFile(join(incompatible.skill, "skill.yaml"), "utf8")).replace(
        "compatibility: 1",
        "compatibility: 2",
      ),
    );
    await expect(
      new SkillResolver({ roots: [incompatible.root] }).resolve(incompatible.skill),
    ).rejects.toThrow("incompatible_skill_version");

    const linked = await skillFixture("g4-link");
    await rm(join(linked.skill, "guidance.md"));
    await symlink("/etc/hosts", join(linked.skill, "guidance.md"));
    await expect(new SkillResolver({ roots: [linked.root] }).resolve(linked.skill)).rejects.toThrow(
      "skill_symlink_forbidden",
    );

    const duplicateRoot = await temporary("g4-duplicate");
    await cp(join(process.cwd(), "skills", "reproduce"), join(duplicateRoot, "one"), {
      recursive: true,
    });
    await cp(join(process.cwd(), "skills", "reproduce"), join(duplicateRoot, "two"), {
      recursive: true,
    });
    await expect(
      new SkillResolver({ roots: [duplicateRoot] }).resolveAll([
        join(duplicateRoot, "one"),
        join(duplicateRoot, "two"),
      ]),
    ).rejects.toThrow("duplicate_skill_id");

    const cycle = await skillFixture("g4-cycle");
    await writeFile(join(cycle.skill, "instructions.md"), "plain instructions\n");
    await writeFile(
      join(cycle.skill, "skill.yaml"),
      (await readFile(join(cycle.skill, "skill.yaml"), "utf8")).replace(
        "includes: [guidance.md]",
        "includes: [cycle-a.include.yaml]",
      ),
    );
    await writeFile(
      join(cycle.skill, "cycle-a.include.yaml"),
      "includes: [cycle-b.include.yaml]\n",
    );
    await writeFile(
      join(cycle.skill, "cycle-b.include.yaml"),
      "includes: [cycle-a.include.yaml]\n",
    );
    await expect(new SkillResolver({ roots: [cycle.root] }).resolve(cycle.skill)).rejects.toThrow(
      "skill_include_cycle",
    );
    const markdownCycle = await skillFixture("g4-markdown-cycle");
    await writeFile(join(markdownCycle.skill, "guidance.md"), "{{include:guidance.md}}\n");
    await expect(
      new SkillResolver({ roots: [markdownCycle.root] }).resolve(markdownCycle.skill),
    ).rejects.toThrow("skill_include_cycle");
  });

  test("[G5] generated module artifacts assign strict assets to one owner", () => {
    const app = createSoftwareFactoryApp({ readTransport: unavailableGitHubReadTransport });
    const manifest = generateChimpbaseModuleManifest(app.modules);
    const assets = manifest.modules.find((module) => module.name === "assets");
    expect(assets?.resources.tables).toEqual(
      expect.arrayContaining(["artifacts_v2", "skill_revisions_v2"]),
    );
    expect(RESOURCE_OWNERS.artifacts_v2).toBe("assets");
    expect(RESOURCE_OWNERS.skill_revisions_v2).toBe("assets");
  });

  test("[G6] corruption is detected and legacy database blobs migrate on read", async () => {
    const root = await temporary("g6");
    const driver = new LocalArtifactByteDriver(root);
    const bytes = Buffer.from("correct");
    const value = digest(bytes);
    await driver.put(value, bytes);
    const hex = value.slice("sha256:".length);
    await writeFile(join(root, hex.slice(0, 2), `${hex.slice(2)}.blob`), "corrupt");
    await expect(driver.get(value)).rejects.toThrow("artifact_corrupt");

    const databasePath = join(root, "legacy.sqlite");
    const migratedDriver = new MemoryArtifactByteDriver();
    const initialize = await createChimpbase({
      app: createSoftwareFactoryApp({
        artifactByteDriver: migratedDriver,
        readTransport: unavailableGitHubReadTransport,
      }),
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path: databasePath },
      subscriptions: { dispatch: "async" },
    });
    await initialize.close();
    const legacyBytes = Buffer.from("legacy bytes");
    const legacyDigest = digest(legacyBytes);
    const database = new Database(databasePath);
    database
      .query(
        "INSERT INTO artifacts (digest, run_id, name, media_type, size, classification) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        legacyDigest,
        "legacy-run",
        "legacy.txt",
        "text/plain",
        legacyBytes.byteLength,
        "private",
      );
    database
      .query("INSERT INTO artifact_blobs (digest, content_base64) VALUES (?, ?)")
      .run(legacyDigest, legacyBytes.toString("base64"));
    database.close();
    const migrated = await createChimpbase({
      app: createSoftwareFactoryApp({
        artifactByteDriver: migratedDriver,
        readTransport: unavailableGitHubReadTransport,
      }),
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path: databasePath },
      subscriptions: { dispatch: "async" },
    });
    try {
      const envelope = (
        await migrated.executeAction("assets/getArtifact@v1", { digest: legacyDigest })
      ).result as { contentBase64: string };
      expect(Buffer.from(envelope.contentBase64, "base64")).toEqual(legacyBytes);
      expect(await migratedDriver.get(legacyDigest)).toEqual(legacyBytes);
    } finally {
      await migrated.close();
    }

    const { host: compatibilityHost } = await boot();
    try {
      const bareBytes = Buffer.from("bare V1 digest");
      const bareDigest = createHash("sha256").update(bareBytes).digest("hex");
      const v1Artifact = {
        classification: "private" as const,
        digest: bareDigest,
        mediaType: "text/plain",
        name: "bare.txt",
        runId: "bare-run",
        size: bareBytes.byteLength,
      };
      await compatibilityHost.executeAction("assets/putArtifact@v1", {
        artifact: v1Artifact,
        contentBase64: bareBytes.toString("base64"),
      });
      const roundTrip = (
        await compatibilityHost.executeAction("assets/getArtifact@v1", {
          digest: bareDigest,
        })
      ).result as { artifact: { digest: string }; contentBase64: string };
      expect(roundTrip.artifact.digest).toBe(bareDigest);
      expect(Buffer.from(roundTrip.contentBase64, "base64")).toEqual(bareBytes);
      const listed = (
        await compatibilityHost.executeAction("assets/listRunArtifacts@v1", {
          runId: "bare-run",
        })
      ).result as Array<{ digest: string }>;
      expect(listed).toEqual([expect.objectContaining({ digest: bareDigest })]);
      await expect(
        compatibilityHost.executeAction("assets/storeArtifactV2@v1", {
          artifact: {
            attemptId: "bare-attempt",
            classification: "private",
            createdAt: now,
            digest: bareDigest,
            kind: "metadata",
            mediaType: "text/plain",
            name: "bare.txt",
            redaction: "raw-private",
            retention: "retained",
            runId: "bare-run",
            size: bareBytes.byteLength,
          },
          contentBase64: bareBytes.toString("base64"),
        }),
      ).rejects.toThrow("digest_mismatch");
    } finally {
      await compatibilityHost.close();
    }
    const durablePath = join(root, "strict-durable.sqlite");
    const strictBytes = Buffer.from("strict durable bytes");
    const strictDigest = digest(strictBytes);
    const strictHost = await createChimpbase({
      app: createSoftwareFactoryApp({ readTransport: unavailableGitHubReadTransport }),
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path: durablePath },
      subscriptions: { dispatch: "async" },
    });
    await strictHost.executeAction("assets/storeArtifactV2@v1", {
      artifact: {
        attemptId: "durable-attempt",
        classification: "private",
        createdAt: now,
        digest: strictDigest,
        kind: "metadata",
        mediaType: "text/plain",
        name: "durable.txt",
        redaction: "raw-private",
        retention: "retained",
        runId: "durable-run",
        size: strictBytes.byteLength,
      },
      contentBase64: strictBytes.toString("base64"),
    });
    await strictHost.close();
    const restartedStrictHost = await createChimpbase({
      app: createSoftwareFactoryApp({ readTransport: unavailableGitHubReadTransport }),
      projectDir: process.cwd(),
      storage: { engine: "sqlite", path: durablePath },
      subscriptions: { dispatch: "async" },
    });
    try {
      const durable = (
        await restartedStrictHost.executeAction("assets/getArtifactV2@v1", {
          allowedDigests: [strictDigest],
          attemptId: "reader",
          digest: strictDigest,
          runId: "durable-run",
        })
      ).result as { contentBase64: string };
      expect(Buffer.from(durable.contentBase64, "base64")).toEqual(strictBytes);
    } finally {
      await restartedStrictHost.close();
    }
  });

  test("[G7] attempts receive only explicitly declared artifact digests", async () => {
    const { host } = await boot();
    try {
      const value = await storePrivate(host, "declared");
      const allowed = await host.executeAction("assets/materializeForAttemptV2@v1", {
        allowedDigests: [value],
        attemptId: "consumer",
        digest: value,
        runId: "run-a",
      });
      expect(
        Buffer.from(
          (allowed.result as { contentBase64: string }).contentBase64,
          "base64",
        ).toString(),
      ).toBe("declared");
      await expect(
        host.executeAction("assets/materializeForAttemptV2@v1", {
          allowedDigests: [],
          attemptId: "consumer",
          digest: value,
          runId: "run-a",
        }),
      ).rejects.toThrow("artifact_access_denied");
    } finally {
      await host.close();
    }
    const seenInputs: string[][] = [];
    const delegate = fakeAgentRuntime({
      verify: { evidence: "filtered", passed: true, testResults: [] },
    });
    const filteringRuntime: AgentRuntime = {
      async cancel(attemptId) {
        await delegate.cancel(attemptId);
      },
      async run(request, signal) {
        seenInputs.push(request.inputArtifacts.map(({ digest: inputDigest }) => inputDigest));
        return await delegate.run(request, signal);
      },
    };
    const { host: filteringHost } = await boot(new MemoryArtifactByteDriver(), filteringRuntime);
    try {
      const reportDigest = await storePrivate(
        filteringHost,
        "allowed report",
        "filter-run",
        "producer",
        "report.md",
      );
      const logDigest = await storePrivate(
        filteringHost,
        "disallowed log",
        "filter-run",
        "producer",
        "log",
      );
      const verify = await resolveFixture("g7-verify", "verify");
      await filteringHost.executeAction("execution/requestAttemptV3@v1", {
        ...executionRequest("g7-filter", verify.bundle),
        inputArtifacts: [reportDigest, logDigest].map((inputDigest) => ({
          digest: inputDigest,
          kind: "artifact",
          path: `${inputDigest}.bin`,
          size: 0,
        })),
        runId: "filter-run",
      });
      await filteringHost.drain({ maxDurationMs: 5_000 });
      expect(seenInputs).toEqual([[reportDigest]]);
    } finally {
      await filteringHost.close();
    }
  });

  test("[G8] publication redacts secrets and retains private raw bytes", async () => {
    const { host } = await boot();
    try {
      const secret = "token=super-secret-value";
      const value = await storePrivate(host, `report ${secret}`);
      const published = (
        await host.executeAction("assets/publishArtifactV2@v1", {
          attemptId: "attempt-a",
          createdAt: now,
          digest: value,
          runId: "run-a",
        })
      ).result as { artifact: { digest: string; sourceDigest: string }; contentBase64: string };
      expect(published.artifact.digest).not.toBe(value);
      expect(published.artifact.sourceDigest).toBe(value);
      expect(Buffer.from(published.contentBase64, "base64").toString()).not.toContain(secret);
      const raw = (
        await host.executeAction("assets/getArtifactV2@v1", {
          allowedDigests: [value],
          attemptId: "consumer",
          digest: value,
          runId: "run-a",
        })
      ).result as { contentBase64: string };
      expect(Buffer.from(raw.contentBase64, "base64").toString()).toContain(secret);
    } finally {
      await host.close();
    }
  });

  test("[G9] every starter skill accepts its typed fake-agent report", async () => {
    const reports: Record<string, Record<string, unknown>> = {
      reproduce: { evidence: "observed", reproduced: true },
      diagnose: { confidence: 0.9, evidence: "trace", rootCause: "shared guard" },
      verify: { evidence: "command passed", passed: true, testResults: ["focused check"] },
      fix: { changedFiles: ["src/a.ts"], summary: "fixed guard", tests: ["focused check"] },
      "pr-writer": { body: "Observed checks", title: "Fix guard" },
    };
    const { host } = await boot(new MemoryArtifactByteDriver(), fakeAgentRuntime(reports));
    try {
      for (const [id, report] of Object.entries(reports)) {
        const resolved = await resolveFixture(`g9-${id}`, id);
        expect(() => validateSkillResult(resolved.bundle.resultSchema, report)).not.toThrow();
        await host.executeAction(
          "execution/requestAttemptV3@v1",
          executionRequest(`g9-${id}`, resolved.bundle),
        );
      }
      await host.drain({ maxDurationMs: 5_000 });
      for (const id of Object.keys(reports)) {
        const attempt = (
          await host.executeAction("execution/getAttemptV3@v1", { attemptId: `g9-${id}` })
        ).result as { outcome: string; result?: AgentResult };
        expect(attempt.outcome).toBe("succeeded");
        expect(attempt.result?.failure).toBeUndefined();
        const predecessor = (
          await host.executeAction("execution/getAttemptV2@v1", { attemptId: `g9-${id}` })
        ).result as { result?: { data: Record<string, unknown> } };
        expect(predecessor.result?.data).toEqual(reports[id]);
      }
    } finally {
      await host.close();
    }
  });

  test("[G10] no other module claims assets storage", () => {
    type AssetsTable = (typeof MODULE_RESOURCES.assets.tables)[number];
    const assetsTables = new Set<AssetsTable>(MODULE_RESOURCES.assets.tables);
    const isAssetsTable = (table: string): table is AssetsTable =>
      MODULE_RESOURCES.assets.tables.some((candidate) => candidate === table);
    const app = createSoftwareFactoryApp({ readTransport: unavailableGitHubReadTransport });
    for (const module of app.modules) {
      if (module.interface.name === "assets") continue;
      for (const table of module.resources.tables ?? []) expect(isAssetsTable(table)).toBe(false);
    }
    for (const table of assetsTables) expect(RESOURCE_OWNERS[table]).toBe("assets");
  });

  test("[G11] canonical closure ignores unrelated filesystem changes", async () => {
    const fixture = await skillFixture("g11");
    const resolver = new SkillResolver({ roots: [fixture.root] });
    const first = await resolver.resolve(fixture.skill);
    await writeFile(join(fixture.root, "outside.txt"), "outside");
    expect((await resolver.resolve(fixture.skill)).bundle.digest).toBe(first.bundle.digest);
    await writeFile(join(fixture.skill, "instructions.md"), "changed instruction\n");
    expect((await resolver.resolve(fixture.skill)).bundle.digest).not.toBe(first.bundle.digest);
  });

  test("[G12] a checked-in edit cannot mutate a stored bundle", async () => {
    const { host } = await boot();
    try {
      const resolved = await resolveFixture("g12");
      await host.executeAction("assets/storeSkillBundleV2@v1", {
        bundle: resolved.bundle,
        source: "skills/reproduce",
      });
      const fetched = (
        await host.executeAction("assets/getSkillBundleV2@v1", { digest: resolved.bundle.digest })
      ).result as ResolvedSkill["bundle"];
      const firstFile = fetched.files[0];
      if (firstFile === undefined) throw new Error("stored bundle has no files");
      fetched.files[0] = { ...firstFile, path: "client-mutation" };
      const again = (
        await host.executeAction("assets/getSkillBundleV2@v1", { digest: resolved.bundle.digest })
      ).result as ResolvedSkill["bundle"];
      expect(again.files[0]?.path).not.toBe("client-mutation");
    } finally {
      await host.close();
    }
  });

  test("[G13] undeclared includes and result mismatches are rejected", async () => {
    const fixture = await skillFixture("g13");
    await writeFile(
      join(fixture.skill, "instructions.md"),
      "Unsafe undeclared composition {{include:not-declared.md}}\n",
    );
    await writeFile(join(fixture.skill, "not-declared.md"), "hidden\n");
    await expect(
      new SkillResolver({ roots: [fixture.root] }).resolve(fixture.skill),
    ).rejects.toThrow("undeclared_skill_include");
    const valid = await resolveFixture("g13-result", "verify");
    expect(() => validateSkillResult(valid.bundle.resultSchema, { passed: "yes" })).toThrow(
      "result_schema_mismatch",
    );
    const corrupted = {
      ...valid.bundle,
      files: valid.bundle.files.map((file, index) =>
        index === 0 ? { ...file, contentBase64: Buffer.from("tampered").toString("base64") } : file,
      ),
    };
    const { host } = await boot();
    try {
      await expect(
        host.executeAction("assets/verifySkillBundleV2@v1", { bundle: corrupted }),
      ).rejects.toThrow("digest_mismatch");
      const mutableInstructions = { ...valid.bundle, instructions: "mutated after pin" };
      await expect(
        host.executeAction("assets/verifySkillBundleV2@v1", {
          bundle: mutableInstructions,
        }),
      ).rejects.toThrow("invalid_skill_bundle");
      await expect(
        host.executeAction(
          "execution/requestAttemptV3@v1",
          executionRequest("g13-mutable", mutableInstructions),
        ),
      ).rejects.toThrow("invalid_skill_bundle");
      const fix = await resolveFixture("g13-fix", "fix");
      const multiSkill = executionRequest("g13-multi", valid.bundle);
      await expect(
        host.executeAction("execution/requestAttemptV3@v1", {
          ...multiSkill,
          agentProfile: {
            ...multiSkill.agentProfile,
            skills: [valid.bundle.id, fix.bundle.id],
          },
          skills: [valid.bundle, fix.bundle],
        }),
      ).rejects.toThrow("at most one skill");
    } finally {
      await host.close();
    }
  });

  test("[G14] local and memory drivers have atomic immutable parity", async () => {
    const root = await temporary("g14");
    const local = new LocalArtifactByteDriver(root);
    const memory = new MemoryArtifactByteDriver();
    const bytes = Buffer.from("same immutable bytes");
    const value = digest(bytes);
    await Promise.all(Array.from({ length: 8 }, async () => await local.put(value, bytes)));
    await Promise.all(Array.from({ length: 8 }, async () => await memory.put(value, bytes)));
    expect(await local.get(value)).toEqual(bytes);
    expect(await memory.get(value)).toEqual(bytes);
    await expect(local.put(value, Buffer.from("wrong"))).rejects.toThrow("digest_mismatch");
    await expect(memory.put(value, Buffer.from("wrong"))).rejects.toThrow("digest_mismatch");
    const { host } = await boot();
    try {
      const contentBase64 = bytes.toString("base64");
      for (const name of ["one.patch", "two.patch"]) {
        await host.executeAction("assets/storeArtifactV2@v1", {
          artifact: {
            attemptId: "same-bytes-attempt",
            classification: "private",
            createdAt: now,
            digest: value,
            kind: "patch",
            mediaType: "application/octet-stream",
            name,
            redaction: "raw-private",
            retention: "retained",
            runId: "same-bytes-run",
            size: bytes.byteLength,
          },
          contentBase64,
        });
      }
      const records = (
        await host.executeAction("assets/listRunArtifactsV2@v1", {
          runId: "same-bytes-run",
        })
      ).result as Array<{ digest: string; name: string }>;
      expect(records).toHaveLength(2);
      expect(records.map(({ name }) => name).sort()).toEqual(["one.patch", "two.patch"]);
    } finally {
      await host.close();
    }
  });

  test("[G15] an allowed digest still cannot cross run ownership", async () => {
    const { host } = await boot();
    try {
      const value = await storePrivate(host, "run-owned");
      await expect(
        host.executeAction("assets/getArtifactV2@v1", {
          allowedDigests: [value],
          attemptId: "consumer",
          digest: value,
          runId: "run-b",
        }),
      ).rejects.toThrow("artifact_access_denied");
    } finally {
      await host.close();
    }
  });

  test("[G16] redaction creates public bytes without altering retention policy", async () => {
    const { host } = await boot();
    try {
      const rawDigest = await storePrivate(
        host,
        "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
        "run-a",
        "attempt-a",
        "log",
      );
      const publication = (
        await host.executeAction("assets/publishArtifactV2@v1", {
          attemptId: "attempt-a",
          createdAt: now,
          digest: rawDigest,
          runId: "run-a",
        })
      ).result as {
        artifact: { classification: string; digest: string; retention: string };
        contentBase64: string;
      };
      expect(publication.artifact).toMatchObject({
        classification: "public",
        retention: "retained",
      });
      expect(Buffer.from(publication.contentBase64, "base64").toString()).toContain("[REDACTED]");
      const listed = (await host.executeAction("assets/listRunArtifactsV2@v1", { runId: "run-a" }))
        .result as Array<{ classification: string; digest: string; retention: string }>;
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: "private",
            digest: rawDigest,
            retention: "retained",
          }),
          expect.objectContaining({
            classification: "public",
            digest: publication.artifact.digest,
          }),
        ]),
      );
    } finally {
      await host.close();
    }
  });

  test("[G17] strict result mismatch becomes result-invalid before advancement", async () => {
    const resolved = await resolveFixture("g17-verify", "verify");
    const { host } = await boot(
      new MemoryArtifactByteDriver(),
      fakeAgentRuntime({ verify: { evidence: "claimed", passed: "yes", testResults: [] } }),
    );
    try {
      await host.executeAction(
        "execution/requestAttemptV3@v1",
        executionRequest("g17-verify", resolved.bundle),
      );
      await host.drain({ maxDurationMs: 5_000 });
      const attempt = (
        await host.executeAction("execution/getAttemptV3@v1", { attemptId: "g17-verify" })
      ).result as { outcome: string; result?: AgentResult };
      expect(attempt.outcome).toBe("failed");
      expect(attempt.result?.failure?.category).toBe("result-invalid");
    } finally {
      await host.close();
    }
  });

  test("[G18] CLI inspection emits stable source, digest, and contracts", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      [
        "skills",
        "inspect",
        "--config",
        join(process.cwd(), "factory.yaml"),
        "--id",
        "verify",
        "--json",
      ],
      { stderr: (text) => stderr.push(text), stdout: (text) => stdout.push(text) },
      {
        checkModules: async () => undefined,
        readText: async (path) => await readFile(path, "utf8"),
      },
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const [inspection] = JSON.parse(stdout.join("")) as Array<Record<string, unknown>>;
    expect(inspection).toMatchObject({
      capabilities: ["process.test", "repository.read"],
      digest: "sha256:d88bbe0b9e12989d982e1a98950e742bf03561f8cdb82fc2b1c3d61f43161082",
      id: "verify",
      inputArtifactKinds: ["patch", "report.md"],
    });
    expect(inspection?.sourcePath).toBe(join(process.cwd(), "skills", "verify"));
    expect(inspection?.resultSchema).toBeDefined();
    expect(inspection?.files).toBeDefined();
    for (const command of ["list", "verify"]) {
      const commandOutput: string[] = [];
      const commandErrors: string[] = [];
      expect(
        await runCli(
          ["skills", command, "--config", join(process.cwd(), "factory.yaml"), "--json"],
          {
            stderr: (text) => commandErrors.push(text),
            stdout: (text) => commandOutput.push(text),
          },
          {
            checkModules: async () => undefined,
            readText: async (path) => await readFile(path, "utf8"),
          },
        ),
      ).toBe(0);
      expect(commandErrors).toEqual([]);
      expect(JSON.parse(commandOutput.join(""))).toHaveLength(5);
    }
    const activationRoot = await temporary("g18-activation");
    await cp(join(process.cwd(), "skills"), join(activationRoot, "skills"), { recursive: true });
    const configuredSource = await readFile(join(process.cwd(), "factory.yaml"), "utf8");
    const unpinnedSource = configuredSource.replace(
      "revision: sha256:0266a4341e7cb8e3065b55798793298899412b82e1200942773882b35dd1aa48",
      "revision: unpinned",
    );
    const { host: definitionsHost } = await boot();
    try {
      await expect(
        definitionsHost.executeAction("definitions/compileDefinition@v1", {
          source: unpinnedSource,
          sourceName: "unpinned.yaml",
        }),
      ).rejects.toThrow("explicit unpinned marker");
    } finally {
      await definitionsHost.close();
    }
    const activationConfig = join(activationRoot, "factory.yaml");
    await writeFile(activationConfig, unpinnedSource);
    const actions: Array<{ args: unknown; name: string }> = [];
    const activationErrors: string[] = [];
    const activationIo = {
      stderr: (text: string) => activationErrors.push(text),
      stdout: () => {},
    };
    const activationDependencies = {
      checkModules: async () => undefined,
      createAbortController: () => new AbortController(),
      installShutdown: () => () => {},
      openHost: async () => ({
        async close() {},
        async executeAction(name: string, args?: unknown) {
          actions.push({ args, name });
          if (name === "definitions/compileDefinition@v1")
            return { result: { definitionDigest: "definition" } };
          if (name.includes("pollRepository")) return { result: { accepted: 0 } };
          return { result: {} };
        },
      }),
      readText: async (path: string) => await readFile(path, "utf8"),
      sleep: async () => undefined,
    };
    expect(
      await runCli(
        ["daemon", "--once", "--config", activationConfig],
        activationIo,
        activationDependencies,
      ),
    ).toBe(0);
    const stored = actions.find((action) => action.name === "assets/storeSkillBundleV2@v1");
    expect(stored?.args).toMatchObject({
      bundle: { digest: "sha256:0266a4341e7cb8e3065b55798793298899412b82e1200942773882b35dd1aa48" },
      source: "skills/reproduce",
    });
    const compile = actions.find((action) => action.name === "definitions/compileDefinition@v1");
    expect(compile?.args).toMatchObject({
      source: expect.not.stringContaining("revision: unpinned"),
    });

    await writeFile(
      activationConfig,
      configuredSource.replace(
        "revision: sha256:0266a4341e7cb8e3065b55798793298899412b82e1200942773882b35dd1aa48",
        `revision: sha256:${"0".repeat(64)}`,
      ),
    );
    const actionCount = actions.length;
    expect(
      await runCli(
        ["daemon", "--once", "--config", activationConfig],
        activationIo,
        activationDependencies,
      ),
    ).toBe(1);
    expect(actions).toHaveLength(actionCount);
    expect(activationErrors.join("")).toContain("skill digest mismatch");
  });
});
