import { createHash } from "node:crypto";
import {
  type ChimpbaseModuleContext,
  type ChimpbaseModuleInterface,
  defineChimpbaseModuleImplementation,
} from "chimpbase/core";
import { onStop, worker } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import { GitHubEventNormalizer } from "../../adapters/github-event-normalizer.ts";
import { GitHubReadError } from "../../adapters/github-read-transport.ts";
import type {
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPage,
  GitHubRateLimitRecord,
  GitHubReadTransport,
} from "../../adapters/seams.ts";
import {
  type AcceptedFactoryEvent,
  type FactoryEvent,
  factoryEvent,
} from "../../contracts/index.ts";
import { type IntakeDatabase, intakeMigrations } from "../../storage/intake-database.ts";
import { intake } from "./interface.ts";

const implementationInterface = intake as unknown as ChimpbaseModuleInterface<
  typeof intake.calls,
  typeof intake.events
>;

export interface IntakeImplementationDependencies {
  readonly clock?: () => Date;
  readonly normalizer?: GitHubEventNormalizer;
  readonly overlapMs?: number;
  readonly random?: () => number;
  readonly readTransport: GitHubReadTransport;
  readonly repositoryEvents?: Readonly<Record<string, readonly string[]>>;
  readonly retry?: {
    readonly baseDelayMs?: number;
    readonly maxAttempts?: number;
    readonly maxDelayMs?: number;
  };
  readonly signal?: AbortSignal;
  readonly sourceRepositories?: Readonly<Record<string, string>>;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface ResolvedDependencies {
  readonly clock: () => Date;
  readonly normalizer: GitHubEventNormalizer;
  readonly overlapMs: number;
  readonly random: () => number;
  readonly readTransport: GitHubReadTransport;
  readonly repositoryEvents: Readonly<Record<string, readonly string[]>>;
  readonly retry: {
    readonly baseDelayMs: number;
    readonly maxAttempts: number;
    readonly maxDelayMs: number;
  };
  readonly signal: AbortSignal;
  readonly sourceRepositories: Readonly<Record<string, string>>;
  readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface CursorAdvance {
  readonly expectedCursor: string | null;
  readonly nextCursor: string;
}

interface SourcePosition {
  readonly id: string;
  readonly kind: "comment" | "issue";
  readonly updatedAt: string;
}

interface PageCollection<T> {
  readonly etag: string | null;
  readonly items: readonly T[];
  readonly rate: GitHubRateLimitRecord;
}

interface PollResource {
  readonly current: GitHubIssueCommentRecord | GitHubIssueRecord;
  readonly kind: "comment" | "issue";
  readonly position: SourcePosition;
}

class DeferredPollError extends Error {
  constructor(
    readonly delayMs: number,
    override readonly cause: unknown,
  ) {
    super("transport_failure: GitHub poll deferred to a Chimpbase worker");
    this.name = "DeferredPollError";
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("invalid_source_event: cyclic payload");
    ancestors.add(value);
    const result = `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new Error("invalid_source_event: cyclic payload");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const result = `{${Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) throw new Error("invalid_source_event: undefined payload value");
        return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`;
      })
      .join(",")}}`;
    ancestors.delete(value);
    return result;
  }
  throw new Error(`invalid_source_event: unsupported payload value ${typeof value}`);
}
async function advanceSourceCursor(
  db: Kysely<IntakeDatabase>,
  event: FactoryEvent,
  cursorAdvance?: CursorAdvance,
  allowAlreadyAdvanced = false,
): Promise<void> {
  const cursor = await db
    .selectFrom("source_cursors")
    .selectAll()
    .where("source_id", "=", event.sourceId)
    .executeTakeFirst();
  if (cursorAdvance !== undefined) {
    const committedCursor = cursor?.cursor ?? null;
    if (allowAlreadyAdvanced && committedCursor === cursorAdvance.nextCursor) return;
    if (committedCursor !== cursorAdvance.expectedCursor) {
      throw new Error("cursor_conflict: committed source cursor does not match expected cursor");
    }
    if (cursor === undefined) {
      const inserted = await db
        .insertInto("source_cursors")
        .values({
          cursor: cursorAdvance.nextCursor,
          source_id: event.sourceId,
          updated_at: event.observedAt,
        })
        .onConflict((conflict) => conflict.column("source_id").doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows !== 1n) {
        throw new Error("cursor_conflict: source cursor changed during acceptance");
      }
      return;
    }
    const updated = await db
      .updateTable("source_cursors")
      .set({ cursor: cursorAdvance.nextCursor, updated_at: event.observedAt })
      .where("source_id", "=", event.sourceId)
      .where("cursor", "=", cursorAdvance.expectedCursor ?? "")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new Error("cursor_conflict: source cursor changed during acceptance");
    }
    return;
  }
  if (cursor === undefined) {
    await db
      .insertInto("source_cursors")
      .values({
        cursor: event.sourceRevision,
        source_id: event.sourceId,
        updated_at: event.observedAt,
      })
      .execute();
    return;
  }
  throw new Error(
    "invalid_source_event: source cursor already exists; use acceptSourceEventV2 with expectedCursor and nextCursor",
  );
}

async function acceptDurably(
  ctx: ChimpbaseModuleContext<IntakeDatabase>,
  input: FactoryEvent,
  cursorAdvance?: CursorAdvance,
): Promise<AcceptedFactoryEvent> {
  const event = factoryEvent.parse(input);
  const payloadJson = canonicalJson(event.payload);
  const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
  const db: Kysely<IntakeDatabase> = ctx.db.kysely();
  const existing = await db
    .selectFrom("delivery_deduplication")
    .select("payload_digest")
    .where("source_id", "=", event.sourceId)
    .where("delivery_id", "=", event.deliveryId)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.payload_digest !== payloadDigest) {
      throw new Error("delivery_conflict: source delivery identity has a different payload digest");
    }
    if (cursorAdvance !== undefined) {
      await advanceSourceCursor(db, event, cursorAdvance, true);
    }
    const accepted = await db
      .selectFrom("factory_events")
      .select("event_json")
      .where("source_id", "=", event.sourceId)
      .where("delivery_id", "=", event.deliveryId)
      .executeTakeFirstOrThrow();
    return {
      event: factoryEvent.parse(JSON.parse(accepted.event_json)),
      idempotent: true,
      payloadDigest,
    };
  }

