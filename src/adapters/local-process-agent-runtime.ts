import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentFailure,
  type AgentMaterialization,
  type AgentRequest,
  type AgentResult,
  parseAgentRequest,
  parseAgentResult,
} from "../contracts/index.ts";
import type { AgentRuntime } from "./seams.ts";

const EMPTY_DIGEST = createHash("sha256").update("").digest("hex");
const SECRET_MARKER =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|gh[opsu]_[A-Za-z0-9]|AWS_SECRET_ACCESS_KEY|Bearer\s+[A-Za-z0-9._-]{16})/u;
const SAFE_ENVIRONMENT_NAMES: Readonly<Record<string, true>> = {
  FACTORY_MODEL_HINT: true,
  LANG: true,
  LC_ALL: true,
  NO_COLOR: true,
  TERM: true,
  TZ: true,
};
const ATTEMPT_SIGNAL = new AsyncLocalStorage<AbortSignal>();

type FailureCategory = AgentFailure["category"];
type DebugRetention = "always" | "never" | "on-failure";

export interface LocalProcessAgentRuntimeOptions {
  readonly bwrapPath?: string;
  readonly debugRetention?: DebugRetention;
  readonly killGraceMs?: number;
  readonly now?: () => Date;
  readonly repositoryRoot: string;
  readonly trustedRuntimePaths?: readonly string[];
  readonly workspaceRoot: string;
}

interface ActiveProcess {
  cancelled: boolean;
  child: ChildProcessWithoutNullStreams;
  terminate: () => Promise<void>;
}

interface Workspace {
  readonly path: string;
  readonly request: AgentRequest;
}

interface ProcessCapture {
  readonly cpuMs: number;
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: Buffer;
  readonly stderrTruncated: boolean;
  readonly maxRssBytes: number;
  readonly stdout: Buffer;
  readonly stdoutOverflow: boolean;
  readonly timedOut: boolean;
}

interface CommandResult {
  readonly code: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}

export class LocalProcessAgentRuntime implements AgentRuntime {
  readonly #attemptControllers = new Map<string, AbortController>();
  lastLaunchCommand: string[] = [];
  readonly #active = new Map<string, ActiveProcess>();
  readonly #bwrapPath: string;
  readonly #debugRetention: DebugRetention;
  readonly #killGraceMs: number;
  readonly #manager: WorkspaceManager;
  readonly #now: () => Date;
  readonly #trustedRuntimePaths: readonly string[];

  constructor(options: LocalProcessAgentRuntimeOptions) {
    this.#bwrapPath = options.bwrapPath ?? "/usr/bin/bwrap";
    this.#debugRetention = options.debugRetention ?? "never";
    this.#killGraceMs = options.killGraceMs ?? 250;
    this.#now = options.now ?? (() => new Date());
    this.#trustedRuntimePaths = options.trustedRuntimePaths ?? ["/usr", "/bin", "/lib", "/lib64"];
    this.#manager = new WorkspaceManager(options.repositoryRoot, options.workspaceRoot);
  }

  async recover(): Promise<void> {
    await this.#manager.recover();
  }

  async cancel(attemptId: string): Promise<void> {
    this.#attemptControllers.get(attemptId)?.abort("cancel");
    const active = this.#active.get(attemptId);
    if (active === undefined) return;
    active.cancelled = true;
    await active.terminate();
  }

