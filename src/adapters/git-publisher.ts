import { spawn } from "node:child_process";

import type { EffectResultV3 } from "../contracts/index.ts";
import type { GitBranchMutation, GitPublication, GitPublisher } from "./seams.ts";

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string>;
}

export interface VerifiedGitPublisherOptions {
  readonly allowedBranchPrefix?: string;
  readonly remote?: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly runner?: GitCommandRunner;
}

export class VerifiedGitPublisher implements GitPublisher {
  readonly #allowedBranchPrefix: string;
  readonly #remote: string;
  readonly #repositories: Readonly<Record<string, string>>;
  readonly #runner: GitCommandRunner;

  constructor(options: VerifiedGitPublisherOptions) {
    this.#allowedBranchPrefix = options.allowedBranchPrefix ?? "factory/";
    this.#remote = options.remote ?? "origin";
    this.#repositories = options.repositories;
    this.#runner = options.runner ?? nodeGitRunner;
  }

  async createBranch(input: GitBranchMutation): Promise<EffectResultV3> {
    if (input.kind !== "create") throw new Error("git_publish_invalid_operation");
    const cwd = this.#owned(input.repository, input.branch);
    const base = await this.#revision(cwd, input.expectedRevision);
    if (base !== input.expectedRevision) throw new Error("git_publish_stale_base");
    const existing = await this.#remoteRevision(cwd, input.branch);
    if (existing !== null) {
      if (existing !== base) throw new Error("git_publish_branch_conflict");
      return gitResult(existing, "already_applied");
    }
    await this.#runner.run(cwd, [
      "push",
      this.#remote,
      `${base}:refs/heads/${input.branch}`,
      `--force-with-lease=refs/heads/${input.branch}:`,
    ]);
    return gitResult(base, "applied");
  }

  async deleteBranch(input: GitBranchMutation): Promise<EffectResultV3> {
    if (input.kind !== "delete") throw new Error("git_publish_invalid_operation");
    const cwd = this.#owned(input.repository, input.branch);
    const existing = await this.#remoteRevision(cwd, input.branch);
    if (existing === null) return gitResult(input.expectedRevision, "already_applied");
    if (existing !== input.expectedRevision) throw new Error("git_publish_stale_head");
    await this.#runner.run(cwd, [
      "push",
      this.#remote,
      `:refs/heads/${input.branch}`,
      `--force-with-lease=refs/heads/${input.branch}:${existing}`,
    ]);
    return gitResult(existing, "applied");
  }

  async publish(publication: GitPublication): Promise<{ readonly revision: string }> {
    const result = await this.pushVerifiedCommit({ ...publication, verified: true });
    if (result.externalRevision === null) throw new Error("git_publish_missing_revision");
    return { revision: result.externalRevision };
  }

  async pushVerifiedCommit(publication: GitPublication): Promise<EffectResultV3> {
    if (publication.verified !== true) throw new Error("git_publish_unverified_commit");
    const cwd = this.#owned(publication.repository, publication.branch);
    const base = await this.#revision(cwd, publication.baseRevision);
    if (base !== publication.baseRevision) throw new Error("git_publish_stale_base");
    await this.#runner.run(cwd, ["cat-file", "-e", `${publication.treeDigest}^{tree}`]);
    const commit = (
      await this.#runner.run(cwd, [
        "commit-tree",
        publication.treeDigest,
        "-p",
        base,
        "-m",
        publication.commitMessage,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("git_publish_invalid_commit");
    const existing = await this.#remoteRevision(cwd, publication.branch);
    if (existing === commit) return gitResult(commit, "already_applied");
    if (existing !== null && existing !== base) throw new Error("git_publish_stale_head");
    await this.#runner.run(cwd, [
      "push",
      this.#remote,
      `${commit}:refs/heads/${publication.branch}`,
      `--force-with-lease=refs/heads/${publication.branch}:${existing ?? ""}`,
    ]);
    return gitResult(commit, "applied");
  }

  async probe(input: GitBranchMutation | GitPublication): Promise<EffectResultV3 | null> {
    if ("kind" in input) {
      const cwd = this.#owned(input.repository, input.branch);
      const revision = await this.#remoteRevision(cwd, input.branch);
      if (input.kind === "delete")
        return revision === null ? gitResult(input.expectedRevision, "already_applied") : null;
      return revision === input.expectedRevision ? gitResult(revision, "already_applied") : null;
    }
    const cwd = this.#owned(input.repository, input.branch);
    const revision = await this.#remoteRevision(cwd, input.branch);
    if (revision === null) return null;
    const message = await this.#runner.run(cwd, ["show", "-s", "--format=%B", revision]);
    return message.includes(input.commitMessage) ? gitResult(revision, "already_applied") : null;
  }

  #owned(repository: string, branch: string): string {
    const cwd = this.#repositories[repository];
    if (cwd === undefined) throw new Error("git_publish_unknown_repository");
    if (
      !branch.startsWith(this.#allowedBranchPrefix) ||
      branch.includes("..") ||
      branch.endsWith("/")
    )
      throw new Error("git_publish_branch_not_owned");
    return cwd;
  }

  async #revision(cwd: string, revision: string): Promise<string> {
    return (await this.#runner.run(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
  }

  async #remoteRevision(cwd: string, branch: string): Promise<string | null> {
    const output = (
      await this.#runner.run(cwd, ["ls-remote", "--heads", this.#remote, `refs/heads/${branch}`])
    ).trim();
    if (output === "") return null;
    const revision = output.split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("git_publish_invalid_remote_revision");
    return revision;
  }
}

const nodeGitRunner: GitCommandRunner = {
  run(cwd, args) {
    const { promise, reject, resolve } = Promise.withResolvers<string>();
    const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(
            `git command failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
    return promise;
  },
};

function gitResult(revision: string, outcome: "applied" | "already_applied"): EffectResultV3 {
  return {
    externalId: revision,
    externalRevision: revision,
    externalUrl: null,
    failureCategory: null,
    outcome,
  };
}
