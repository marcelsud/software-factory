import { createHash } from "node:crypto";

import type { FactoryEvent } from "../contracts/index.ts";
import type {
  GitHubActorRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubRepositoryRecord,
} from "./seams.ts";

export type GitHubNormalizationInput =
  | {
      readonly current: GitHubIssueRecord;
      readonly kind: "issue";
      readonly observedAt: string;
      readonly previous: GitHubIssueRecord | null;
      readonly repositoryId: string;
    }
  | {
      readonly current: GitHubIssueCommentRecord;
      readonly kind: "comment";
      readonly observedAt: string;
      readonly previous: GitHubIssueCommentRecord | null;
      readonly repositoryId: string;
    }
  | {
      readonly kind: "actions";
      readonly observedAt: string;
      readonly payload: unknown;
      readonly repositoryId?: string;
    };

export interface GitHubEventNormalizerOptions {
  readonly botLogins?: readonly string[];
  readonly provenanceMarkers?: readonly string[];
}

const DEFAULT_BOTS = ["dependabot[bot]", "github-actions[bot]", "software-factory[bot]"];
const DEFAULT_PROVENANCE_MARKERS = ["<!-- software-factory:", "software-factory-provenance:"];

export class GitHubEventNormalizer {
  readonly #bots: ReadonlySet<string>;
  readonly #provenanceMarkers: readonly string[];

  constructor(options: GitHubEventNormalizerOptions = {}) {
    this.#bots = new Set(
      [...(options.botLogins ?? []), ...DEFAULT_BOTS].map((login) => login.toLowerCase()),
    );
    this.#provenanceMarkers = options.provenanceMarkers ?? DEFAULT_PROVENANCE_MARKERS;
  }

  normalize(input: GitHubNormalizationInput): FactoryEvent[] {
    if (input.kind === "issue") return this.#issueEvents(input);
    if (input.kind === "comment") return this.#commentEvents(input);
    return this.#actionsEvents(input);
  }

  #issueEvents(input: Extract<GitHubNormalizationInput, { kind: "issue" }>): FactoryEvent[] {
    const { current, previous } = input;
    if (current.isPullRequest || this.#ignored(current.author, current.body)) return [];
    if (previous === null) {
      return [this.#issueEvent(input.repositoryId, current, "issue.opened", input.observedAt)];
    }
    const events: FactoryEvent[] = [];
    if (current.title !== previous.title || current.body !== previous.body) {
      events.push(this.#issueEvent(input.repositoryId, current, "issue.edited", input.observedAt));
    }
    if (current.state !== previous.state) {
      events.push(
        this.#issueEvent(
          input.repositoryId,
          current,
          current.state === "closed" ? "issue.closed" : "issue.reopened",
          input.observedAt,
        ),
      );
    }
    const before = new Set(previous.labels);
    const after = new Set(current.labels);
    for (const label of [...after].filter((entry) => !before.has(entry)).sort()) {
      events.push(
        this.#issueEvent(input.repositoryId, current, "issue.label_added", input.observedAt, label),
      );
    }
    for (const label of [...before].filter((entry) => !after.has(entry)).sort()) {
      events.push(
        this.#issueEvent(
          input.repositoryId,
          current,
          "issue.label_removed",
          input.observedAt,
          label,
        ),
      );
    }
    return events;
  }

  #commentEvents(input: Extract<GitHubNormalizationInput, { kind: "comment" }>): FactoryEvent[] {
    const { current, previous } = input;
    if (this.#ignored(current.author, current.body)) return [];
    if (previous === null) {
      return [
        this.#commentEvent(input.repositoryId, current, "issue_comment.created", input.observedAt),
      ];
    }
    if (current.body !== previous.body || current.updatedAt !== previous.updatedAt) {
      return [
        this.#commentEvent(input.repositoryId, current, "issue_comment.edited", input.observedAt),
      ];
    }
    return [];
  }

  #actionsEvents(input: Extract<GitHubNormalizationInput, { kind: "actions" }>): FactoryEvent[] {
    const payload = record(input.payload);
    const repository = actionRepository(payload.repository);
    const repositoryId = input.repositoryId ?? repository.fullName;
    const action = string(payload.action);
    const issue = actionIssue(payload.issue, repository);
    if (issue === null || issue.isPullRequest) return [];
    const sender = actionActor(payload.sender);
    const actor = sender.login === "unknown" ? issue.author : sender;
    if (payload.comment !== undefined) {
      const comment = actionComment(payload.comment, issue, repository, actor);
      if (comment === null || this.#ignored(comment.author, comment.body)) return [];
      if (action === "created" || action === "edited") {
        return [
          this.#commentEvent(
            repositoryId,
            comment,
            action === "created" ? "issue_comment.created" : "issue_comment.edited",
            input.observedAt,
          ),
        ];
      }
      return [];
    }
    if (this.#ignored(actor, issue.body)) return [];
    const eventType = {
      closed: "issue.closed",
      edited: "issue.edited",
      labeled: "issue.label_added",
      opened: "issue.opened",
      reopened: "issue.reopened",
      unlabeled: "issue.label_removed",
    }[action];
    if (eventType === undefined) return [];
    const label =
      action === "labeled" || action === "unlabeled"
        ? string(record(payload.label).name)
        : undefined;
    return [
      this.#issueEvent(
        repositoryId,
        { ...issue, author: actor },
        eventType,
        input.observedAt,
        label,
      ),
    ];
  }

  #issueEvent(
    repositoryId: string,
    issue: GitHubIssueRecord,
    eventType: string,
    observedAt: string,
    label?: string,
  ): FactoryEvent {
    const occurredAt =
      eventType === "issue.opened"
        ? issue.createdAt
        : eventType === "issue.closed"
          ? (issue.closedAt ?? issue.updatedAt)
          : issue.updatedAt;
    const subject = `issue:${issue.id}`;
    const detail = label === undefined ? "" : `:label:${label}`;
    const sourceRevision = `${issue.updatedAt}:issue:${issue.id}:${eventType}${detail}`;
    return {
      actor: issue.author.login,
      correlationId: `github:${issue.repository.fullName}:${subject}`,
      deliveryId: semanticDeliveryId(issue.repository.fullName, subject, eventType, sourceRevision),
      eventType,
      observedAt: normalizedTimestamp(observedAt),
      occurredAt,
      payload: {
        trust: "untrusted",
        untrusted: {
          ...(label === undefined ? {} : { label }),
          issue,
          repository: issue.repository,
        },
      },
      repository: issue.repository.fullName,
      sourceId: `github:${repositoryId}`,
      sourceRevision,
      subject,
    };
  }

  #commentEvent(
    repositoryId: string,
    comment: GitHubIssueCommentRecord,
    eventType: string,
    observedAt: string,
  ): FactoryEvent {
    const subject = `issue:${comment.issueId ?? comment.issueNumber}`;
    const sourceRevision = `${comment.updatedAt}:comment:${comment.id}:${eventType}`;
    return {
      actor: comment.author.login,
      correlationId: `github:${comment.repository.fullName}:${subject}`,
      deliveryId: semanticDeliveryId(
        comment.repository.fullName,
        subject,
        eventType,
        sourceRevision,
      ),
      eventType,
      observedAt: normalizedTimestamp(observedAt),
      occurredAt: eventType === "issue_comment.created" ? comment.createdAt : comment.updatedAt,
      payload: {
        trust: "untrusted",
        untrusted: { comment, repository: comment.repository },
      },
      repository: comment.repository.fullName,
      sourceId: `github:${repositoryId}`,
      sourceRevision,
      subject,
    };
  }

  #ignored(actor: GitHubActorRecord, body: string | null): boolean {
    if (actor.type === "bot" || this.#bots.has(actor.login.toLowerCase())) return true;
    return body !== null && this.#provenanceMarkers.some((marker) => body.includes(marker));
  }
}

