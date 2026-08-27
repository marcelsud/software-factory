import type {
  AgentRequest,
  AgentRequestV2,
  AgentResult,
  EffectIntentV3,
  EffectResultV3,
} from "../contracts/index.ts";

export interface GitHubRepositoryRecord {
  readonly fullName: string;
  readonly id: string;
  readonly name: string;
  readonly owner: string;
}

export interface GitHubActorRecord {
  readonly login: string;
  readonly type: "bot" | "unknown" | "user";
}

export interface GitHubIssueRecord {
  readonly author: GitHubActorRecord;
  readonly body: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly isPullRequest: boolean;
  readonly labels: readonly string[];
  readonly number: number;
  readonly repository: GitHubRepositoryRecord;
  readonly state: "closed" | "open";
  readonly stateReason: string | null;
  readonly title: string;
  readonly updatedAt: string;
}

export interface GitHubIssueCommentRecord {
  readonly author: GitHubActorRecord;
  readonly body: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly issueId?: string;
  readonly issueNumber: number;
  readonly repository: GitHubRepositoryRecord;
  readonly updatedAt: string;
}

export interface GitHubRateLimitRecord {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
  readonly retryAfterMs: number | null;
}

export interface GitHubPageMetadata {
  readonly etag: string | null;
  readonly nextPage: number | null;
  readonly notModified: boolean;
  readonly rate: GitHubRateLimitRecord;
}

export interface GitHubPage<T> {
  readonly items: readonly T[];
  readonly page: GitHubPageMetadata;
}

export interface GitHubListInput {
  readonly etag?: string;
  readonly page?: number;
  readonly perPage?: number;
  readonly repositoryId: string;
  readonly signal?: AbortSignal;
  readonly since?: string;
}

export interface GitHubReadPermissionDiagnostic {
  readonly canReadIssues: boolean;
  readonly grantedPermissions: readonly string[];
  readonly message: string;
  readonly rate: GitHubRateLimitRecord;
  readonly repository: GitHubRepositoryRecord | null;
}

export interface GitHubReadTransport {
  listChangedIssues(input: GitHubListInput): Promise<GitHubPage<GitHubIssueRecord>>;
  listIssueComments(
    input: GitHubListInput & { readonly issueNumber?: number },
  ): Promise<GitHubPage<GitHubIssueCommentRecord>>;
  getIssue(
    input: Pick<GitHubListInput, "repositoryId" | "signal"> & { readonly issueNumber: number },
  ): Promise<{ readonly issue: GitHubIssueRecord; readonly rate: GitHubRateLimitRecord }>;
  getRateLimit(input?: { readonly signal?: AbortSignal }): Promise<GitHubRateLimitRecord>;
  diagnoseReadPermission(input: {
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }): Promise<GitHubReadPermissionDiagnostic>;
}

export interface GitHubWriteInput {
  readonly body?: string;
  readonly intent: EffectIntentV3;
  readonly marker: string;
}

export interface GitHubWriteTransport {
  apply(input: GitHubWriteInput): Promise<EffectResultV3>;
  inspect(input: GitHubWriteInput): Promise<{ readonly revision: string | null }>;
  probe(input: GitHubWriteInput): Promise<EffectResultV3 | null>;
}

export interface AgentRuntime {
  run(request: AgentRequest | AgentRequestV2, signal: AbortSignal): Promise<AgentResult>;
  cancel(attemptId: string): Promise<void>;
}

export interface GitPublication {
  readonly baseRevision: string;
  readonly branch: string;
  readonly commitMessage: string;
  readonly repository: string;
  readonly treeDigest: string;
  readonly verified?: boolean;
}

export interface GitBranchMutation {
  readonly branch: string;
  readonly kind: "create" | "delete";
  readonly expectedRevision: string;
  readonly marker: string;
  readonly repository: string;
}

export interface GitPublisher {
  createBranch?(input: GitBranchMutation): Promise<EffectResultV3>;
  deleteBranch?(input: GitBranchMutation): Promise<EffectResultV3>;
  probe?(input: GitBranchMutation | GitPublication): Promise<EffectResultV3 | null>;
  publish(publication: GitPublication): Promise<{ readonly revision: string }>;
  pushVerifiedCommit?(publication: GitPublication): Promise<EffectResultV3>;
}

export interface ArtifactByteDriver {
  get(digest: string): Promise<Uint8Array | null>;
  materialize(digest: string, destination: string): Promise<void>;
  put(digest: string, bytes: Uint8Array): Promise<void>;
}