  await db
    .insertInto("event_sources")
    .values({ created_at: event.observedAt, source_id: event.sourceId })
    .onConflict((conflict) => conflict.column("source_id").doNothing())
    .execute();
  await db
    .insertInto("delivery_deduplication")
    .values({
      accepted_at: event.observedAt,
      delivery_id: event.deliveryId,
      payload_digest: payloadDigest,
      source_id: event.sourceId,
    })
    .execute();
  await db
    .insertInto("factory_events")
    .values({
      delivery_id: event.deliveryId,
      event_json: canonicalJson(event),
      event_type: event.eventType,
      observed_at: event.observedAt,
      payload_digest: payloadDigest,
      repository: event.repository,
      source_id: event.sourceId,
      source_revision: event.sourceRevision,
      subject: event.subject,
    })
    .execute();
  await db
    .insertInto("source_payload_snapshots")
    .values({
      delivery_id: event.deliveryId,
      observed_at: event.observedAt,
      payload_digest: payloadDigest,
      payload_json: payloadJson,
      source_id: event.sourceId,
    })
    .execute();
  await advanceSourceCursor(db, event, cursorAdvance);
  const accepted = { event, idempotent: false, payloadDigest };
  ctx.publish(intake.events.factoryEventAcceptedV1, event);
  ctx.publish(intake.events.factoryEventAcceptedV2, accepted);
  return accepted;
}

