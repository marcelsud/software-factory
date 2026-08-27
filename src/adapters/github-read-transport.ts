import { createSign } from "node:crypto";

import type {
  GitHubActorRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubListInput,
  GitHubPage,
  GitHubRateLimitRecord,
  GitHubReadPermissionDiagnostic,
  GitHubReadTransport,
  GitHubRepositoryRecord,
} from "./seams.ts";

export type InfrastructureFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}

export class GitHubReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rate: GitHubRateLimitRecord,
  ) {
    super(message);
    this.name = "GitHubReadError";
  }
}

export class PersonalAccessTokenProvider implements GitHubTokenProvider {
  constructor(private readonly token: string) {
    if (token.trim() === "") throw new Error("GitHub token must not be empty");
  }

  async getToken(): Promise<string> {
    return this.token;
  }
}

export interface GitHubAppTokenProviderOptions {
  readonly apiBaseUrl?: string;
  readonly appId: string;
  readonly clock?: () => Date;
  readonly fetch?: InfrastructureFetch;
  readonly installationId: string;
  readonly privateKey: string;
}

export class GitHubAppInstallationTokenProvider implements GitHubTokenProvider {
  readonly #apiBaseUrl: string;
  readonly #appId: string;
  readonly #clock: () => Date;
  readonly #fetch: InfrastructureFetch;
  readonly #installationId: string;
  readonly #privateKey: string;
  #cached: { expiresAt: number; token: string } | null = null;

  constructor(options: GitHubAppTokenProviderOptions) {
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#appId = options.appId;
    this.#clock = options.clock ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#installationId = options.installationId;
    this.#privateKey = options.privateKey.replaceAll("\\n", "\n");
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    const now = this.#clock().getTime();
    if (this.#cached !== null && this.#cached.expiresAt - 60_000 > now) return this.#cached.token;
    const jwt = this.#signedJwt(now);
    // GitHub exposes installation-token creation as POST. This endpoint grants no repository
    // mutation and is the only non-GET request anywhere in the read infrastructure.
    const response = await this.#fetch(
      `${this.#apiBaseUrl}/app/installations/${encodeURIComponent(this.#installationId)}/access_tokens`,
      {
        body: JSON.stringify({ permissions: { issues: "read", metadata: "read" } }),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "user-agent": "software-factory",
          "x-github-api-version": "2022-11-28",
        },
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) {
      throw new GitHubReadError(
        `GitHub App authentication failed (${response.status})`,
        response.status,
        rateFromHeaders(response.headers, now),
      );
    }
    const body = asRecord(await response.json());
    const token = text(body.token);
    const expiresAt = Date.parse(text(body.expires_at));
    if (token === "" || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub App authentication returned an invalid token response");
    }
    this.#cached = { expiresAt, token };
    return token;
  }

  #signedJwt(nowMs: number): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const issuedAt = Math.floor(nowMs / 1000) - 30;
    const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      exp: issuedAt + 9 * 60,
      iat: issuedAt,
      iss: this.#appId,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.#privateKey, "base64url");
    return `${signingInput}.${signature}`;
  }
}

export interface FetchGitHubReadTransportOptions {
  readonly apiBaseUrl?: string;
  readonly clock?: () => Date;
  readonly fetch?: InfrastructureFetch;
  readonly repositories?: Readonly<Record<string, string>>;
  readonly tokenProvider: GitHubTokenProvider;
}

export class FetchGitHubReadTransport implements GitHubReadTransport {
  readonly #apiBaseUrl: string;
  readonly #clock: () => Date;
  readonly #fetch: InfrastructureFetch;
  readonly #repositories: Readonly<Record<string, string>>;
  readonly #tokenProvider: GitHubTokenProvider;

  constructor(options: FetchGitHubReadTransportOptions) {
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#clock = options.clock ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#repositories = options.repositories ?? {};
    this.#tokenProvider = options.tokenProvider;
  }

