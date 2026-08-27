import {
  type ChimpbaseModuleContext,
  type ChimpbaseModuleInterface,
  defineChimpbaseModuleImplementation,
} from "chimpbase/core";
import { action, v, worker } from "chimpbase/runtime";
import type { Kysely } from "kysely";
import { GitHubWriteError } from "../../adapters/github-write-transport.ts";
import type {
  GitBranchMutation,
  GitHubWriteInput,
  GitHubWriteTransport,
  GitPublication,
  GitPublisher,
} from "../../adapters/seams.ts";
import { canonicalJson } from "../../compiler.ts";
import {
  type EffectFinishedV2,
  type EffectFinishedV3,
  type EffectIntentV2,
  type EffectIntentV3,
  type EffectOutcome,
  type EffectReceipt,
  type EffectReceiptV2,
  type EffectReceiptV3,
  type EffectResultV3,
  effectFinished,
  effectFinishedV2,
  effectFinishedV3,
  effectIntentV3,
  effectOutcome,
  effectReceipt,
  effectReceiptV2,
  effectReceiptV3,
  effectResultV3,
} from "../../contracts/index.ts";
import {
  effectMarker,
  extractFactoryEffectMarker,
  renderPublicArtifactComment,
} from "../../effects/comment-renderer.ts";
import {
  authorizeEffect,
  type CompiledEffectPolicy,
  effectPayloadDigest,
  effectPolicyFromPinnedDefinition,
} from "../../effects/policy.ts";
import {
  type EffectReceiptRow,
  type EffectReceiptV3Row,
  type EffectsDatabase,
  effectsMigrations,
} from "../../storage/effects-database.ts";
import { assets } from "../assets/interface.ts";
import { definitions } from "../definitions/interface.ts";
import { effects } from "./interface.ts";

const implementationInterface = effects as unknown as ChimpbaseModuleInterface<
  typeof effects.calls,
  typeof effects.events
>;
const legacyRequestedAt = "1970-01-01T00:00:00.000Z";

function receiptV2FromRow(row: EffectReceiptRow): EffectReceiptV2 {
  return effectReceiptV2.parse({
    correlationToken: row.correlation_token,
    effectId: row.effect_id,
    externalRevision: row.external_revision,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome,
    recordedAt: row.recorded_at,
    runId: row.run_id,
  });
}

function receiptV1FromV2(receipt: EffectReceiptV2): EffectReceipt {
  return effectReceipt.parse({
    effectId: receipt.effectId,
    externalRevision: receipt.externalRevision,
    ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
    idempotencyKey: receipt.idempotencyKey,
    outcome: receipt.outcome,
    recordedAt: receipt.recordedAt,
    runId: receipt.runId,
  });
}

async function loadReceipt(db: Kysely<EffectsDatabase>, idempotencyKey: string) {
  const row = await db
    .selectFrom("effect_receipts")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : receiptV2FromRow(row);
}

function receiptV3FromRow(row: EffectReceiptV3Row): EffectReceiptV3 {
  return effectReceiptV3.parse({
    correlationToken: row.correlation_token,
    effectId: row.effect_id,
    externalId: row.external_id,
    externalRevision: row.external_revision,
    externalUrl: row.external_url,
    failureCategory: row.failure_category,
    finishedAt: row.finished_at,
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome,
    recordedAt: row.recorded_at,
    runId: row.run_id,
    status: row.status,
  });
}

async function loadReceiptV3(db: Kysely<EffectsDatabase>, idempotencyKey: string) {
  const row = await db
    .selectFrom("effect_receipts_v3")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : receiptV3FromRow(row);
}