export function createIntakeImplementation(input: IntakeImplementationDependencies) {
  const shutdown = new AbortController();
  const externalSignal = input.signal;
  const signal =
    externalSignal === undefined
      ? shutdown.signal
      : AbortSignal.any([externalSignal, shutdown.signal]);
  const dependencies: ResolvedDependencies = {
    clock: input.clock ?? (() => new Date()),
    normalizer: input.normalizer ?? new GitHubEventNormalizer(),
    overlapMs: input.overlapMs ?? 60_000,
    random: input.random ?? Math.random,
    readTransport: input.readTransport,
    repositoryEvents: input.repositoryEvents ?? {},
    retry: {
      baseDelayMs: input.retry?.baseDelayMs ?? 250,
      maxAttempts: input.retry?.maxAttempts ?? 3,
      maxDelayMs: input.retry?.maxDelayMs ?? 30_000,
    },
    signal,
    sourceRepositories: input.sourceRepositories ?? {},
    sleep: input.sleep ?? abortableSleep,
  };

  const retryWorker = worker(
    "github-poll-retries",
    async (ctx, payload: { readonly observedAt: string; readonly repositoryId: string }) => {
      await pollRepository(
        ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>,
        payload,
        dependencies,
        false,
      );
    },
    { dlq: "github-poll-retries.dlq" },
  );

  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: intakeMigrations,
    registrations: [
      retryWorker,
      onStop("intake.abort-polling", () => {
        shutdown.abort();
      }),
    ],
    resources: {
      collections: [
        "delivery-deduplication",
        "event-sources",
        "factory-events",
        "github-comment-snapshots",
        "github-issue-snapshots",
        "github-poll-state",
        "source-cursors",
        "source-payload-snapshots",
      ],
      queues: ["github-poll-retries"],
      tables: [
        "delivery_deduplication",
        "event_sources",
        "factory_events",
        "github_comment_snapshots",
        "github_issue_snapshots",
        "github_poll_state",
        "source_cursors",
        "source_payload_snapshots",
      ],
    },
    calls: {
      async acceptSourceEvent(ctx, event) {
        try {
          return (
            await acceptDurably(ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>, event)
          ).event;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("delivery_conflict:")) {
            throw new Error(error.message.replace("delivery_conflict:", "duplicate_delivery:"));
          }
          throw error;
        }
      },
      async acceptSourceEventV2(ctx, value) {
        return await acceptDurably(
          ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>,
          value.event,
          { expectedCursor: value.expectedCursor, nextCursor: value.nextCursor },
        );
      },
      async getSourceCursor(ctx, value) {
        const db = ctx.db.kysely() as unknown as Kysely<IntakeDatabase>;
        const row = await db
          .selectFrom("source_cursors")
          .selectAll()
          .where("source_id", "=", value.sourceId)
          .executeTakeFirst();
        return row === undefined
          ? null
          : { cursor: row.cursor, sourceId: row.source_id, updatedAt: row.updated_at };
      },
      async pollRepository(ctx, value) {
        const unprefixed = value.sourceId.startsWith("github:")
          ? value.sourceId.slice("github:".length)
          : value.sourceId;
        const repositoryId =
          dependencies.sourceRepositories[value.sourceId] ??
          dependencies.sourceRepositories[unprefixed] ??
          unprefixed;
        if (repositoryId === "") throw new Error("source_not_found: sourceId has no repository");
        return await pollRepository(
          ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>,
          { observedAt: value.observedAt, repositoryId },
          dependencies,
        );
      },
      async pollRepositoryV2(ctx, value) {
        return await pollRepository(
          ctx as unknown as ChimpbaseModuleContext<IntakeDatabase>,
          value,
          dependencies,
        );
      },
    },
  });
}

