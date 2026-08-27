import type { EffectFailureCategoryV3, EffectResultV3 } from "../contracts/index.ts";
import type { GitHubTokenProvider, InfrastructureFetch } from "./github-read-transport.ts";
import type { GitHubWriteInput, GitHubWriteTransport } from "./seams.ts";

export class GitHubWriteError extends Error {
  readonly category: EffectFailureCategoryV3;
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(
    message: string,
    category: EffectFailureCategoryV3,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GitHubWriteError";
    this.category = category;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchGitHubWriteTransportOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: InfrastructureFetch;
  readonly maxAttempts?: number;
  readonly repositories?: Readonly<Record<string, string>>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly tokenProvider: GitHubTokenProvider;
}

export class FetchGitHubWriteTransport implements GitHubWriteTransport {
  readonly #apiBaseUrl: string;
  readonly #fetch: InfrastructureFetch;
  readonly #maxAttempts: number;
  readonly #repositories: Readonly<Record<string, string>>;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #tokenProvider: GitHubTokenProvider;

  constructor(options: FetchGitHubWriteTransportOptions) {
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#repositories = options.repositories ?? {};
    this.#sleep =
      options.sleep ??
      ((milliseconds) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, milliseconds);
        return promise;
      });
    this.#tokenProvider = options.tokenProvider;
  }

  async inspect(input: GitHubWriteInput): Promise<{ readonly revision: string | null }> {
    const operation = input.intent.operation;
    if (operation.kind === "update-comment") {
      const response = await this.#request(
        "GET",
        this.#path(input, `/issues/comments/${encodeURIComponent(operation.payload.commentId)}`),
      );
      return { revision: text(response.updated_at) || null };
    }
    if (operation.kind === "update-pull-request") {
      const response = await this.#request(
        "GET",
        this.#path(input, `/pulls/${operation.payload.pullRequestNumber}`),
      );
      return { revision: text(response.updated_at) || text(record(response.head).sha) || null };
    }
    const issueNumber = "issueNumber" in operation.payload ? operation.payload.issueNumber : null;
    if (issueNumber !== null) {
      const response = await this.#request("GET", this.#path(input, `/issues/${issueNumber}`));
      return { revision: text(response.updated_at) || null };
    }
    return { revision: null };
  }

  async apply(input: GitHubWriteInput): Promise<EffectResultV3> {
    const operation = input.intent.operation;
    let response: DataRecord;
    if (operation.kind === "add-label") {
      response = await this.#request(
        "POST",
        this.#path(input, `/issues/${operation.payload.issueNumber}/labels`),
        { labels: [operation.payload.label] },
      );
    } else if (operation.kind === "remove-label") {
      response = await this.#request(
        "DELETE",
        this.#path(
          input,
          `/issues/${operation.payload.issueNumber}/labels/${encodeURIComponent(operation.payload.label)}`,
        ),
      );
    } else if (operation.kind === "create-comment") {
      response = await this.#request(
        "POST",
        this.#path(input, `/issues/${operation.payload.issueNumber}/comments`),
        { body: requiredBody(input) },
      );
    } else if (operation.kind === "update-comment") {
      response = await this.#request(
        "PATCH",
        this.#path(input, `/issues/comments/${encodeURIComponent(operation.payload.commentId)}`),
        { body: requiredBody(input) },
      );
    } else if (operation.kind === "create-pull-request") {
      response = await this.#request("POST", this.#path(input, "/pulls"), {
        base: operation.payload.base,
        body: requiredBody(input),
        head: operation.payload.head,
        title: operation.payload.title,
      });
    } else if (operation.kind === "update-pull-request") {
      response = await this.#request(
        "PATCH",
        this.#path(input, `/pulls/${operation.payload.pullRequestNumber}`),
        {
          body: requiredBody(input),
          ...(operation.payload.title === undefined ? {} : { title: operation.payload.title }),
        },
      );
    } else {
      throw new GitHubWriteError(`GitHub transport cannot apply ${operation.kind}`, "validation");
    }
    return resultFromResponse(response, "applied");
  }

  async probe(input: GitHubWriteInput): Promise<EffectResultV3 | null> {
    const operation = input.intent.operation;
    if (operation.kind === "add-label" || operation.kind === "remove-label") {
      const issue = await this.#request(
        "GET",
        this.#path(input, `/issues/${operation.payload.issueNumber}`),
      );
      const labels = array(issue.labels).map((value) =>
        typeof value === "string" ? value : text(record(value).name),
      );
      const present = labels.includes(operation.payload.label);
      if (
        (operation.kind === "add-label" && present) ||
        (operation.kind === "remove-label" && !present)
      )
        return resultFromResponse(issue, "already_applied");
      return null;
    }
    if (operation.kind === "create-comment") {
      const comments = await this.#request(
        "GET",
        this.#path(input, `/issues/${operation.payload.issueNumber}/comments?per_page=100`),
      );
      const match = array(comments)
        .map(record)
        .find((comment) => text(comment.body).includes(input.marker));
      return match === undefined ? null : resultFromResponse(match, "already_applied");
    }
    if (operation.kind === "update-comment") {
      const comment = await this.#request(
        "GET",
        this.#path(input, `/issues/comments/${encodeURIComponent(operation.payload.commentId)}`),
      );
      return text(comment.body).includes(input.marker)
        ? resultFromResponse(comment, "already_applied")
        : null;
    }
    if (operation.kind === "create-pull-request") {
      const pulls = await this.#request(
        "GET",
        this.#path(input, `/pulls?state=all&head=${encodeURIComponent(operation.payload.head)}`),
      );
      const match = array(pulls)
        .map(record)
        .find((pull) => text(pull.body).includes(input.marker));
      return match === undefined ? null : resultFromResponse(match, "already_applied");
    }
    if (operation.kind === "update-pull-request") {
      const pull = await this.#request(
        "GET",
        this.#path(input, `/pulls/${operation.payload.pullRequestNumber}`),
      );
      return text(pull.body).includes(input.marker)
        ? resultFromResponse(pull, "already_applied")
        : null;
    }
    return null;
  }

  #path(input: GitHubWriteInput, suffix: string): string {
    const configured =
      this.#repositories[input.intent.target.repository] ?? input.intent.target.repository;
    const parts = configured.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "")
      throw new GitHubWriteError("Unknown GitHub repository", "validation");
    return `/repos/${encodeURIComponent(parts[0] ?? "")}/${encodeURIComponent(parts[1] ?? "")}${suffix}`;
  }

  async #request(method: string, path: string, body?: unknown): Promise<DataRecord> {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const token = await this.#tokenProvider.getToken();
      let response: Response;
      try {
        response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            "user-agent": "software-factory",
            "x-github-api-version": "2022-11-28",
          },
          method,
        });
      } catch (error) {
        throw new GitHubWriteError(
          `GitHub write network outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
          "ambiguous_network",
        );
      }
      const retryAfterMs = retryDelay(response.headers);
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      if (rateLimited && attempt < this.#maxAttempts) {
        await this.#sleep(retryAfterMs ?? 1_000);
        continue;
      }
      if (!response.ok) {
        const category: EffectFailureCategoryV3 = rateLimited
          ? "rate_limit"
          : response.status === 401 || response.status === 403
            ? "permission"
            : response.status === 409 || response.status === 412 || response.status === 422
              ? "conflict"
              : response.status >= 500 && method !== "GET"
                ? "ambiguous_network"
                : "provider";
        throw new GitHubWriteError(
          `GitHub write failed (${response.status})`,
          category,
          response.status,
          retryAfterMs,
        );
      }
      if (response.status === 204) return {};
      const value: unknown = await response.json();
      return Array.isArray(value) ? { items: value } : record(value);
    }
    throw new GitHubWriteError("GitHub rate limit retry exhausted", "rate_limit");
  }
}

type DataRecord = Record<string, unknown>;

function requiredBody(input: GitHubWriteInput): string {
  if (input.body === undefined || !input.body.includes(input.marker))
    throw new GitHubWriteError("Rendered body is missing the factory marker", "validation");
  return input.body;
}

function resultFromResponse(
  response: DataRecord,
  outcome: "applied" | "already_applied",
): EffectResultV3 {
  const externalRevision =
    text(response.updated_at) || text(response.sha) || text(record(response.head).sha) || null;
  const rawId = response.node_id ?? response.id ?? response.number;
  return {
    externalId: typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : null,
    externalRevision,
    externalUrl: text(response.html_url) || null,
    failureCategory: null,
    outcome,
  };
}

function retryDelay(headers: Headers): number | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) ? Math.max(0, reset * 1_000 - Date.now()) : null;
}

function record(value: unknown): DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as DataRecord)
    : {};
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(record(value).items) ? (record(value).items as unknown[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