  async listChangedIssues(input: GitHubListInput): Promise<GitHubPage<GitHubIssueRecord>> {
    const repository = this.#repository(input.repositoryId);
    const response = await this.#get(
      `/repos/${repository.owner}/${repository.name}/issues`,
      {
        direction: "asc",
        page: String(input.page ?? 1),
        per_page: String(input.perPage ?? 100),
        since: input.since,
        sort: "updated",
        state: "all",
      },
      input.etag,
      input.signal,
    );
    return {
      items: response.notModified
        ? []
        : array(response.body).map((entry) => issueRecord(entry, repository)),
      page: response,
    };
  }

  async listIssueComments(
    input: GitHubListInput & { readonly issueNumber?: number },
  ): Promise<GitHubPage<GitHubIssueCommentRecord>> {
    const repository = this.#repository(input.repositoryId);
    const suffix =
      input.issueNumber === undefined
        ? "/issues/comments"
        : `/issues/${input.issueNumber}/comments`;
    const response = await this.#get(
      `/repos/${repository.owner}/${repository.name}${suffix}`,
      {
        direction: "asc",
        page: String(input.page ?? 1),
        per_page: String(input.perPage ?? 100),
        since: input.since,
        sort: "updated",
      },
      input.etag,
      input.signal,
    );
    return {
      items: response.notModified
        ? []
        : array(response.body).map((entry) => commentRecord(entry, repository, input.issueNumber)),
      page: response,
    };
  }

  async getIssue(input: {
    readonly issueNumber: number;
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly issue: GitHubIssueRecord; readonly rate: GitHubRateLimitRecord }> {
    const repository = this.#repository(input.repositoryId);
    const response = await this.#get(
      `/repos/${repository.owner}/${repository.name}/issues/${input.issueNumber}`,
      {},
      undefined,
      input.signal,
    );
    return { issue: issueRecord(response.body, repository), rate: response.rate };
  }

  async getRateLimit(
    input: { readonly signal?: AbortSignal } = {},
  ): Promise<GitHubRateLimitRecord> {
    const response = await this.#get("/rate_limit", {}, undefined, input.signal);
    const body = asRecord(response.body);
    const resources = asRecord(body.resources);
    const core = asRecord(resources.core);
    return {
      limit: integer(core.limit) ?? response.rate.limit,
      remaining: integer(core.remaining) ?? response.rate.remaining,
      resetAt: epochTimestamp(core.reset) ?? response.rate.resetAt,
      retryAfterMs: response.rate.retryAfterMs,
    };
  }

  async diagnoseReadPermission(input: {
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }): Promise<GitHubReadPermissionDiagnostic> {
    const repository = this.#repository(input.repositoryId);
    let response: ReadResponse;
    try {
      response = await this.#get(
        `/repos/${repository.owner}/${repository.name}/issues`,
        { per_page: "1", state: "all" },
        undefined,
        input.signal,
      );
    } catch (error) {
      if (!(error instanceof GitHubReadError) || ![401, 403, 404, 410].includes(error.status)) {
        throw error;
      }
      return {
        canReadIssues: false,
        grantedPermissions: [],
        message: `repository issues are not readable (${error.status})`,
        rate: error.rate,
        repository: null,
      };
    }
    const granted = new Set(
      (response.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    const accepted = response.headers.get("x-accepted-github-permissions");
    if (accepted !== null) {
      for (const entry of accepted.split(/[;,]/)) {
        if (entry.trim() !== "") granted.add(entry.trim());
      }
    }
    return {
      canReadIssues: true,
      grantedPermissions: [...granted].sort(),
      message: "repository issues are readable",
      rate: response.rate,
      repository,
    };
  }

  #repository(repositoryId: string): GitHubRepositoryRecord {
    const fullName = this.#repositories[repositoryId] ?? repositoryId;
    const [owner, name, extra] = fullName.split("/");
    if (
      owner === undefined ||
      name === undefined ||
      extra !== undefined ||
      owner === "" ||
      name === ""
    ) {
      throw new Error(`Unknown GitHub repository: ${repositoryId}`);
    }
    return { fullName: `${owner}/${name}`, id: repositoryId, name, owner };
  }

  async #get(
    path: string,
    query: Readonly<Record<string, string | undefined>>,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReadResponse> {
    const url = new URL(`${this.#apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value);
    const token = await this.#tokenProvider.getToken(signal);
    const response = await this.#fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(etag === undefined ? {} : { "if-none-match": etag }),
        "user-agent": "software-factory",
        "x-github-api-version": "2022-11-28",
      },
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    const rate = rateFromHeaders(response.headers, this.#clock().getTime());
    if (response.status === 304) {
      return {
        body: null,
        etag: response.headers.get("etag") ?? etag ?? null,
        headers: response.headers,
        nextPage: null,
        notModified: true,
        rate,
      };
    }
    if (!response.ok) {
      throw new GitHubReadError(`GitHub read failed (${response.status})`, response.status, rate);
    }
    return {
      body: response.status === 204 ? null : await response.json(),
      etag: response.headers.get("etag"),
      headers: response.headers,
      nextPage: nextPage(response.headers.get("link")),
      notModified: false,
      rate,
    };
  }
}

interface ReadResponse {
  readonly body: unknown;
  readonly etag: string | null;
  readonly headers: Headers;
  readonly nextPage: number | null;
  readonly notModified: boolean;
  readonly rate: GitHubRateLimitRecord;
}

function issueRecord(
  value: unknown,
  fallbackRepository: GitHubRepositoryRecord,
): GitHubIssueRecord {
  const record = asRecord(value);
  return {
    author: actorRecord(record.user),
    body: nullableText(record.body),
    closedAt: nullableTimestamp(record.closed_at),
    createdAt: timestamp(record.created_at),
    id: identity(record.id, record.node_id),
    isPullRequest: record.pull_request !== undefined && record.pull_request !== null,
    labels: array(record.labels)
      .map((label) => (typeof label === "string" ? label : text(asRecord(label).name)))
      .filter(Boolean)
      .sort(),
    number: requiredInteger(record.number, "issue number"),
    repository: repositoryRecord(record.repository, fallbackRepository),
    state: record.state === "closed" ? "closed" : "open",
    stateReason: nullableText(record.state_reason),
    title: text(record.title),
    updatedAt: timestamp(record.updated_at, record.created_at),
  };
}

function commentRecord(
  value: unknown,
  repository: GitHubRepositoryRecord,
  fallbackIssueNumber?: number,
): GitHubIssueCommentRecord {
  const record = asRecord(value);
  const issueNumber =
    integer(record.issue_number) ?? issueNumberFromUrl(record.issue_url) ?? fallbackIssueNumber;
  if (issueNumber === undefined) throw new Error("GitHub comment is missing its issue number");
  const issueId = nullableIdentity(record.issue_id);
  return {
    author: actorRecord(record.user),
    body: nullableText(record.body),
    createdAt: timestamp(record.created_at),
    id: identity(record.id, record.node_id),
    ...(issueId === null ? {} : { issueId }),
    issueNumber,
    repository,
    updatedAt: timestamp(record.updated_at, record.created_at),
  };
}

function repositoryRecord(
  value: unknown,
  fallback: GitHubRepositoryRecord,
): GitHubRepositoryRecord {
  const record = asRecord(value);
  const fullName = text(record.full_name) || fallback.fullName;
  const [ownerFromName = fallback.owner, nameFromName = fallback.name] = fullName.split("/");
  const owner = text(asRecord(record.owner).login) || ownerFromName;
  const name = text(record.name) || nameFromName;
  return {
    fullName: `${owner}/${name}`,
    id: fallback.id,
    name,
    owner,
  };
}

function actorRecord(value: unknown): GitHubActorRecord {
  const record = asRecord(value);
  const login = text(record.login) || "unknown";
  const rawType = text(record.type).toLowerCase();
  return {
    login,
    type:
      rawType === "bot" || login.toLowerCase().endsWith("[bot]")
        ? "bot"
        : rawType === "user"
          ? "user"
          : "unknown",
  };
}

function rateFromHeaders(headers: Headers, nowMs: number): GitHubRateLimitRecord {
  return {
    limit: integer(headers.get("x-ratelimit-limit")),
    remaining: integer(headers.get("x-ratelimit-remaining")),
    resetAt: epochTimestamp(headers.get("x-ratelimit-reset")),
    retryAfterMs: retryAfter(headers.get("retry-after"), nowMs),
  };
}

function retryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? Math.max(0, timestampMs - nowMs) : null;
}

function nextPage(link: string | null): number | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (match?.[1] === undefined) return null;
    const page = Number(new URL(match[1]).searchParams.get("page"));
    return Number.isInteger(page) && page > 0 ? page : null;
  }
  return null;
}

function issueNumberFromUrl(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\/issues\/(\d+)$/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) ? number : null;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = integer(value);
  if (parsed === null) throw new Error(`GitHub response is missing ${field}`);
  return parsed;
}

function identity(...values: unknown[]): string {
  const value = values.find((entry) => typeof entry === "string" || typeof entry === "number");
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("GitHub response is missing resource identity");
}

function nullableIdentity(value: unknown): string | null {
  try {
    return identity(value);
  } catch {
    return null;
  }
}

function timestamp(value: unknown, fallback?: unknown): string {
  const candidate = text(value) || text(fallback);
  return Number.isFinite(Date.parse(candidate))
    ? new Date(candidate).toISOString()
    : "1970-01-01T00:00:00.000Z";
}

function nullableTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function epochTimestamp(value: unknown): string | null {
  const epoch = integer(value);
  return epoch === null ? null : new Date(epoch * 1000).toISOString();
}