async function pollRepository(
  ctx: ChimpbaseModuleContext<IntakeDatabase>,
  input: { readonly observedAt: string; readonly repositoryId: string },
  dependencies: ResolvedDependencies,
  scheduleDeferred = true,
) {
  if (dependencies.signal.aborted) {
    throw dependencies.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const db = ctx.db.kysely();
  const state = await db
    .selectFrom("github_poll_state")
    .selectAll()
    .where("repository_id", "=", input.repositoryId)
    .executeTakeFirst();
  const previousPosition = decodePosition(state?.source_position ?? null);
  const since =
    previousPosition === null
      ? undefined
      : new Date(
          Math.max(0, Date.parse(previousPosition.updatedAt) - dependencies.overlapMs),
        ).toISOString();

  let issues: PageCollection<GitHubIssueRecord>;
  let comments: PageCollection<GitHubIssueCommentRecord>;
  try {
    if (state === undefined) {
      const diagnostic = await withRetry(
        () =>
          dependencies.readTransport.diagnoseReadPermission({
            repositoryId: input.repositoryId,
            signal: dependencies.signal,
          }),
        dependencies,
      );
      if (!diagnostic.canReadIssues) {
        throw new Error(`source_not_found: ${diagnostic.message}`);
      }
    }
    issues = await collectPages(
      (page, etag) =>
        dependencies.readTransport.listChangedIssues({
          ...(etag === null ? {} : { etag }),
          ...(since === undefined ? {} : { since }),
          page,
          repositoryId: input.repositoryId,
          signal: dependencies.signal,
        }),
      null,
      dependencies,
    );
    comments = await collectPages(
      (page, etag) =>
        dependencies.readTransport.listIssueComments({
          ...(etag === null ? {} : { etag }),
          ...(since === undefined ? {} : { since }),
          page,
          repositoryId: input.repositoryId,
          signal: dependencies.signal,
        }),
      null,
      dependencies,
    );
  } catch (error) {
    if (!(error instanceof DeferredPollError)) throw error;
    if (!scheduleDeferred) throw error;
    await ctx.enqueue(
      "github-poll-retries",
      { observedAt: input.observedAt, repositoryId: input.repositoryId },
      { delayMs: error.delayMs },
    );
    const cursor = await ctx.call(intake.calls.getSourceCursor, {
      sourceId: `github:${input.repositoryId}`,
    });
    return { accepted: 0, cursor };
  }

  const issueByNumber = new Map<number, GitHubIssueRecord>();
  const issueById = new Map<string, GitHubIssueRecord>();
  for (const issue of issues.items) {
    issueByNumber.set(issue.number, issue);
    issueById.set(issue.id, issue);
  }
  const commentsById = new Map<string, GitHubIssueCommentRecord>();
  const ignoredIssueNumbers = new Set(
    issues.items.filter((issue) => issue.isPullRequest).map((issue) => issue.number),
  );
  for (const original of comments.items) {
    if (ignoredIssueNumbers.has(original.issueNumber)) continue;
    let comment = original;
    let issue = issueByNumber.get(comment.issueNumber);
    if (issue === undefined) {
      const snapshot = await db
        .selectFrom("github_issue_snapshots")
        .select("snapshot_json")
        .where("repository_id", "=", input.repositoryId)
        .where("issue_number", "=", comment.issueNumber)
        .executeTakeFirst();
      if (snapshot !== undefined) issue = JSON.parse(snapshot.snapshot_json) as GitHubIssueRecord;
    }
    if (issue === undefined) {
      try {
        issue = (
          await withRetry(
            () =>
              dependencies.readTransport.getIssue({
                issueNumber: comment.issueNumber,
                repositoryId: input.repositoryId,
                signal: dependencies.signal,
              }),
            dependencies,
          )
        ).issue;
      } catch (error) {
        if (error instanceof DeferredPollError) {
          if (!scheduleDeferred) throw error;
          await ctx.enqueue(
            "github-poll-retries",
            { observedAt: input.observedAt, repositoryId: input.repositoryId },
            { delayMs: error.delayMs },
          );
          const cursor = await ctx.call(intake.calls.getSourceCursor, {
            sourceId: `github:${input.repositoryId}`,
          });
          return { accepted: 0, cursor };
        }
        throw error;
      }
    }
    if (issue.isPullRequest) {
      ignoredIssueNumbers.add(issue.number);
      continue;
    }
    if (comment.issueId === undefined) comment = { ...comment, issueId: issue.id };
    commentsById.set(comment.id, comment);
  }

  const resources: PollResource[] = [
    ...[...issueById.values()].map((current) => ({
      current,
      kind: "issue" as const,
      position: { id: current.id, kind: "issue" as const, updatedAt: current.updatedAt },
    })),
    ...[...commentsById.values()].map((current) => ({
      current,
      kind: "comment" as const,
      position: { id: current.id, kind: "comment" as const, updatedAt: current.updatedAt },
    })),
  ].sort((left, right) => comparePosition(left.position, right.position));

  const normalized: Array<{ readonly event: FactoryEvent; readonly position: SourcePosition }> = [];
  for (const resource of resources) {
    if (resource.kind === "issue") {
      const current = resource.current as GitHubIssueRecord;
      const row = await db
        .selectFrom("github_issue_snapshots")
        .select("snapshot_json")
        .where("repository_id", "=", input.repositoryId)
        .where("issue_id", "=", current.id)
        .executeTakeFirst();
      const previous =
        row === undefined ? null : (JSON.parse(row.snapshot_json) as GitHubIssueRecord);
      for (const event of dependencies.normalizer.normalize({
        current,
        kind: "issue",
        observedAt: input.observedAt,
        previous,
        repositoryId: input.repositoryId,
      }))
        normalized.push({ event, position: resource.position });
    } else {
      const current = resource.current as GitHubIssueCommentRecord;
      const row = await db
        .selectFrom("github_comment_snapshots")
        .select("snapshot_json")
        .where("repository_id", "=", input.repositoryId)
        .where("comment_id", "=", current.id)
        .executeTakeFirst();
      const previous =
        row === undefined ? null : (JSON.parse(row.snapshot_json) as GitHubIssueCommentRecord);
      for (const event of dependencies.normalizer.normalize({
        current,
        kind: "comment",
        observedAt: input.observedAt,
        previous,
        repositoryId: input.repositoryId,
      }))
        normalized.push({ event, position: resource.position });
    }
  }
  normalized.sort(
    (left, right) =>
      comparePosition(left.position, right.position) ||
      left.event.sourceRevision.localeCompare(right.event.sourceRevision),
  );

  const sourceId = `github:${input.repositoryId}`;
  let cursor = await ctx.call(intake.calls.getSourceCursor, { sourceId });
  let accepted = 0;
  const allowedEvents = dependencies.repositoryEvents[input.repositoryId];
  for (const entry of normalized) {
    if (
      allowedEvents !== undefined &&
      !allowedEvents.includes("*") &&
      !allowedEvents.includes(entry.event.eventType)
    ) {
      continue;
    }
    const nextCursor = monotonicCursor(cursor?.cursor ?? null, entry.position);
    const result = await ctx.call(intake.calls.acceptSourceEventV2, {
      event: entry.event,
      expectedCursor: cursor?.cursor ?? null,
      nextCursor,
    });
    if (!result.idempotent) accepted += 1;
    cursor = { cursor: nextCursor, sourceId, updatedAt: entry.event.observedAt };
  }

  for (const resource of resources) {
    const snapshotJson = canonicalJson(resource.current);
    const position = encodePosition(resource.position);
    if (resource.kind === "issue") {
      const issue = resource.current as GitHubIssueRecord;
      await db
        .insertInto("github_issue_snapshots")
        .values({
          issue_id: issue.id,
          issue_number: issue.number,
          position,
          repository_id: input.repositoryId,
          snapshot_json: snapshotJson,
          updated_at: issue.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["repository_id", "issue_id"]).doUpdateSet({
            issue_number: issue.number,
            position,
            snapshot_json: snapshotJson,
            updated_at: issue.updatedAt,
          }),
        )
        .execute();
    } else {
      const comment = resource.current as GitHubIssueCommentRecord;
      await db
        .insertInto("github_comment_snapshots")
        .values({
          comment_id: comment.id,
          issue_number: comment.issueNumber,
          position,
          repository_id: input.repositoryId,
          snapshot_json: snapshotJson,
          updated_at: comment.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["repository_id", "comment_id"]).doUpdateSet({
            issue_number: comment.issueNumber,
            position,
            snapshot_json: snapshotJson,
            updated_at: comment.updatedAt,
          }),
        )
        .execute();
    }
  }

  let nextPosition = previousPosition;
  for (const resource of resources) {
    if (nextPosition === null || comparePosition(resource.position, nextPosition) > 0) {
      nextPosition = resource.position;
    }
  }
  const rate = mostRestrictiveRate(issues.rate, comments.rate);
  await db
    .insertInto("github_poll_state")
    .values({
      comments_etag: comments.etag ?? state?.comments_etag ?? null,
      issues_etag: issues.etag ?? state?.issues_etag ?? null,
      rate_limit: rate.limit,
      rate_remaining: rate.remaining,
      rate_retry_after_ms: rate.retryAfterMs,
      rate_reset_at: rate.resetAt,
      repository_id: input.repositoryId,
      source_position: nextPosition === null ? null : encodePosition(nextPosition),
      updated_at: input.observedAt,
    })
    .onConflict((conflict) =>
      conflict.column("repository_id").doUpdateSet({
        comments_etag: comments.etag ?? state?.comments_etag ?? null,
        issues_etag: issues.etag ?? state?.issues_etag ?? null,
        rate_limit: rate.limit,
        rate_remaining: rate.remaining,
        rate_retry_after_ms: rate.retryAfterMs,
        rate_reset_at: rate.resetAt,
        source_position: nextPosition === null ? null : encodePosition(nextPosition),
        updated_at: input.observedAt,
      }),
    )
    .execute();
  return { accepted, cursor };
}

async function collectPages<T>(
  read: (page: number, etag: string | null) => Promise<GitHubPage<T>>,
  etag: string | null,
  dependencies: ResolvedDependencies,
): Promise<PageCollection<T>> {
  const items: T[] = [];
  let pageNumber = 1;
  let firstEtag = etag;
  let rate: GitHubRateLimitRecord = {
    limit: null,
    remaining: null,
    resetAt: null,
    retryAfterMs: null,
  };
  while (true) {
    const page = await withRetry(
      () => read(pageNumber, pageNumber === 1 ? etag : null),
      dependencies,
    );
    rate = page.page.rate;
    if (page.page.etag !== null && pageNumber === 1) firstEtag = page.page.etag;
    items.push(...page.items);
    if (page.page.nextPage === null || page.page.notModified) break;
    pageNumber = page.page.nextPage;
  }
  return { etag: firstEtag, items, rate };
}

async function withRetry<T>(
  operation: () => Promise<T>,
  dependencies: ResolvedDependencies,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < dependencies.retry.maxAttempts; attempt += 1) {
    if (dependencies.signal.aborted) {
      throw dependencies.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    try {
      const result = await operation();
      const rate = rateOf(result);
      if (rate?.remaining === 0) {
        throw new GitHubReadError("GitHub read rate limit exhausted", 429, rate);
      }
      return result;
    } catch (error) {
      if (dependencies.signal.aborted || isAbortError(error)) throw error;
      if (!isRetryable(error)) throw error;
      lastError = error;
      const delayMs = retryDelay(error, attempt, dependencies);
      if (attempt + 1 === dependencies.retry.maxAttempts) {
        throw new DeferredPollError(delayMs, error);
      }
      await dependencies.sleep(delayMs, dependencies.signal);
    }
  }
  throw new DeferredPollError(dependencies.retry.maxDelayMs, lastError);
}

function retryDelay(error: unknown, attempt: number, dependencies: ResolvedDependencies): number {
  const exponential = Math.min(
    dependencies.retry.maxDelayMs,
    dependencies.retry.baseDelayMs * 2 ** attempt,
  );
  const jittered = Math.max(1, Math.round(exponential * (0.5 + dependencies.random() * 0.5)));
  if (!(error instanceof GitHubReadError)) return jittered;
  const resetDelay =
    error.rate.resetAt === null
      ? 0
      : Math.max(0, Date.parse(error.rate.resetAt) - dependencies.clock().getTime());
  return Math.max(jittered, error.rate.retryAfterMs ?? 0, resetDelay);
}

function rateOf(value: unknown): GitHubRateLimitRecord | null {
  if (value === null || typeof value !== "object") return null;
  if ("rate" in value && isRateLimit(value.rate)) return value.rate;
  if ("page" in value && value.page !== null && typeof value.page === "object") {
    if ("rate" in value.page && isRateLimit(value.page.rate)) return value.page.rate;
  }
  return null;
}

function isRateLimit(value: unknown): value is GitHubRateLimitRecord {
  if (value === null || typeof value !== "object") return false;
  return "limit" in value && "remaining" in value && "resetAt" in value && "retryAfterMs" in value;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof GitHubReadError) {
    return (
      error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500
    );
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && /network|timeout|transport/i.test(error.message))
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, delayMs),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function encodePosition(position: SourcePosition): string {
  return canonicalJson(position);
}

