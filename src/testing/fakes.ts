import { createHash } from "node:crypto";

import type {
  AgentRuntime,
  ArtifactByteDriver,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubListInput,
  GitHubPage,
  GitHubRateLimitRecord,
  GitHubReadPermissionDiagnostic,
  GitHubReadTransport,
  GitPublication,
  GitPublisher,
} from "../adapters/seams.ts";
import type { AgentRequest, AgentResult } from "../contracts/index.ts";

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
  readonly requests: AgentRequest[] = [];
  readonly #result: AgentResult | ((request: AgentRequest) => AgentResult);

  constructor(result: AgentResult | ((request: AgentRequest) => AgentResult) = fakeDomainResult) {
    this.#result = result;
  }

  async run(request: AgentRequest, signal: AbortSignal): Promise<AgentResult> {
    this.requests.push(request);
    if (signal.aborted) return fakeInfrastructureResult(request, "cancel");
    if (typeof this.#result === "function") return this.#result(request);
    return this.#result;
  }

  async cancel(attemptId: string): Promise<void> {
    this.cancelledAttempts.push(attemptId);
  }
}

function fakeDomainResult(request: AgentRequest): AgentResult {
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
  request: AgentRequest,
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
  readonly publications: GitPublication[] = [];

  async publish(publication: GitPublication): Promise<{ readonly revision: string }> {
    this.publications.push(publication);
    const identity = [
      publication.repository,
      publication.branch,
      publication.baseRevision,
      publication.treeDigest,
      publication.commitMessage,
    ].join("\0");
    return { revision: createHash("sha256").update(identity, "utf8").digest("hex") };
  }
}

export class MemoryArtifactByteDriver implements ArtifactByteDriver {
  readonly materialized = new Map<string, Uint8Array>();
  readonly #bytes = new Map<string, Uint8Array>();

  async get(digest: string): Promise<Uint8Array | null> {
    const bytes = this.#bytes.get(digest);
    return bytes === undefined ? null : bytes.slice();
  }

  async materialize(digest: string, destination: string): Promise<void> {
    const bytes = this.#bytes.get(digest);
    if (bytes === undefined) throw new Error(`artifact_not_found: ${digest}`);
    this.materialized.set(destination, bytes.slice());
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest)
      throw new Error(`digest_mismatch: expected ${digest}, received ${actual}`);
    const existing = this.#bytes.get(digest);
    if (existing !== undefined && !existing.every((byte, index) => byte === bytes[index])) {
      throw new Error(`immutable_artifact_conflict: ${digest}`);
    }
    this.#bytes.set(digest, bytes.slice());
  }
}