async function requestDurably(
  ctx: ChimpbaseModuleContext<EffectsDatabase>,
  input: EffectIntentV2,
): Promise<EffectReceiptV2> {
  const db = ctx.db.kysely();
  const existingIntent = await db
    .selectFrom("effect_intents")
    .selectAll()
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirst();
  if (existingIntent !== undefined) {
    const same =
      existingIntent.run_id === input.runId &&
      existingIntent.correlation_token === input.correlationToken &&
      existingIntent.provenance === input.provenance &&
      existingIntent.capability === input.capability &&
      existingIntent.target === input.target &&
      existingIntent.expected_external_revision === input.expectedExternalRevision &&
      existingIntent.payload_digest === input.payloadDigest &&
      existingIntent.requested_at === input.requestedAt;
    if (!same) throw new Error("effect_forbidden: idempotency key already has a different intent");
    const receipt = await loadReceipt(db, input.idempotencyKey);
    if (receipt === null) throw new Error("receipt_not_found");
    return receipt;
  }
  await db
    .insertInto("effect_intents")
    .values({
      capability: input.capability,
      correlation_token: input.correlationToken,
      expected_external_revision: input.expectedExternalRevision,
      idempotency_key: input.idempotencyKey,
      payload_digest: input.payloadDigest,
      provenance: input.provenance,
      requested_at: input.requestedAt,
      run_id: input.runId,
      target: input.target,
    })
    .execute();
  await db
    .insertInto("effect_preconditions")
    .values({
      expected_external_revision: input.expectedExternalRevision,
      idempotency_key: input.idempotencyKey,
      payload_digest: input.payloadDigest,
      target: input.target,
    })
    .execute();
  const row: EffectReceiptRow = {
    correlation_token: input.correlationToken,
    effect_id: `effect:${input.idempotencyKey}`,
    external_revision: null,
    finished_at: null,
    idempotency_key: input.idempotencyKey,
    outcome: "pending",
    recorded_at: input.requestedAt,
    run_id: input.runId,
  };
  await db.insertInto("effect_receipts").values(row).execute();
  await ctx.enqueue("effect-workers", { idempotencyKey: input.idempotencyKey });
  ctx.publish(effects.events.effectQueuedV1, input);
  return receiptV2FromRow(row);
}

async function reconcileDurably(
  db: Kysely<EffectsDatabase>,
  idempotencyKey: string,
  observedAt: string,
) {
  const receipt = await loadReceipt(db, idempotencyKey);
  if (receipt === null) throw new Error("receipt_not_found");
  await db
    .insertInto("effect_reconciliation")
    .values({
      idempotency_key: idempotencyKey,
      observed_at: observedAt,
      outcome: receipt.outcome,
    })
    .onConflict((conflict) => conflict.columns(["idempotency_key", "observed_at"]).doNothing())
    .execute();
  return receipt;
}

export const recordEffectOutcome = action({
  name: "effects.recordEffectOutcome",
  args: effectOutcome,
  result: effectFinishedV2,
  async handler(ctx, input): Promise<EffectFinishedV2> {
    const db = ctx.db.kysely<EffectsDatabase>();
    const row = await db
      .selectFrom("effect_receipts")
      .selectAll()
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) throw new Error("receipt_not_found");
    if (row.outcome !== "pending") {
      if (
        row.outcome === input.outcome &&
        row.finished_at === input.finishedAt &&
        row.external_revision === input.externalRevision
      ) {
        return effectFinishedV2.parse(receiptV2FromRow(row));
      }
      throw new Error("effect_already_finished");
    }
    await db
      .updateTable("effect_receipts")
      .set({
        external_revision: input.externalRevision,
        finished_at: input.finishedAt,
        outcome: input.outcome,
      })
      .where("idempotency_key", "=", input.idempotencyKey)
      .execute();
    const finished = effectFinishedV2.parse({
      correlationToken: row.correlation_token,
      effectId: row.effect_id,
      externalRevision: input.externalRevision,
      finishedAt: input.finishedAt,
      idempotencyKey: row.idempotency_key,
      outcome: input.outcome,
      recordedAt: row.recorded_at,
      runId: row.run_id,
    });
    ctx.publish(
      effects.events.effectFinishedV1,
      effectFinished.parse({
        effectId: finished.effectId,
        externalRevision: finished.externalRevision,
        finishedAt: finished.finishedAt,
        idempotencyKey: finished.idempotencyKey,
        outcome: finished.outcome,
        recordedAt: finished.recordedAt,
        runId: finished.runId,
      }),
    );
    ctx.publish(effects.events.effectFinishedV2, finished);
    return finished;
  },
});

const strictOutcome = v.object({
  finishedAt: v.string(),
  idempotencyKey: v.string(),
  result: effectResultV3,
});

