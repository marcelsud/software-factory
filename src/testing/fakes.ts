import { createHash } from "node:crypto";

import type {
  AgentRuntime,
  GitBranchMutation,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubListInput,
  GitHubPage,
  GitHubRateLimitRecord,
  GitHubReadPermissionDiagnostic,
  GitHubReadTransport,
  GitHubWriteInput,
  GitHubWriteTransport,
  GitPublication,
  GitPublisher,
} from "../adapters/seams.ts";

export { MemoryArtifactByteDriver } from "../adapters/artifact-byte-driver.ts";

import type {
  AgentRequest,
  AgentRequestV2,
  AgentResult,
  EffectResultV3,
} from "../contracts/index.ts";

type AnyAgentRequest = AgentRequest | AgentRequestV2;

export interface FakeGitHubReadTransportScript {
  readonly comments?: ReadonlyArray<Error | GitHubPage<GitHubIssueCommentRecord>>;
  readonly diagnostics?: ReadonlyArray<Error | GitHubReadPermissionDiagnostic>;
  readonly issues?: ReadonlyArray<Error | GitHubPage<GitHubIssueRecord>>;
  readonly issueReads?: ReadonlyArray<
    Error | { readonly issue: GitHubIssueRecord; readonly rate: GitHubRateLimitRecord }
  >;
  readonly rates?: ReadonlyArray<Error | GitHubRateLimitRecord>;
}

export class FakeGitHubReadTransport implements GitHubReadTransport {
  readonly calls: Array<{ readonly input: unknown; readonly method: string }> = [];
  readonly #comments: Array<Error | GitHubPage<GitHubIssueCommentRecord>>;
  readonly #diagnostics: Array<Error | GitHubReadPermissionDiagnostic>;
  readonly #issues: Array<Error | GitHubPage<GitHubIssueRecord>>;
  readonly #issueReads: Array<
    Error | { readonly issue: GitHubIssueRecord; readonly rate: GitHubRateLimitRecord }
  >;
  readonly #rates: Array<Error | GitHubRateLimitRecord>;

  constructor(script: FakeGitHubReadTransportScript = {}) {
    this.#comments = [...(script.comments ?? [])];
    this.#diagnostics = [...(script.diagnostics ?? [])];
    this.#issues = [...(script.issues ?? [])];
    this.#issueReads = [...(script.issueReads ?? [])];
    this.#rates = [...(script.rates ?? [])];
  }