function decodePosition(cursor: string | null): SourcePosition | null {
  if (cursor === null) return null;
  try {
    const value = JSON.parse(cursor) as Partial<SourcePosition>;
    return (value.kind === "comment" || value.kind === "issue") &&
      typeof value.id === "string" &&
      typeof value.updatedAt === "string"
      ? { id: value.id, kind: value.kind, updatedAt: value.updatedAt }
      : null;
  } catch {
    return null;
  }
}

function monotonicCursor(current: string | null, candidate: SourcePosition): string {
  const decoded = decodePosition(current);
  return decoded !== null && comparePosition(decoded, candidate) >= 0
    ? (current ?? encodePosition(candidate))
    : encodePosition(candidate);
}

function comparePosition(left: SourcePosition, right: SourcePosition): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function mostRestrictiveRate(
  left: GitHubRateLimitRecord,
  right: GitHubRateLimitRecord,
): GitHubRateLimitRecord {
  const remaining =
    left.remaining === null
      ? right.remaining
      : right.remaining === null
        ? left.remaining
        : Math.min(left.remaining, right.remaining);
  return {
    limit: left.limit ?? right.limit,
    remaining,
    resetAt: left.resetAt ?? right.resetAt,
    retryAfterMs: left.retryAfterMs ?? right.retryAfterMs,
  };
}

export const unavailableGitHubReadTransport: GitHubReadTransport = {
  async diagnoseReadPermission() {
    throw new Error("module_unavailable: GitHub read transport is not configured");
  },
  async getIssue() {
    throw new Error("module_unavailable: GitHub read transport is not configured");
  },
  async getRateLimit() {
    throw new Error("module_unavailable: GitHub read transport is not configured");
  },
  async listChangedIssues() {
    throw new Error("module_unavailable: GitHub read transport is not configured");
  },
  async listIssueComments() {
    throw new Error("module_unavailable: GitHub read transport is not configured");
  },
};