export const recordEffectOutcomeV3 = action({
  name: "effects.recordEffectOutcomeV3",
  args: strictOutcome,
  result: effectFinishedV3,
  async handler(ctx, input): Promise<EffectFinishedV3> {
    const db = ctx.db.kysely<EffectsDatabase>();
    const row = await db
      .selectFrom("effect_receipts_v3")
      .selectAll()
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) throw new Error("receipt_not_found");
    if (row.status === "finished") {
      const existing = receiptV3FromRow(row);
      if (
        existing.outcome === input.result.outcome &&
        existing.finishedAt === input.finishedAt &&
        existing.externalRevision === input.result.externalRevision &&
        existing.externalId === input.result.externalId
      )
        return effectFinishedV3.parse(existing);
      throw new Error("effect_already_finished");
    }
    const updated: EffectReceiptV3Row = {
      ...row,
      external_id: input.result.externalId,
      external_revision: input.result.externalRevision,
      external_url: input.result.externalUrl,
      failure_category: input.result.failureCategory,
      finished_at: input.finishedAt,
      outcome: input.result.outcome,
      status: "finished",
    };
    await db
      .updateTable("effect_receipts_v3")
      .set(updated)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("status", "=", "queued")
      .execute();
    const finished = effectFinishedV3.parse(receiptV3FromRow(updated));
    ctx.publish(effects.events.effectFinishedV3, finished);
    return finished;
  },
});

export interface EffectsImplementationDependencies {
  readonly effectPolicy?: CompiledEffectPolicy;
  readonly githubWriteTransport?: GitHubWriteTransport;
  readonly gitPublisher?: GitPublisher;
  readonly now?: () => Date;
}

