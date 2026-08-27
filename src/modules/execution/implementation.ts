import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import { action, worker } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import {
  type AttemptFinished,
  type AttemptOutcome,
  attemptFinished,
  attemptOutcome,
  type StepAttempt,
  type StepAttemptV2,
  stepAttempt,
  stepAttemptV2,
} from "../../contracts/index.ts";
import {
  type ExecutionDatabase,
  executionMigrations,
  type StepAttemptRow,
} from "../../storage/execution-database.ts";
import { execution } from "./interface.ts";

const implementationInterface = execution as unknown as ChimpbaseModuleInterface<
  typeof execution.calls,
  typeof execution.events
>;

async function attemptFromRow(
  db: Kysely<ExecutionDatabase>,
  row: StepAttemptRow,
): Promise<StepAttemptV2> {
  const resultRow = await db
    .selectFrom("attempt_results")
    .select("result_json")
    .where("attempt_id", "=", row.attempt_id)
    .executeTakeFirst();
  const workspace = await db
    .selectFrom("workspaces")
    .select("status")
    .where("attempt_id", "=", row.attempt_id)
    .executeTakeFirstOrThrow();
  return stepAttemptV2.parse({
    agentProfileDigest: row.agent_profile_digest,
    attemptId: row.attempt_id,
    correlationToken: row.correlation_token,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    outcome: row.outcome,
    ...(resultRow === undefined ? {} : { result: JSON.parse(resultRow.result_json) }),
    runId: row.run_id,
    startedAt: row.started_at,
    stepId: row.step_id,
    workspaceStatus: workspace.status,
  });
}
function attemptV1FromV2(attempt: StepAttemptV2): StepAttempt {
  return stepAttempt.parse({
    agentProfileDigest: attempt.agentProfileDigest,
    attemptId: attempt.attemptId,
    correlationToken: attempt.correlationToken,
    ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
    outcome: attempt.outcome,
    ...(attempt.result === undefined ? {} : { result: attempt.result }),
    runId: attempt.runId,
    startedAt: attempt.startedAt,
    stepId: attempt.stepId,
  });
}

export const recordAttemptOutcome = action({
  name: "execution.recordAttemptOutcome",
  args: attemptOutcome,
  result: attemptFinished,
  async handler(ctx, input): Promise<AttemptFinished> {
    const db = ctx.db.kysely<ExecutionDatabase>();
    const row = await db
      .selectFrom("step_attempts")
      .selectAll()
      .where("attempt_id", "=", input.attemptId)
      .executeTakeFirst();
    if (row === undefined) throw new Error("attempt_not_found");
    if (row.outcome !== "pending") {
      const existing = await attemptFromRow(db, row);
      if (
        existing.finishedAt === input.finishedAt &&
        existing.outcome === input.outcome &&
        JSON.stringify(existing.result) === JSON.stringify(input.result)
      ) {
        return attemptFinished.parse({
          agentProfileDigest: row.agent_profile_digest,
          attemptId: row.attempt_id,
          correlationToken: row.correlation_token,
          finishedAt: input.finishedAt,
          outcome: input.outcome,
          result: input.result,
          runId: row.run_id,
          startedAt: row.started_at,
          stepId: row.step_id,
        });
      }
      throw new Error("attempt_already_finished");
    }
    await db
      .updateTable("step_attempts")
      .set({
        finished_at: input.finishedAt,
        outcome: input.outcome,
      })
      .where("attempt_id", "=", input.attemptId)
      .execute();
    await db
      .insertInto("attempt_results")
      .values({
        attempt_id: input.attemptId,
        finished_at: input.finishedAt,
        result_json: JSON.stringify(input.result),
      })
      .execute();
    await db
      .updateTable("workspaces")
      .set({ status: "finished" })
      .where("attempt_id", "=", input.attemptId)
      .execute();
    const finished = attemptFinished.parse({
      agentProfileDigest: row.agent_profile_digest,
      attemptId: row.attempt_id,
      correlationToken: row.correlation_token,
      finishedAt: input.finishedAt,
      outcome: input.outcome,
      result: input.result,
      runId: row.run_id,
      startedAt: row.started_at,
      stepId: row.step_id,
    });
    ctx.publish(execution.events.attemptFinishedV1, finished);
    return finished;
  },
});

const attemptWorker = worker(
  "agent-workers",
  async (ctx, payload: { attemptId: string; outcome?: AttemptOutcome }) => {
    if (payload.outcome !== undefined) {
      await ctx.action(recordAttemptOutcome, payload.outcome);
      return;
    }
    await ctx.db
      .kysely<ExecutionDatabase>()
      .updateTable("workspaces")
      .set({ status: "ready" })
      .where("attempt_id", "=", payload.attemptId)
      .where("status", "=", "queued")
      .execute();
  },
);

export const executionImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: executionMigrations,
  registrations: [recordAttemptOutcome, attemptWorker],
  resources: {
    collections: ["step-attempts", "workspaces"],
    queues: ["agent-workers"],
    tables: ["attempt_results", "step_attempts", "workspaces"],
  },
  calls: {
    async requestAttempt(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
      const existing = await db
        .selectFrom("step_attempts")
        .selectAll()
        .where("attempt_id", "=", input.attemptId)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (
          existing.correlation_token !== input.correlationToken ||
          existing.run_id !== input.runId ||
          existing.step_id !== input.stepId ||
          existing.agent_profile_digest !== input.agentProfile.digest ||
          existing.started_at !== input.startedAt ||
          existing.input_artifact_digests_json !== JSON.stringify(input.inputArtifactDigests) ||
          JSON.stringify(Object.entries(JSON.parse(existing.skill_digests_json)).sort()) !==
            JSON.stringify(Object.entries(input.skillDigests).sort())
        ) {
          throw new Error("attempt_exists: immutable attempt identity has different pins");
        }
        return attemptV1FromV2(await attemptFromRow(db, existing));
      }
      const row: StepAttemptRow = {
        agent_profile_digest: input.agentProfile.digest,
        attempt_id: input.attemptId,
        correlation_token: input.correlationToken,
        finished_at: null,
        input_artifact_digests_json: JSON.stringify(input.inputArtifactDigests),
        outcome: "pending",
        run_id: input.runId,
        skill_digests_json: JSON.stringify(input.skillDigests),
        started_at: input.startedAt,
        step_id: input.stepId,
      };
      await db.insertInto("step_attempts").values(row).execute();
      await db
        .insertInto("workspaces")
        .values({
          attempt_id: input.attemptId,
          created_at: input.startedAt,
          status: "queued",
          workspace_id: `workspace:${input.attemptId}`,
        })
        .execute();
      const attempt = await attemptFromRow(db, row);
      await ctx.enqueue("agent-workers", { attemptId: input.attemptId });
      ctx.publish(execution.events.attemptQueuedV1, attempt);
      return attemptV1FromV2(attempt);
    },
    async getAttempt(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
      const row = await db
        .selectFrom("step_attempts")
        .selectAll()
        .where("attempt_id", "=", input.attemptId)
        .executeTakeFirst();
      return row === undefined ? null : attemptV1FromV2(await attemptFromRow(db, row));
    },
    async getAttemptV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
      const row = await db
        .selectFrom("step_attempts")
        .selectAll()
        .where("attempt_id", "=", input.attemptId)
        .executeTakeFirst();
      return row === undefined ? null : await attemptFromRow(db, row);
    },
  },
});