  async run(rawRequest: AgentRequest, signal: AbortSignal): Promise<AgentResult> {
    let request: AgentRequest;
    try {
      request = parseAgentRequest(rawRequest);
      validateRequestPaths(request);
      validateEnvironment(request.agentProfile.environment);
    } catch (error) {
      return failureResult(rawRequest, "adapter", message(error), this.#now());
    }
    const inputFrame = Buffer.from(`${JSON.stringify(request)}\n`);
    const inputLimit = Math.min(
      request.agentProfile.limits.maxInputBytes,
      request.budget.maxInputBytes,
    );
    if (inputFrame.length > inputLimit)
      return failureResult(
        request,
        "adapter",
        "encoded request exceeds maxInputBytes",
        this.#now(),
      );

    const started = this.#now();
    const controller = new AbortController();
    ATTEMPT_SIGNAL.enterWith(controller.signal);
    this.#attemptControllers.set(request.attemptId, controller);
    const forwardAbort = () => controller.abort("cancel");
    signal.addEventListener("abort", forwardAbort, { once: true });
    const attemptTimer = setTimeout(
      () => controller.abort("timeout"),
      Math.min(request.agentProfile.limits.timeoutMs, request.budget.maxDurationMs),
    );
    attemptTimer.unref();
    let workspace: Workspace | undefined;
    let result: AgentResult;
    try {
      if (signal.aborted) controller.abort("cancel");
      await this.#manager.ensureRecovered();
      throwIfAborted(controller.signal);
      workspace = await this.#manager.create(request);
      throwIfAborted(controller.signal);
      await this.#manager.materialize(workspace);
      throwIfAborted(controller.signal);
      const capture = await this.#invoke(workspace, controller.signal);
      result = await this.#interpret(workspace, capture, started);
      if (
        this.#debugRetention === "never" ||
        (this.#debugRetention === "on-failure" && result.status === "succeeded")
      ) {
        try {
          await this.#manager.cleanup(workspace.path);
        } catch (error) {
          if (result.outcome !== undefined)
            result = failureResult(
              request,
              "adapter",
              `workspace cleanup failed: ${message(error)}`,
              started,
            );
        }
      }
    } catch (error) {
      const category =
        controller.signal.reason === "timeout"
          ? "timeout"
          : controller.signal.aborted
            ? "cancel"
            : error instanceof SandboxError
              ? error.category
              : "adapter";
      result = failureResult(request, category, message(error), started, this.#now());
    } finally {
      clearTimeout(attemptTimer);
      signal.removeEventListener("abort", forwardAbort);
      this.#attemptControllers.delete(request.attemptId);
    }
    return result;
  }

  async #invoke(workspace: Workspace, signal: AbortSignal): Promise<ProcessCapture> {
    const request = workspace.request;
    const writable = request.agentProfile.capabilityPreset !== "read-only";
    const executable = request.agentProfile.command[0];
    if (executable === undefined || !isAbsolute(executable))
      throw new SandboxError("sandbox", "agent command must use an absolute trusted executable");
    const executablePath = await realpath(executable);
    let executableTrusted = false;
    for (const trustedPath of this.#trustedRuntimePaths) {
      try {
        const trustedRealPath = await realpath(trustedPath);
        const metadata = await stat(trustedRealPath);
        const rel = relative(trustedRealPath, executablePath);
        if (
          (metadata.isFile() && rel === "") ||
          (metadata.isDirectory() &&
            (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))))
        ) {
          executableTrusted = true;
          break;
        }
      } catch {
        // A missing optional trusted runtime path cannot authorize the command.
      }
    }
    if (!executableTrusted)
      throw new SandboxError("sandbox", "agent command is outside trusted runtime paths");
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--clearenv",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/workspace",
    ];
    for (const trustedPath of this.#trustedRuntimePaths) {
      try {
        await stat(trustedPath);
        args.push("--ro-bind", trustedPath, trustedPath);
      } catch {
        // Optional multilib paths differ across Linux distributions.
      }
    }
    args.push(writable ? "--bind" : "--ro-bind", workspace.path, "/workspace");
    args.push("--ro-bind", join(workspace.path, ".factory"), "/workspace/.factory");
    args.push("--ro-bind", "/dev/null", "/workspace/.git");
    args.push("--chdir", "/workspace");
    for (const [name, value] of Object.entries(request.agentProfile.environment).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      args.push("--setenv", name, value);
    args.push(
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "FACTORY_WORKSPACE",
      "/workspace",
      "--setenv",
      "FACTORY_INPUTS",
      "/workspace/.factory/inputs",
      "--setenv",
      "FACTORY_SKILLS",
      "/workspace/.factory/skills",
      "--setenv",
      "FACTORY_TASK",
      "/workspace/.factory/task/request.json",
      "--",
      "/usr/bin/prlimit",
      `--as=${request.agentProfile.limits.memoryBytes}`,
      `--cpu=${request.agentProfile.limits.cpuSeconds}`,
      `--fsize=${request.agentProfile.limits.maxFileBytes}`,
      `--nproc=${request.agentProfile.limits.maxPids}`,
      "--",
      ...request.agentProfile.command,
    );
    const usagePath = `${workspace.path}.usage`;

    const launchArgs = ["-f", "cpu=%U,%S rss=%M", "-o", usagePath, this.#bwrapPath, ...args];
    this.lastLaunchCommand = ["/usr/bin/time", ...launchArgs];
    const child = spawn("/usr/bin/time", launchArgs, {
      cwd: workspace.path,
      detached: true,
      env: {},
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let terminating: Promise<void> | undefined;
    let timedOut = false;
    const terminate = async () => {
      terminating ??= terminateProcessGroup(child, this.#killGraceMs);
      await terminating;
    };
    const active: ActiveProcess = { cancelled: false, child, terminate };
    this.#active.set(request.attemptId, active);
    const onAbort = () => {
      if (signal.reason === "timeout") timedOut = true;
      else active.cancelled = true;
      void terminate();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const durationLimit = Math.min(
      request.agentProfile.limits.timeoutMs,
      request.budget.maxDurationMs,
    );
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, durationLimit);
    timer.unref();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrTruncated = false;
    const outputLimit = Math.min(
      request.agentProfile.limits.maxOutputBytes,
      request.budget.maxOutputBytes,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) {
        stdoutOverflow = true;
        void terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = request.agentProfile.limits.maxLogBytes - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
      if (kept.length !== chunk.length) stderrTruncated = true;
    });
    const {
      promise: processExit,
      reject,
      resolve: resolveExit,
    } = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolveExit({ code, signal: childSignal }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
    try {
      const exit = await processExit;
      let usage: { cpuMs: number; maxRssBytes: number };
      try {
        usage = await measuredUsage(usagePath);
      } catch (error) {
        if (!stdoutOverflow) throw error;
        usage = { cpuMs: 0, maxRssBytes: 0 };
      }
      return {
        ...usage,
        cancelled: active.cancelled,
        exitCode: exit.code,
        signal: exit.signal,
        stderr: Buffer.concat(stderrChunks),
        stderrTruncated,
        stdout: Buffer.concat(stdoutChunks),
        stdoutOverflow,
        timedOut,
      };
    } catch (error) {
      throw new SandboxError(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "sandbox" : "process",
        message(error),
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.#active.delete(request.attemptId);
    }
  }

  async #interpret(
    workspace: Workspace,
    capture: ProcessCapture,
    started: Date,
  ): Promise<AgentResult> {
    const request = workspace.request;
    const finished = this.#now();
    const logs = {
      stderrBytes: capture.stderr.length,
      stderrDigest: sha256(capture.stderr),
      stderrTruncated: capture.stderrTruncated,
      stdoutBytes: capture.stdout.length,
      stdoutDigest: sha256(capture.stdout),
    };
    if (
      SECRET_MARKER.test(capture.stdout.toString("utf8")) ||
      SECRET_MARKER.test(capture.stderr.toString("utf8"))
    )
      return failureResult(
        request,
        "result-invalid",
        "agent output contains a secret marker",
        started,
        finished,
        logs,
      );
    if (capture.stdoutOverflow)
      return failureResult(
        request,
        "result-invalid",
        "agent result exceeded maxOutputBytes",
        started,
        finished,
        logs,
      );
    if (capture.timedOut)
      return failureResult(request, "timeout", "agent process timed out", started, finished, logs);
    if (capture.cancelled)
      return failureResult(request, "cancel", "agent process cancelled", started, finished, logs);
    if (capture.exitCode !== 0) {
      const stderr = capture.stderr.toString("utf8");
      const category = /bwrap:|bubblewrap/iu.test(stderr) ? "sandbox" : "process";
      return failureResult(
        request,
        category,
        `agent process exited ${String(capture.exitCode)}${stderr === "" ? "" : `: ${stderr}`}`,
        started,
        finished,
        logs,
      );
    }

    let parsed: AgentResult;
    try {
      parsed = parseAgentResult(JSON.parse(capture.stdout.toString("utf8")));
      if (parsed.attemptId !== request.attemptId)
        throw new Error("agent result attempt id mismatch");
    } catch (error) {
      return failureResult(request, "result-invalid", message(error), started, finished, logs);
    }

    let exported: { changedFiles: AgentResult["changedFiles"]; patch?: AgentResult["patch"] };
    try {
      exported = await this.#manager.exportChanges(workspace);
    } catch (error) {
      return failureResult(request, "result-invalid", message(error), started, finished, logs);
    }
    const trustedResult = { ...parsed };
    delete trustedResult.commit;
    if (trustedResult.outcome !== undefined)
      trustedResult.outcome = { ...trustedResult.outcome, outputArtifactDigests: [] };
    const result = {
      ...trustedResult,
      ...exported,
      logs,
      resources: { cpuMs: capture.cpuMs, maxRssBytes: capture.maxRssBytes },
      timing: {
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        finishedAt: finished.toISOString(),
        startedAt: started.toISOString(),
      },
    };
    try {
      const encoded = Buffer.from(JSON.stringify(result));
      if (encoded.length > request.budget.maxOutputBytes)
        throw new Error("committed agent result exceeded its output budget");
      return parseAgentResult(result);
    } catch (error) {
      return failureResult(request, "result-invalid", message(error), started, finished, logs);
    }
  }
}

class WorkspaceManager {
  readonly #repositoryRoot: string;
  readonly #root: string;
  #recovered = false;

  constructor(repositoryRoot: string, workspaceRoot: string) {
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#root = resolve(workspaceRoot);
  }

  async ensureRecovered(): Promise<void> {
    if (!this.#recovered) await this.recover();
  }

  async recover(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const actualRoot = await realpath(this.#root);
    if (actualRoot !== this.#root) throw new Error("workspace root must not be a symlink");
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith("attempt-")) continue;
      await this.cleanup(join(this.#root, entry.name));
    }
    this.#recovered = true;
  }
  async create(request: AgentRequest): Promise<Workspace> {
    await this.ensureRecovered();
    await this.#validateTree(request.repository.sha, request.agentProfile.limits);
    const workspacePath = this.#contained(
      `attempt-${sha256(Buffer.from(request.attemptId)).slice(0, 32)}`,
    );
    await this.cleanup(workspacePath);
    await git(this.#repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      workspacePath,
      request.repository.sha,
    ]);
    await git(workspacePath, ["read-tree", request.repository.sha]);
    const workspace = { path: workspacePath, request };
    await this.#archiveInto(request.repository.sha, workspacePath);
    await this.#rejectLinks(workspacePath);
    return workspace;
  }

  async materialize(workspace: Workspace): Promise<void> {
    const factoryRoot = join(workspace.path, ".factory");
    await mkdir(join(factoryRoot, "inputs"), { recursive: true, mode: 0o700 });
    await mkdir(join(factoryRoot, "skills"), { recursive: true, mode: 0o700 });
    await mkdir(join(factoryRoot, "task"), { recursive: true, mode: 0o700 });
    let total = 0;
    const destinations = new Set<string>();
    for (const input of workspace.request.inputArtifacts) {
      total += await this.#materialize(factoryRoot, input, "inputs", destinations);
    }
    for (const skill of workspace.request.skills) {
      if (!workspace.request.agentProfile.skills.includes(skill.id))
        throw new Error(`undeclared skill bundle: ${skill.id}`);
      const instructions = Buffer.from(skill.instructions, "utf8");
      const instructionPath = `${safeSegment(skill.id)}/instructions.txt`;
      total += await this.#writeExclusive(
        join(factoryRoot, "skills"),
        instructionPath,
        instructions,
        destinations,
      );
      for (const file of skill.files)
        total += await this.#materialize(
          factoryRoot,
          file,
          `skills/${safeSegment(skill.id)}`,
          destinations,
        );
    }
    const taskBytes = Buffer.from(JSON.stringify(workspace.request.task), "utf8");
    total += await this.#writeExclusive(
      join(factoryRoot, "task"),
      "request.json",
      taskBytes,
      destinations,
    );
    const limit = Math.min(
      workspace.request.agentProfile.limits.maxInputBytes,
      workspace.request.budget.maxInputBytes,
    );
    if (total > limit) throw new Error("declared input materializations exceed maxInputBytes");
    await this.#rejectLinks(factoryRoot);
  }

  async exportChanges(
    workspace: Workspace,
  ): Promise<{ changedFiles: AgentResult["changedFiles"]; patch?: AgentResult["patch"] }> {
    await this.#rejectLinks(workspace.path);
    const head = (await git(workspace.path, ["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
    if (head !== workspace.request.repository.sha)
      throw new Error("agent attempted to create or change a commit");
    const baseline = await this.#baseline(
      workspace.request.repository.sha,
      workspace.request.agentProfile.limits.maxWorkspaceBytes,
      workspace.request.agentProfile.limits.maxWorkspaceFiles,
      workspace.request.agentProfile.limits.maxFileBytes,
    );
    const files = await listRegularFiles(workspace.path);
    if (files.length > workspace.request.agentProfile.limits.maxWorkspaceFiles)
      throw new Error("workspace file count exceeded");
    let workspaceBytes = 0;
    const currentPaths = new Set<string>();
    const current = new Map<string, Buffer>();
    const changedPaths = new Set<string>();
    for (const path of files) {
      if (path === ".git" || path.startsWith(".factory/")) continue;
      const metadata = await stat(join(workspace.path, path));
      workspaceBytes += metadata.size;
      if (metadata.size > workspace.request.agentProfile.limits.maxFileBytes)
        throw new Error(`workspace file exceeded maxFileBytes: ${path}`);
      if (workspaceBytes > workspace.request.agentProfile.limits.maxWorkspaceBytes)
        throw new Error("workspace bytes exceeded");
      currentPaths.add(path);
      const bytes = await readFile(join(workspace.path, path));
      if (baseline.get(path) !== sha256(bytes)) {
        changedPaths.add(path);
        current.set(path, bytes);
      }
    }
    for (const path of baseline.keys()) if (!currentPaths.has(path)) changedPaths.add(path);
    const trackedChanges = await git(workspace.path, [
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      workspace.request.repository.sha,
      "--",
    ]);
    for (const path of trackedChanges.stdout.toString("utf8").split("\0")) {
      if (path !== "") changedPaths.add(safeRelativePath(path));
    }
    for (const path of changedPaths) {
      if (!current.has(path) && currentPaths.has(path))
        current.set(path, await readFile(join(workspace.path, path)));
    }
    const sorted = [...changedPaths].sort();
    if (workspace.request.agentProfile.capabilityPreset === "read-only" && sorted.length > 0)
      throw new Error("read-only agent modified the repository");
    for (const path of sorted) {
      if (!declaredOutput(path, workspace.request.declaredOutputPaths))
        throw new Error(`agent changed undeclared path: ${path}`);
      const bytes = current.get(path);
      if (bytes !== undefined && SECRET_MARKER.test(bytes.toString("utf8")))
        throw new Error(`agent output contains a secret marker: ${path}`);
    }
    const changedFiles = sorted.map((path) => {
      const bytes = current.get(path) ?? Buffer.alloc(0);
      return {
        contentBase64: bytes.toString("base64"),
        digest: sha256(bytes),
        path,
        size: bytes.length,
      };
    });
    if (sorted.length === 0) return { changedFiles };

    const patchChunks: Buffer[] = [];
    let patchBytes = 0;
    const tracked = sorted.filter((path) => baseline.has(path));
    if (tracked.length > 0) {
      const diff = await command(
        "git",
        [
          "-C",
          workspace.path,
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          workspace.request.repository.sha,
          "--",
          ...tracked,
        ],
        {
          acceptedCodes: [0, 1],
          maxStdoutBytes: workspace.request.agentProfile.limits.maxPatchBytes + 1,
        },
      );
      patchChunks.push(diff.stdout);
      patchBytes += diff.stdout.length;
      if (patchBytes > workspace.request.agentProfile.limits.maxPatchBytes)
        throw new Error("exported patch exceeded maxPatchBytes");
    }
    for (const path of sorted.filter((candidate) => !baseline.has(candidate))) {
      const diff = await command(
        "git",
        [
          "-C",
          workspace.path,
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-index",
          "--",
          "/dev/null",
          path,
        ],
        {
          acceptedCodes: [0, 1],
          maxStdoutBytes: workspace.request.agentProfile.limits.maxPatchBytes - patchBytes + 1,
        },
      );
      patchChunks.push(diff.stdout);
      patchBytes += diff.stdout.length;
      if (patchBytes > workspace.request.agentProfile.limits.maxPatchBytes)
        throw new Error("exported patch exceeded maxPatchBytes");
    }
    const patch = Buffer.concat(patchChunks);
    if (patch.length > workspace.request.agentProfile.limits.maxPatchBytes)
      throw new Error("exported patch exceeded maxPatchBytes");
    return { changedFiles, patch: { digest: sha256(patch), size: patch.length } };
  }

  async cleanup(workspacePath: string): Promise<void> {
    const contained = this.#contained(relative(this.#root, resolve(workspacePath)));
    try {
      await git(this.#repositoryRoot, ["worktree", "remove", "--force", contained]);
    } catch {
      await rm(contained, { force: true, recursive: true });
      await command("git", ["-C", this.#repositoryRoot, "worktree", "prune"], {
        acceptedCodes: [0],
      });
    }
    await rm(contained, { force: true, recursive: true });
  }

  async #validateTree(sha: string, limits: AgentRequest["agentProfile"]["limits"]): Promise<void> {
    const listing = (
      await git(this.#repositoryRoot, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha])
    ).stdout;
    let totalBytes = 0;
    let totalFiles = 0;
    for (const entry of listing.toString("utf8").split("\0")) {
      if (entry === "") continue;
      const match = /^(\d+)\s+(\S+)\s+[0-9a-f]+\s+(\d+|-)\t(.+)$/u.exec(entry);
      if (match === null) throw new Error("invalid git tree entry");
      const mode = match[1];
      const type = match[2];
      const declaredSize = match[3] === "-" ? null : Number(match[3]);
      const path = match[4];
      if (mode === undefined || type === undefined || path === undefined)
        throw new Error("invalid git tree entry captures");
      safeRelativePath(path);
      if (mode === "120000" || mode === "160000" || type === "commit")
        throw new Error(`repository contains a symlink or submodule: ${path}`);
      if (type === "blob") {
        if (declaredSize === null || !Number.isSafeInteger(declaredSize))
          throw new Error(`repository blob has invalid size: ${path}`);
        totalFiles += 1;
        totalBytes += declaredSize;
        if (
          declaredSize > limits.maxFileBytes ||
          totalFiles > limits.maxWorkspaceFiles ||
          totalBytes > limits.maxWorkspaceBytes
        )
          throw new Error("repository size or file count exceeded");
      }
      if (path === ".git" || path.startsWith(".git/"))
        throw new Error("repository collides with reserved git metadata");
      if (path === ".factory" || path.startsWith(".factory/"))
        throw new Error("repository collides with the reserved factory directory");
      if (path === ".gitmodules") throw new Error("repository submodule metadata is not allowed");
      if (path === ".gitattributes" || path.endsWith("/.gitattributes")) {
        const attributes = (
          await git(this.#repositoryRoot, ["show", `${sha}:${path}`])
        ).stdout.toString("utf8");
        if (
          /(?:^|\s)(?:filter|diff|merge|working-tree-encoding)=|(?:^|\s)export-ignore(?:\s|$)/mu.test(
            attributes,
          )
        )
          throw new Error(
            "repository executable or archive-altering git attributes are not allowed",
          );
      }
    }
  }

  async #archiveInto(sha: string, destination: string): Promise<void> {
    const gitProcess = spawn("git", ["-C", this.#repositoryRoot, "archive", "--format=tar", sha], {
      env: safeGitEnvironment(),
      signal: ATTEMPT_SIGNAL.getStore(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarProcess = spawn(
      "tar",
      ["--extract", "--no-same-owner", "--no-same-permissions", "--directory", destination],
      {
        env: {},
        signal: ATTEMPT_SIGNAL.getStore(),
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    gitProcess.stdout.pipe(tarProcess.stdin);
    const [gitExit, tarExit, gitError, tarError] = await Promise.all([
      exitCode(gitProcess),
      exitCode(tarProcess),
      collect(gitProcess.stderr, 64 * 1024),
      collect(tarProcess.stderr, 64 * 1024),
    ]);
    if (gitExit !== 0 || tarExit !== 0)
      throw new Error(
        `safe git archive failed: ${gitError.toString("utf8")}${tarError.toString("utf8")}`,
      );
  }

  async #materialize(
    factoryRoot: string,
    input: AgentMaterialization,
    prefix: string,
    destinations: Set<string>,
  ): Promise<number> {
    if (input.contentBase64 === undefined)
      throw new Error(`materialization bytes unavailable for ${input.digest}`);
    const bytes = decodeBase64(input.contentBase64);
    if (bytes.length !== input.size)
      throw new Error(`materialization size mismatch: ${input.path}`);
    if (!matchesDigest(bytes, input.digest))
      throw new Error(`materialization digest mismatch: ${input.path}`);
    return await this.#writeExclusive(join(factoryRoot, prefix), input.path, bytes, destinations);
  }

  async #writeExclusive(
    root: string,
    requestedPath: string,
    bytes: Buffer,
    destinations: Set<string>,
  ): Promise<number> {
    const safe = safeRelativePath(requestedPath);
    const destination = contained(root, safe);
    if (destinations.has(destination))
      throw new Error(`materialization collision: ${requestedPath}`);
    destinations.add(destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return bytes.length;
  }

  async #baseline(
    sha: string,
    maxBytes: number,
    maxFiles: number,
    maxFileBytes: number,
  ): Promise<Map<string, string>> {
    const listing = (
      await git(this.#repositoryRoot, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha])
    ).stdout;
    const baseline = new Map<string, string>();
    let totalBytes = 0;
    let totalFiles = 0;
    for (const entry of listing.toString("utf8").split("\0")) {
      if (entry === "") continue;
      const match = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\s+(\d+)\t(.+)$/u.exec(entry);
      if (match === null) continue;
      const mode = match[1];
      const type = match[2];
      const oid = match[3];
      const declaredSize = Number(match[4]);
      const path = match[5];
      if (
        mode === undefined ||
        type === undefined ||
        oid === undefined ||
        path === undefined ||
        !Number.isSafeInteger(declaredSize)
      )
        throw new Error("invalid git tree entry captures");
      if (type !== "blob" || mode === "120000") continue;
      totalFiles += 1;
      totalBytes += declaredSize;
      if (declaredSize > maxFileBytes || totalFiles > maxFiles || totalBytes > maxBytes)
        throw new Error("repository size or file count exceeded");
      const bytes = (
        await command("git", ["-C", this.#repositoryRoot, "cat-file", "blob", oid], {
          acceptedCodes: [0],
          env: safeGitEnvironment(),
          maxStdoutBytes: declaredSize + 1,
        })
      ).stdout;
      baseline.set(path, sha256(bytes));
    }
    return baseline;
  }

  async #rejectLinks(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const target = join(root, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error(`workspace symlink is forbidden: ${target}`);
      if (metadata.isDirectory()) await this.#rejectLinks(target);
      else if (!metadata.isFile())
        throw new Error(`workspace special file is forbidden: ${target}`);
    }
  }

  #contained(relativePath: string): string {
    return contained(this.#root, relativePath);
  }
}

class SandboxError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

function validateRequestPaths(request: AgentRequest): void {
  for (const materialization of request.inputArtifacts) safeRelativePath(materialization.path);
  for (const skill of request.skills) {
    safeSegment(skill.id);
    for (const file of skill.files) safeRelativePath(file.path);
  }
  for (const output of request.declaredOutputPaths) safeRelativePath(output.replace(/\/$/u, ""));
  const inputDigests = new Set(request.inputArtifacts.map((entry) => entry.digest));
  if (inputDigests.size !== request.inputArtifacts.length)
    throw new Error("duplicate input artifact digest");
}

function validateEnvironment(environment: Record<string, string>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!Object.hasOwn(SAFE_ENVIRONMENT_NAMES, name))
      throw new Error(`environment name is not allowed: ${name}`);
    if (value.includes("\0") || SECRET_MARKER.test(value))
      throw new Error(`environment value is not allowed: ${name}`);
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..")
    throw new Error(`unsafe path segment: ${value}`);
  return value;
}

function safeRelativePath(value: string): string {
  if (
    value === "" ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error(`unsafe relative path: ${value}`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(String(signal.reason ?? "attempt aborted"));
}

function contained(root: string, requested: string): string {
  const target = resolve(root, requested);
  const rel = relative(resolve(root), target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes trusted root: ${requested}`);
  return target;
}

function declaredOutput(path: string, declarations: readonly string[]): boolean {
  return declarations.some((declared) =>
    declared.endsWith("/") ? path.startsWith(declared) : path === declared,
  );
}

async function measuredUsage(path: string): Promise<{ cpuMs: number; maxRssBytes: number }> {
  try {
    const value = await readFile(path, "utf8");
    const match = /^cpu=([0-9.]+),([0-9.]+) rss=(\d+)$/mu.exec(value.trim());
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
      throw new Error("trusted time output is invalid");
    return {
      cpuMs: Math.max(0, Math.trunc((Number(match[1]) + Number(match[2])) * 1000)),
      maxRssBytes: Math.max(0, Number(match[3]) * 1024),
    };
  } finally {
    await rm(path, { force: true });
  }
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new Error("materialization content is not canonical base64");
  return Buffer.from(value, "base64");
}

function matchesDigest(bytes: Buffer, digest: string): boolean {
  const expected = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return /^[0-9a-f]{64}$/u.test(expected) && sha256(bytes) === expected;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_KEY_2: "core.attributesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_VALUE_2: "/dev/null",
    HOME: "/nonexistent",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
}

async function git(cwd: string, args: readonly string[]): Promise<CommandResult> {
  return await command("git", ["-C", cwd, ...args], {
    acceptedCodes: [0],
    env: safeGitEnvironment(),
  });
}

async function command(
  executable: string,
  args: readonly string[],
  options: {
    readonly acceptedCodes: readonly number[];
    readonly env?: NodeJS.ProcessEnv;
    readonly maxStdoutBytes?: number;
  },
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    env: options.env ?? safeGitEnvironment(),
    signal: ATTEMPT_SIGNAL.getStore(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code, stdout, stderr] = await Promise.all([
    exitCode(child),
    collect(child.stdout, options.maxStdoutBytes ?? 16 * 1024 * 1024),
    collect(child.stderr, 256 * 1024),
  ]);
  if (!options.acceptedCodes.includes(code))
    throw new Error(`${executable} ${args[0] ?? ""} failed (${code}): ${stderr.toString("utf8")}`);
  return { code, stderr, stdout };
}
async function exitCode(child: ChildProcess): Promise<number> {
  const { promise, reject, resolve: resolveExit } = Promise.withResolvers<number>();
  child.once("error", reject);
  child.once("close", (code) => resolveExit(code ?? 128));
  return await promise;
}

async function collect(stream: NodeJS.ReadableStream, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + bytes.length > maximum) throw new Error("trusted process output exceeded bound");
    chunks.push(bytes);
    total += bytes.length;
  }
  return Buffer.concat(chunks);
}

async function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const { promise: grace, resolve: graceElapsed } = Promise.withResolvers<void>();
  setTimeout(graceElapsed, graceMs);
  await grace;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function listRegularFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const directory = join(root, prefix);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name === ".git" || (prefix === "" && entry.name === ".factory")) continue;
    const metadata = await lstat(join(root, path));
    if (metadata.isSymbolicLink()) throw new Error(`workspace symlink is forbidden: ${path}`);
    if (metadata.isDirectory()) files.push(...(await listRegularFiles(root, path)));
    else if (metadata.isFile()) files.push(path);
    else throw new Error(`workspace special file is forbidden: ${path}`);
  }
  return files;
}

function failureResult(
  request: Pick<AgentRequest, "attemptId" | "startedAt">,
  category: FailureCategory,
  failureMessage: string,
  started: Date,
  finished = started,
  logs: AgentResult["logs"] = {
    stderrBytes: 0,
    stderrDigest: EMPTY_DIGEST,
    stderrTruncated: false,
    stdoutBytes: 0,
    stdoutDigest: EMPTY_DIGEST,
  },
): AgentResult {
  return {
    attemptId: request.attemptId,
    changedFiles: [],
    failure: {
      category,
      message: failureMessage.slice(0, 8_192),
      retriable: category !== "result-invalid",
    },
    logs,
    resources: { cpuMs: 0, maxRssBytes: 0 },
    status: "failed",
    tests: [],
    timing: {
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      finishedAt: finished.toISOString(),
      startedAt: started.toISOString(),
    },
  };
}