  async listChangedIssues(input: GitHubListInput): Promise<GitHubPage<GitHubIssueRecord>> {
    this.calls.push({ input, method: "listChangedIssues" });
    return take(this.#issues, emptyPage<GitHubIssueRecord>(), "issue page");
  }

  async listIssueComments(
    input: GitHubListInput & { readonly issueNumber?: number },
  ): Promise<GitHubPage<GitHubIssueCommentRecord>> {
    this.calls.push({ input, method: "listIssueComments" });
    return take(this.#comments, emptyPage<GitHubIssueCommentRecord>(), "comment page");
  }

  async getIssue(input: {
    readonly issueNumber: number;
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly issue: GitHubIssueRecord; readonly rate: GitHubRateLimitRecord }> {
    this.calls.push({ input, method: "getIssue" });
    return take(this.#issueReads, undefined, "issue read");
  }

  async getRateLimit(
    input: { readonly signal?: AbortSignal } = {},
  ): Promise<GitHubRateLimitRecord> {
    this.calls.push({ input, method: "getRateLimit" });
    return take(this.#rates, unlimitedRate(), "rate limit");
  }

  async diagnoseReadPermission(input: {
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }): Promise<GitHubReadPermissionDiagnostic> {
    this.calls.push({ input, method: "diagnoseReadPermission" });
    return take(
      this.#diagnostics,
      {
        canReadIssues: true,
        grantedPermissions: ["issues=read"],
        message: "fake repository is readable",
        rate: unlimitedRate(),
        repository: null,
      },
      "permission diagnostic",
    );
  }
}

export interface FakeGitHubWriteTransportScript {
  readonly applies?: ReadonlyArray<Error | EffectResultV3>;
  readonly inspections?: ReadonlyArray<Error | { readonly revision: string | null }>;
  readonly probes?: ReadonlyArray<Error | EffectResultV3 | null>;
}

export class FakeGitHubWriteTransport implements GitHubWriteTransport {
  readonly calls: Array<{ readonly input: GitHubWriteInput; readonly method: string }> = [];
  readonly #applies: Array<Error | EffectResultV3>;
  readonly #inspections: Array<Error | { readonly revision: string | null }>;
  readonly #probes: Array<Error | EffectResultV3 | null>;

  constructor(script: FakeGitHubWriteTransportScript = {}) {
    this.#applies = [...(script.applies ?? [])];
    this.#inspections = [...(script.inspections ?? [])];
    this.#probes = [...(script.probes ?? [])];
  }

  async apply(input: GitHubWriteInput): Promise<EffectResultV3> {
    this.calls.push({ input, method: "apply" });
    return take(
      this.#applies,
      {
        externalId: `external:${input.intent.idempotencyKey}`,
        externalRevision: `revision:${input.intent.idempotencyKey}`,
        externalUrl: `https://example.invalid/${input.intent.idempotencyKey}`,
        failureCategory: null,
        outcome: "applied",
      },
      "write result",
    );
  }

  async inspect(input: GitHubWriteInput): Promise<{ readonly revision: string | null }> {
    this.calls.push({ input, method: "inspect" });
    return take(
      this.#inspections,
      { revision: input.intent.expectedExternalRevision },
      "write inspection",
    );
  }

  async probe(input: GitHubWriteInput): Promise<EffectResultV3 | null> {
    this.calls.push({ input, method: "probe" });
    return take(this.#probes, null, "write probe");
  }
}

function take<T>(queue: Array<Error | T>, fallback: T | undefined, description: string): T {
  const value = queue.shift() ?? fallback;
  if (value === undefined) throw new Error(`fake GitHub ${description} not configured`);
  if (value instanceof Error) throw value;
  return value;
}

function emptyPage<T>(): GitHubPage<T> {
  return {
    items: [],
    page: { etag: null, nextPage: null, notModified: false, rate: unlimitedRate() },
  };
}

function unlimitedRate(): GitHubRateLimitRecord {
  return { limit: 5_000, remaining: 5_000, resetAt: null, retryAfterMs: null };
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly cancelledAttempts: string[] = [];
  readonly requests: AnyAgentRequest[] = [];
  readonly #result: AgentResult | ((request: AnyAgentRequest) => AgentResult);

  constructor(
    result: AgentResult | ((request: AnyAgentRequest) => AgentResult) = fakeDomainResult,
  ) {
    this.#result = result;
  }

  async run(request: AnyAgentRequest, signal: AbortSignal): Promise<AgentResult> {
    this.requests.push(request);
    if (signal.aborted) return fakeInfrastructureResult(request, "cancel");
    if (typeof this.#result === "function") return this.#result(request);
    return this.#result;
  }

  async cancel(attemptId: string): Promise<void> {
    this.cancelledAttempts.push(attemptId);
  }
}

function fakeDomainResult(request: AnyAgentRequest): AgentResult {
  const emptyDigest = createHash("sha256").update("").digest("hex");
  return {
    attemptId: request.attemptId,
    changedFiles: [],
    logs: {
      stderrBytes: 0,
      stderrDigest: emptyDigest,
      stderrTruncated: false,
      stdoutBytes: 0,
      stdoutDigest: emptyDigest,
    },
    outcome: { data: {}, outcome: "completed", outputArtifactDigests: [], summary: "ok" },
    resources: { cpuMs: 0, maxRssBytes: 0 },
    status: "succeeded",
    tests: [],
    timing: {
      durationMs: 0,
      finishedAt: request.startedAt,
      startedAt: request.startedAt,
    },
  };
}

function fakeInfrastructureResult(
  request: AnyAgentRequest,
  category: "cancel" | "adapter",
): AgentResult {
  const result = fakeDomainResult(request);
  return {
    ...result,
    failure: { category, message: category, retriable: true },
    outcome: undefined,
    status: "failed",
  };
}

export class FakeGitPublisher implements GitPublisher {
  readonly branches = new Map<string, string>();
  readonly mutations: GitBranchMutation[] = [];
  readonly observations: Array<GitBranchMutation | GitPublication> = [];
  readonly publications: GitPublication[] = [];

  async createBranch(input: GitBranchMutation): Promise<EffectResultV3> {
    this.mutations.push(input);
    const key = `${input.repository}:${input.branch}`;
    const existing = this.branches.get(key);
    if (existing !== undefined && existing !== input.expectedRevision)
      throw new Error("git_publish_branch_conflict");
    this.branches.set(key, input.expectedRevision);
    return fakeGitResult(
      input.expectedRevision,
      existing === undefined ? "applied" : "already_applied",
    );
  }

  async deleteBranch(input: GitBranchMutation): Promise<EffectResultV3> {
    this.mutations.push(input);
    const key = `${input.repository}:${input.branch}`;
    const existing = this.branches.get(key);
    if (existing !== undefined && existing !== input.expectedRevision)
      throw new Error("git_publish_stale_head");
    this.branches.delete(key);
    return fakeGitResult(
      input.expectedRevision,
      existing === undefined ? "already_applied" : "applied",
    );
  }

  async publish(publication: GitPublication): Promise<{ readonly revision: string }> {
    this.publications.push(publication);
    return { revision: publicationRevision(publication) };
  }

  async pushVerifiedCommit(publication: GitPublication): Promise<EffectResultV3> {
    if (publication.verified !== true) throw new Error("git_publish_unverified_commit");
    this.publications.push(publication);
    const revision = publicationRevision(publication);
    this.branches.set(`${publication.repository}:${publication.branch}`, revision);
    return fakeGitResult(revision, "applied");
  }

  async observeRevision(input: GitBranchMutation | GitPublication): Promise<string | null> {
    this.observations.push(input);
    return this.branches.get(`${input.repository}:${input.branch}`) ?? null;
  }

  async probe(input: GitBranchMutation | GitPublication): Promise<EffectResultV3 | null> {
    const revision = this.branches.get(`${input.repository}:${input.branch}`);
    if ("kind" in input) {
      if (input.kind === "delete")
        return revision === undefined
          ? fakeGitResult(input.expectedRevision, "already_applied")
          : null;
      return revision === input.expectedRevision
        ? fakeGitResult(revision, "already_applied")
        : null;
    }
    const applied = this.publications.find(
      (publication) => publicationRevision(publication) === publicationRevision(input),
    );
    return applied === undefined
      ? null
      : fakeGitResult(publicationRevision(applied), "already_applied");
  }
}

function publicationRevision(publication: GitPublication): string {
  const identity = [
    publication.repository,
    publication.branch,
    publication.baseRevision,
    publication.treeDigest,
    publication.commitMessage,
  ].join("\0");
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function fakeGitResult(revision: string, outcome: "applied" | "already_applied"): EffectResultV3 {
  return {
    externalId: revision,
    externalRevision: revision,
    externalUrl: null,
    failureCategory: null,
    outcome,
  };
}