export function createEffectsImplementation(dependencies: EffectsImplementationDependencies = {}) {
  const now = dependencies.now ?? (() => new Date());

  const finish = async (
    ctx: ChimpbaseModuleContext<EffectsDatabase>,
    idempotencyKey: string,
    result: EffectResultV3,
  ) =>
    await ctx.action(recordEffectOutcomeV3, {
      finishedAt: now().toISOString(),
      idempotencyKey,
      result,
    });

  const renderBody = async (
    ctx: ChimpbaseModuleContext<EffectsDatabase>,
    intent: EffectIntentV3,
  ): Promise<string | undefined> => {
    if (!("artifactDigests" in intent.operation.payload)) return undefined;
    const digests = intent.operation.payload.artifactDigests;
    const metadata = await ctx.call(assets.calls.listRunArtifactsV2, {
      runId: intent.provenance.runId,
    });
    const envelopes = [];
    for (const digest of digests) {
      const artifact = metadata.find((candidate) => candidate.digest === digest);
      if (artifact?.attemptId === undefined) throw new Error(`artifact_not_found: ${digest}`);
      const envelope =
        artifact.classification === "private"
          ? await ctx.call(assets.calls.publishArtifactV2, {
              attemptId: artifact.attemptId,
              createdAt: intent.requestedAt,
              digest,
              runId: intent.provenance.runId,
            })
          : await ctx.call(assets.calls.getArtifactV2, {
              allowedDigests: digests,
              attemptId: artifact.attemptId,
              digest,
              runId: intent.provenance.runId,
            });
      if (envelope === null) throw new Error(`artifact_not_found: ${digest}`);
      envelopes.push(envelope);
    }
    return renderPublicArtifactComment({
      artifacts: envelopes,
      idempotencyKey: intent.idempotencyKey,
      runId: intent.provenance.runId,
      stepId: intent.provenance.stepId,
    });
  };

  const githubInput = (intent: EffectIntentV3, body: string | undefined): GitHubWriteInput => ({
    ...(body === undefined ? {} : { body }),
    intent,
    marker: effectMarker(intent.idempotencyKey),
  });

  const gitInput = (intent: EffectIntentV3): GitBranchMutation | GitPublication => {
    const operation = intent.operation;
    if (operation.kind === "create-branch")
      return {
        branch: operation.payload.branch,
        expectedRevision: operation.payload.baseRevision,
        kind: "create",
        marker: effectMarker(intent.idempotencyKey),
        repository: intent.target.repository,
      };
    if (operation.kind === "delete-branch")
      return {
        branch: operation.payload.branch,
        expectedRevision: operation.payload.headRevision,
        kind: "delete",
        marker: effectMarker(intent.idempotencyKey),
        repository: intent.target.repository,
      };
    if (operation.kind !== "push-verified-commit")
      throw new Error(`effect_adapter_unavailable: ${operation.kind}`);
    return {
      baseRevision: operation.payload.baseRevision,
      branch: operation.payload.branch,
      commitMessage: `${operation.payload.commitMessage}\n\n${effectMarker(intent.idempotencyKey)}`,
      repository: intent.target.repository,
      treeDigest: operation.payload.treeDigest,
      verified: operation.payload.verified,
    };
  };

  const isGitOperation = (intent: EffectIntentV3) =>
    intent.operation.kind === "create-branch" ||
    intent.operation.kind === "delete-branch" ||
    intent.operation.kind === "push-verified-commit";

  const probe = async (
    intent: EffectIntentV3,
    body: string | undefined,
  ): Promise<EffectResultV3 | null> => {
    if (isGitOperation(intent)) {
      if (dependencies.gitPublisher?.probe === undefined) return null;
      return await dependencies.gitPublisher.probe(gitInput(intent));
    }
    if (dependencies.githubWriteTransport === undefined) return null;
    return await dependencies.githubWriteTransport.probe(githubInput(intent, body));
  };

  const apply = async (
    intent: EffectIntentV3,
    body: string | undefined,
  ): Promise<EffectResultV3> => {
    if (!isGitOperation(intent)) {
      if (dependencies.githubWriteTransport === undefined)
        throw new GitHubWriteError("GitHub write transport is unavailable", "unavailable");
      return await dependencies.githubWriteTransport.apply(githubInput(intent, body));
    }
    if (dependencies.gitPublisher === undefined)
      throw new Error("effect_adapter_unavailable: git publisher");
    const input = gitInput(intent);
    if ("kind" in input) {
      const method =
        input.kind === "create"
          ? dependencies.gitPublisher.createBranch
          : dependencies.gitPublisher.deleteBranch;
      if (method === undefined) throw new Error("effect_adapter_unavailable: git branch mutation");
      return await method.call(dependencies.gitPublisher, input);
    }
    if (dependencies.gitPublisher.pushVerifiedCommit === undefined)
      throw new Error("effect_adapter_unavailable: verified commit push");
    return await dependencies.gitPublisher.pushVerifiedCommit(input);
  };

  const precondition = async (
    intent: EffectIntentV3,
    body: string | undefined,
  ): Promise<string | null> => {
    if (isGitOperation(intent)) {
      const input = gitInput(intent);
      return "kind" in input ? input.expectedRevision : input.baseRevision;
    }
    if (dependencies.githubWriteTransport === undefined)
      throw new GitHubWriteError("GitHub write transport is unavailable", "unavailable");
    return (await dependencies.githubWriteTransport.inspect(githubInput(intent, body))).revision;
  };

  const recordReconciliation = async (
    db: Kysely<EffectsDatabase>,
    idempotencyKey: string,
    result: EffectResultV3 | null,
  ) => {
    await db
      .insertInto("effect_reconciliation_v3")
      .values({
        idempotency_key: idempotencyKey,
        observed_at: now().toISOString(),
        result_json: canonicalJson(result),
      })
      .onConflict((conflict) => conflict.columns(["idempotency_key", "observed_at"]).doNothing())
      .execute();
  };

  const executeStrictEffect = async (
    ctx: ChimpbaseModuleContext<EffectsDatabase>,
    idempotencyKey: string,
  ): Promise<EffectReceiptV3> => {
    const db = ctx.db.kysely();
    const receipt = await loadReceiptV3(db, idempotencyKey);
    if (receipt === null) throw new Error("receipt_not_found");
    if (receipt.status === "finished") return receipt;
    const row = await db
      .selectFrom("effect_intents_v3")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) throw new Error("receipt_not_found");
    const intent = effectIntentV3.parse(JSON.parse(row.intent_json));
    if (row.dry_run === 1) {
      await finish(ctx, idempotencyKey, {
        externalId: null,
        externalRevision: null,
        externalUrl: null,
        failureCategory: null,
        outcome: "applied",
      });
      return (await loadReceiptV3(db, idempotencyKey)) ?? receipt;
    }
    let body: string | undefined;
    try {
      const existing = await probe(intent, undefined);
      await recordReconciliation(db, idempotencyKey, existing);
      if (existing !== null) {
        await finish(ctx, idempotencyKey, { ...existing, outcome: "already_applied" });
        return (await loadReceiptV3(db, idempotencyKey)) ?? receipt;
      }
      if (intent.expectedExternalRevision !== null) {
        const observed = await precondition(intent, body);
        await db
          .updateTable("effect_preconditions_v3")
          .set({
            checked_at: now().toISOString(),
            observed_external_revision: observed,
          })
          .where("idempotency_key", "=", idempotencyKey)
          .execute();
        if (observed !== intent.expectedExternalRevision) {
          await finish(ctx, idempotencyKey, {
            externalId: null,
            externalRevision: observed,
            externalUrl: null,
            failureCategory: "conflict",
            outcome: "conflict",
          });
          return (await loadReceiptV3(db, idempotencyKey)) ?? receipt;
        }
      }
      body = await renderBody(ctx, intent);
      const result = await apply(intent, body);
      await finish(ctx, idempotencyKey, result);
    } catch (error) {
      if (
        isGitOperation(intent) ||
        (error instanceof GitHubWriteError && error.category === "ambiguous_network")
      ) {
        let reconciled: EffectResultV3 | null = null;
        try {
          reconciled = await probe(intent, body);
        } catch {
          reconciled = null;
        }
        await recordReconciliation(db, idempotencyKey, reconciled);
        if (reconciled !== null) {
          await finish(ctx, idempotencyKey, { ...reconciled, outcome: "applied" });
          return (await loadReceiptV3(db, idempotencyKey)) ?? receipt;
        }
      }
      const category =
        error instanceof GitHubWriteError
          ? error.category
          : error instanceof Error && /stale|conflict/.test(error.message)
            ? "conflict"
            : error instanceof Error &&
                /artifact_not_publishable|unverified|not_owned|unknown/.test(error.message)
              ? "validation"
              : "provider";
      const outcome =
        category === "conflict"
          ? "conflict"
          : category === "permission" || category === "validation"
            ? "rejected"
            : "failed";
      await finish(ctx, idempotencyKey, {
        externalId: null,
        externalRevision: null,
        externalUrl: null,
        failureCategory: category,
        outcome,
      });
    }
    return (await loadReceiptV3(db, idempotencyKey)) ?? receipt;
  };

  const effectWorker = worker(
    "effect-workers",
    async (
      ctx,
      payload: {
        idempotencyKey: string;
        outcome?: EffectOutcome;
        protocolVersion?: 3;
      },
    ) => {
      if (payload.protocolVersion === 3) {
        await executeStrictEffect(
          ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>,
          payload.idempotencyKey,
        );
        return;
      }
      if (payload.outcome === undefined) {
        const receipt = await loadReceipt(ctx.db.kysely<EffectsDatabase>(), payload.idempotencyKey);
        if (receipt !== null && receipt.outcome !== "pending") return;
        throw new Error(
          `effect_adapter_unavailable: no trusted adapter configured for ${payload.idempotencyKey}`,
        );
      }
      await ctx.action(recordEffectOutcome, payload.outcome);
    },
    { dlq: "effect-workers.dlq" },
  );

  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: effectsMigrations,
    registrations: [recordEffectOutcome, recordEffectOutcomeV3, effectWorker],
    resources: {
      collections: [
        "effect-intents",
        "effect-receipts",
        "effect-reconciliation",
        "effect-dry-runs",
        "effect-bot-correlations",
      ],
      queues: ["effect-workers", "effect-workers.dlq"],
      tables: [
        "effect_bot_correlations_v3",
        "effect_dry_runs_v3",
        "effect_intents",
        "effect_intents_v3",
        "effect_preconditions",
        "effect_preconditions_v3",
        "effect_receipts",
        "effect_receipts_v3",
        "effect_reconciliation",
        "effect_reconciliation_v3",
      ],
    },
    calls: {
      async requestEffect(ctx, input) {
        const receipt = await requestDurably(
          ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>,
          { ...input, requestedAt: legacyRequestedAt },
        );
        return receiptV1FromV2(receipt);
      },
      async requestEffectV2(ctx, input) {
        return await requestDurably(
          ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>,
          input,
        );
      },
      async requestEffectV3(ctx, input) {
        let policy = dependencies.effectPolicy;
        if (policy === undefined) {
          const revision = await ctx.call(definitions.calls.resolveRevision, {
            definitionDigest: input.provenance.definitionDigest,
          });
          if (revision === null)
            throw new Error("effect_forbidden: pinned definition policy is unavailable");
          policy = effectPolicyFromPinnedDefinition(
            revision.normalizedJson,
            revision.definitionDigest,
          );
        }
        if (effectPayloadDigest(input.operation) !== input.payloadDigest)
          throw new Error("payload_digest_mismatch");
        const authorization = authorizeEffect(policy, input);
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        const intentJson = canonicalJson(input);
        const existingIntent = await db
          .selectFrom("effect_intents_v3")
          .select(["intent_json"])
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (existingIntent !== undefined) {
          if (existingIntent.intent_json !== intentJson)
            throw new Error("effect_forbidden: idempotency key already has a different intent");
          const existing = await loadReceiptV3(db, input.idempotencyKey);
          if (existing === null) throw new Error("receipt_not_found");
          return existing.status === "finished" && existing.outcome === "applied"
            ? effectReceiptV3.parse({ ...existing, outcome: "already_applied" })
            : existing;
        }
        await db
          .insertInto("effect_intents_v3")
          .values({
            capability: input.capability,
            correlation_token: input.correlationToken,
            dry_run: authorization.dryRun ? 1 : 0,
            idempotency_key: input.idempotencyKey,
            intent_json: intentJson,
            payload_digest: input.payloadDigest,
            requested_at: input.requestedAt,
            run_id: input.provenance.runId,
          })
          .execute();
        await db
          .insertInto("effect_preconditions_v3")
          .values({
            checked_at: null,
            expected_external_revision: input.expectedExternalRevision,
            idempotency_key: input.idempotencyKey,
            observed_external_revision: null,
          })
          .execute();
        const receiptRow: EffectReceiptV3Row = {
          correlation_token: input.correlationToken,
          effect_id: `effect:${input.idempotencyKey}`,
          external_id: null,
          external_revision: null,
          external_url: null,
          failure_category: null,
          finished_at: null,
          idempotency_key: input.idempotencyKey,
          outcome: null,
          recorded_at: input.requestedAt,
          run_id: input.provenance.runId,
          status: "queued",
        };
        await db.insertInto("effect_receipts_v3").values(receiptRow).execute();
        if (authorization.dryRun) {
          await db
            .insertInto("effect_dry_runs_v3")
            .values({
              idempotency_key: input.idempotencyKey,
              planned_at: input.requestedAt,
              planned_json: canonicalJson({
                idempotencyKey: input.idempotencyKey,
                operation: input.operation,
                payloadDigest: input.payloadDigest,
                plannedAt: input.requestedAt,
                target: input.target,
              }),
            })
            .execute();
        }
        await ctx.enqueue("effect-workers", {
          idempotencyKey: input.idempotencyKey,
          protocolVersion: 3,
        });
        ctx.publish(effects.events.effectQueuedV2, input);
        return receiptV3FromRow(receiptRow);
      },
      async getReceipt(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        const receipt = await loadReceipt(db, input.idempotencyKey);
        return receipt === null ? null : receiptV1FromV2(receipt);
      },
      async getReceiptV2(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        return await loadReceipt(db, input.idempotencyKey);
      },
      async getReceiptV3(ctx, input) {
        return await loadReceiptV3(
          ctx.db.kysely() as unknown as Kysely<EffectsDatabase>,
          input.idempotencyKey,
        );
      },
      async getDryRunV3(ctx, input) {
        const row = await (ctx.db.kysely() as unknown as Kysely<EffectsDatabase>)
          .selectFrom("effect_dry_runs_v3")
          .select("planned_json")
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        return row === undefined ? null : JSON.parse(row.planned_json);
      },
      async reconcileEffect(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        return receiptV1FromV2(await reconcileDurably(db, input.idempotencyKey, input.observedAt));
      },
      async reconcileEffectV2(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        return await reconcileDurably(db, input.idempotencyKey, input.observedAt);
      },
      async reconcileEffectV3(ctx, input) {
        const receipt = await executeStrictEffect(
          ctx as unknown as ChimpbaseModuleContext<EffectsDatabase>,
          input.idempotencyKey,
        );
        await (ctx.db.kysely() as unknown as Kysely<EffectsDatabase>)
          .insertInto("effect_reconciliation_v3")
          .values({
            idempotency_key: input.idempotencyKey,
            observed_at: input.observedAt,
            result_json: canonicalJson(receipt),
          })
          .onConflict((conflict) =>
            conflict.columns(["idempotency_key", "observed_at"]).doNothing(),
          )
          .execute();
        return receipt;
      },
      async correlateBotEventV3(ctx, input) {
        if (input.actorType !== "bot") return null;
        const idempotencyKey = extractFactoryEffectMarker(input.body);
        if (idempotencyKey === null) return null;
        const db = ctx.db.kysely() as unknown as Kysely<EffectsDatabase>;
        const receipt = await loadReceiptV3(db, idempotencyKey);
        if (
          receipt === null ||
          receipt.status !== "finished" ||
          receipt.externalId !== input.externalId
        )
          return null;
        await db
          .insertInto("effect_bot_correlations_v3")
          .values({
            external_id: input.externalId,
            idempotency_key: idempotencyKey,
            observed_at: input.observedAt,
          })
          .onConflict((conflict) => conflict.column("external_id").doNothing())
          .execute();
        return receipt;
      },
    },
  });
}

export const effectsImplementation = createEffectsImplementation();