function semanticDeliveryId(
  repository: string,
  subject: string,
  eventType: string,
  sourceRevision: string,
): string {
  const digest = createHash("sha256")
    .update([repository, subject, eventType, sourceRevision].join("\0"))
    .digest("hex");
  return `github:${digest}`;
}

function actionRepository(value: unknown): GitHubRepositoryRecord {
  const repository = record(value);
  const fullName = string(repository.full_name) || "unknown/unknown";
  const [owner = "unknown", name = "unknown"] = fullName.split("/");
  return {
    fullName,
    id: identity(repository.id) ?? fullName,
    name: string(repository.name) || name,
    owner: string(record(repository.owner).login) || owner,
  };
}

function actionIssue(value: unknown, repository: GitHubRepositoryRecord): GitHubIssueRecord | null {
  const issue = record(value);
  const id = identity(issue.id) ?? identity(issue.node_id);
  const number = integer(issue.number);
  if (id === null || number === null) return null;
  const createdAt = normalizedTimestamp(issue.created_at);
  return {
    author: actionActor(issue.user),
    body: nullableString(issue.body),
    closedAt: optionalTimestamp(issue.closed_at),
    createdAt,
    id,
    isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
    labels: array(issue.labels)
      .map((label) => (typeof label === "string" ? label : string(record(label).name)))
      .filter(Boolean)
      .sort(),
    number,
    repository,
    state: issue.state === "closed" ? "closed" : "open",
    stateReason: nullableString(issue.state_reason),
    title: string(issue.title),
    updatedAt: normalizedTimestamp(issue.updated_at, createdAt),
  };
}

function actionComment(
  value: unknown,
  issue: GitHubIssueRecord,
  repository: GitHubRepositoryRecord,
  fallbackActor: GitHubActorRecord,
): GitHubIssueCommentRecord | null {
  const comment = record(value);
  const id = identity(comment.id) ?? identity(comment.node_id);
  if (id === null) return null;
  const createdAt = normalizedTimestamp(comment.created_at);
  const author = actionActor(comment.user);
  return {
    author: author.login === "unknown" ? fallbackActor : author,
    body: nullableString(comment.body),
    createdAt,
    id,
    issueId: issue.id,
    issueNumber: issue.number,
    repository,
    updatedAt: normalizedTimestamp(comment.updated_at, createdAt),
  };
}

function actionActor(value: unknown): GitHubActorRecord {
  const actor = record(value);
  const login = string(actor.login) || "unknown";
  const rawType = string(actor.type).toLowerCase();
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

function normalizedTimestamp(value: unknown, fallback = "1970-01-01T00:00:00.000Z"): string {
  const candidate = typeof value === "string" ? value : fallback;
  return Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : fallback;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function identity(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
