import { createHash } from "node:crypto";

import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import { action, worker } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import type { AgentRuntime } from "../../adapters/seams.ts";
import {
  type AgentRequest,
  type AgentRequestV2,
  type AgentResult,
  type AttemptFinished,
  type AttemptFinishedV2,
  type AttemptOutcome,
  attemptFinished,
  attemptFinishedV2,
  attemptOutcome,
  parseAgentRequest,
  parseAgentRequestV2,
  parseAgentResult,
  type StepAttempt,
  type StepAttemptV2,
  type StepAttemptV3,
  stepAttempt,
  stepAttemptV2,
  stepAttemptV3,
  validateSkillResult,
} from "../../contracts/index.ts";
import {
  type ExecutionDatabase,
  executionMigrations,
  type StepAttemptRow,
} from "../../storage/execution-database.ts";
import { assets } from "../assets/interface.ts";
import { execution } from "./interface.ts";

const EMPTY_DIGEST = createHash("sha256").update("").digest("hex");

const implementationInterface = execution as unknown as ChimpbaseModuleInterface<
  typeof execution.calls,
  typeof execution.events
>;

export interface ExecutionImplementationDependencies {
  readonly agentRuntime?: AgentRuntime;
  readonly deferAttempts?: boolean;
  readonly now?: () => Date;
}

export const unavailableAgentRuntime: AgentRuntime = {
  async run(request) {
    return infrastructureResult(
      request,
      "adapter",
      "agent runtime is not configured; refusing unsandboxed execution",
      new Date(),
    );
  },
  async cancel() {},
};

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
  const requestRecord = await db
    .selectFrom("attempt_requests")
    .select("protocol_version")
    .where("attempt_id", "=", row.attempt_id)
    .executeTakeFirst();
  let result: unknown;
  if (resultRow !== undefined) {
    const stored = JSON.parse(resultRow.result_json) as unknown;
    result = requestRecord?.protocol_version === 2 ? parseAgentResult(stored).outcome : stored;
  }
  return stepAttemptV2.parse({
    agentProfileDigest: row.agent_profile_digest,
    attemptId: row.attempt_id,
    correlationToken: row.correlation_token,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    outcome: row.outcome,
    ...(result === undefined ? {} : { result }),
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

async function attemptFromRowV3(
  db: Kysely<ExecutionDatabase>,
  row: StepAttemptRow,
): Promise<StepAttemptV3> {
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
  const requestRecord = await db
    .selectFrom("attempt_requests")
    .select("protocol_version")
    .where("attempt_id", "=", row.attempt_id)
    .executeTakeFirst();
  return stepAttemptV3.parse({
    agentProfileDigest: row.agent_profile_digest,
    attemptId: row.attempt_id,
    correlationToken: row.correlation_token,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    outcome: row.outcome,
    ...(resultRow === undefined ||
    (requestRecord?.protocol_version !== 2 && requestRecord?.protocol_version !== 3)
      ? {}
      : { result: parseAgentResult(JSON.parse(resultRow.result_json)) }),
    runId: row.run_id,
    startedAt: row.started_at,
    stepId: row.step_id,
    workspaceStatus: workspace.status,
  });
}

async function storeResult(
  db: Kysely<ExecutionDatabase>,
  row: StepAttemptRow,
  result: AgentResult,
): Promise<void> {
  const finishedAt = result.timing.finishedAt;
  await db
    .updateTable("step_attempts")
    .set({
      finished_at: finishedAt,
      outcome: result.outcome === undefined ? "failed" : result.status,
    })
    .where("attempt_id", "=", row.attempt_id)
    .where("outcome", "=", "pending")
    .execute();
  await db
    .insertInto("attempt_results")
    .values({
      attempt_id: row.attempt_id,
      finished_at: finishedAt,
      result_json: JSON.stringify(result),
    })
    .execute();
  await db
    .insertInto("attempt_result_metadata")
    .values({
      attempt_id: row.attempt_id,
      changed_files_json: JSON.stringify(result.changedFiles),
      commit_json: result.commit === undefined ? null : JSON.stringify(result.commit),
      failure_category: result.failure?.category ?? null,
      logs_json: JSON.stringify(result.logs),
      patch_json: result.patch === undefined ? null : JSON.stringify(result.patch),
      resources_json: JSON.stringify(result.resources),
      tests_json: JSON.stringify(result.tests),
      timing_json: JSON.stringify(result.timing),
    })
    .execute();
  await db
    .updateTable("workspaces")
    .set({ status: "finished" })
    .where("attempt_id", "=", row.attempt_id)
    .execute();
  await db
    .updateTable("workspace_lifecycle")
    .set({ finished_at: finishedAt })
    .where("attempt_id", "=", row.attempt_id)
    .execute();
}

function strictFinished(row: StepAttemptRow, result: AgentResult): AttemptFinishedV2 {
  return attemptFinishedV2.parse({
    agentProfileDigest: row.agent_profile_digest,
    attemptId: row.attempt_id,
    correlationToken: row.correlation_token,
    finishedAt: result.timing.finishedAt,
    result,
    runId: row.run_id,
    startedAt: row.started_at,
    stepId: row.step_id,
  });
}

function legacyFinished(row: StepAttemptRow, result: AgentResult): AttemptFinished | null {
  if (result.outcome === undefined) return null;
  return attemptFinished.parse({
    agentProfileDigest: row.agent_profile_digest,
    attemptId: row.attempt_id,
    correlationToken: row.correlation_token,
    finishedAt: result.timing.finishedAt,
    outcome: result.status,
    result: result.outcome,
    runId: row.run_id,
    startedAt: row.started_at,
    stepId: row.step_id,
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
    const requestRecord = await db
      .selectFrom("attempt_requests")
      .select("protocol_version")
      .where("attempt_id", "=", input.attemptId)
      .executeTakeFirst();
    if (row.outcome !== "pending") {
      const existing =
        requestRecord?.protocol_version === 2
          ? await attemptFromRowV3(db, row)
          : await attemptFromRow(db, row);
      const stored = existing.result;
      const existingDomain = stored !== undefined && "status" in stored ? stored.outcome : stored;
      if (
        existing.finishedAt === input.finishedAt &&
        existing.outcome === input.outcome &&
        canonicalJson(existingDomain) === canonicalJson(input.result)
      )
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
      throw new Error("attempt_already_finished");
    }
    if (requestRecord?.protocol_version === 2) {
      const startedMs = Date.parse(row.started_at);
      const finishedMs = Date.parse(input.finishedAt);
      const elapsedMs =
        Number.isFinite(startedMs) && Number.isFinite(finishedMs)
          ? Math.max(0, Math.trunc(finishedMs - startedMs))
          : 0;
      const injected: AgentResult = {
        attemptId: row.attempt_id,
        changedFiles: [],
        logs: {
          stderrBytes: 0,
          stderrDigest: EMPTY_DIGEST,
          stderrTruncated: false,
          stdoutBytes: 0,
          stdoutDigest: EMPTY_DIGEST,
        },
        outcome: input.result,
        resources: { cpuMs: 0, maxRssBytes: 0 },
        status: input.outcome,
        tests: [],
        timing: {
          durationMs: elapsedMs,
          finishedAt: input.finishedAt,
          startedAt: row.started_at,
        },
      };
      await storeResult(db, row, injected);
      ctx.publish(execution.events.attemptFinishedV2, strictFinished(row, injected));
      const legacy = legacyFinished(row, injected);
      if (legacy === null) throw new Error("attempt outcome did not contain a domain result");
      ctx.publish(execution.events.attemptFinishedV1, legacy);
      return legacy;
    }
    await db
      .updateTable("step_attempts")
      .set({ finished_at: input.finishedAt, outcome: input.outcome })
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
      .insertInto("attempt_result_metadata")
      .values({
        attempt_id: input.attemptId,
        changed_files_json: "[]",
        commit_json: null,
        failure_category: null,
        logs_json: "{}",
        patch_json: null,
        resources_json: "{}",
        tests_json: "[]",
        timing_json: "{}",
      })
      .execute();
    await db
      .updateTable("workspaces")
      .set({ status: "finished" })
      .where("attempt_id", "=", input.attemptId)
      .execute();
    await db
      .updateTable("workspace_lifecycle")
      .set({ finished_at: input.finishedAt })
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

export function createExecutionImplementation(
  dependencies: ExecutionImplementationDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const activeControllers = new Map<string, AbortController>();
  const agentRuntime = dependencies.agentRuntime ?? unavailableAgentRuntime;
  const attemptWorker = worker(
    "agent-workers",
    async (
      ctx,
      payload: {
        attemptId: string;
        outcome?: AttemptOutcome;
        protocolVersion?: 1 | 2 | 3;
      },
    ) => {
      const db = ctx.db.kysely<ExecutionDatabase>();
      const row = await db
        .selectFrom("step_attempts")
        .selectAll()
        .where("attempt_id", "=", payload.attemptId)
        .executeTakeFirst();
      if (row === undefined || row.outcome !== "pending") return;
      if (payload.outcome !== undefined) {
        await ctx.action(recordAttemptOutcome, payload.outcome);
        return;
      }
      const requestRecord = await db
        .selectFrom("attempt_requests")
        .selectAll()
        .where("attempt_id", "=", payload.attemptId)
        .executeTakeFirst();
      if (payload.protocolVersion !== 2 && payload.protocolVersion !== 3) {
        await db
          .updateTable("workspaces")
          .set({ status: "ready" })
          .where("attempt_id", "=", payload.attemptId)
          .where("status", "=", "queued")
          .execute();
        await db
          .updateTable("workspace_lifecycle")
          .set({ ready_at: row.started_at })
          .where("attempt_id", "=", payload.attemptId)
          .execute();
        return;
      }

      let request: AgentRequest | AgentRequestV2;
      let result: AgentResult;
      try {
        if (requestRecord === undefined) throw new Error("invalid_pin: attempt request is missing");
        request =
          payload.protocolVersion === 3
            ? parseAgentRequestV2(JSON.parse(requestRecord.request_json))
            : parseAgentRequest(JSON.parse(requestRecord.request_json));
        const cancellation = await db
          .selectFrom("attempt_cancellations")
          .select("cancelled_at")
          .where("attempt_id", "=", payload.attemptId)
          .executeTakeFirst();
        if (cancellation !== undefined) throw new Error("attempt_cancelled");
        const readyAt = now().toISOString();
        await db
          .updateTable("workspaces")
          .set({ status: "ready" })
          .where("attempt_id", "=", payload.attemptId)
          .execute();
        await db
          .updateTable("workspace_lifecycle")
          .set({ ready_at: readyAt })
          .where("attempt_id", "=", payload.attemptId)
          .execute();
        if (dependencies.deferAttempts === true) return;
        const artifactsWithBytes = [];
        for (const materialization of request.inputArtifacts) {
          if (materialization.contentBase64 !== undefined || materialization.kind !== "artifact") {
            artifactsWithBytes.push(materialization);
            continue;
          }
          const envelope =
            payload.protocolVersion === 3
              ? await ctx.call(assets.calls.materializeForAttemptV2, {
                  allowedDigests: request.inputArtifacts
                    .filter((candidate) => candidate.kind === "artifact")
                    .map((candidate) => candidate.digest),
                  attemptId: request.attemptId,
                  digest: materialization.digest,
                  runId: request.runId,
                })
              : await ctx.call(assets.calls.getArtifact, { digest: materialization.digest });
          if (envelope === null) throw new Error(`artifact_not_found: ${materialization.digest}`);
          if (envelope.artifact.runId !== request.runId)
            throw new Error(`artifact_run_mismatch: ${materialization.digest}`);
          artifactsWithBytes.push({
            ...materialization,
            contentBase64: envelope.contentBase64,
            size: envelope.artifact.size,
          });
        }
        request = { ...request, inputArtifacts: artifactsWithBytes };
        const controller = new AbortController();
        activeControllers.set(request.attemptId, controller);
        let returned: AgentResult;
        try {
          returned = await agentRuntime.run(request, controller.signal);
        } finally {
          activeControllers.delete(request.attemptId);
        }
        result = parseAgentResult(returned);
        if (
          payload.protocolVersion === 3 &&
          result.outcome !== undefined &&
          request.skills.length === 1
        ) {
          const selectedSkill = request.skills[0] as AgentRequestV2["skills"][number] | undefined;
          if (selectedSkill === undefined)
            throw new Error("invalid_pin: selected skill is missing");
          validateSkillResult(selectedSkill.resultSchema, result.outcome.data);
        }
        if (result.attemptId !== row.attempt_id)
          throw new Error("agent result attempt id does not match its lease");
        const encoded = Buffer.byteLength(JSON.stringify(result));
        const bound = Math.min(
          request.agentProfile.limits.maxOutputBytes,
          request.budget.maxOutputBytes,
        );
        if (encoded > bound) throw new Error("agent result exceeded the committed result bound");
        const outputArtifactDigests: string[] = [];
        const storeOutput = async (
          kind: "patch" | "report.md" | "result.json",
          name: string,
          mediaType: string,
          bytes: Uint8Array,
        ) => {
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          await ctx.call(assets.calls.storeArtifactV2, {
            artifact: {
              attemptId: request.attemptId,
              classification: "private",
              createdAt: result.timing.finishedAt,
              digest,
              kind,
              mediaType,
              name,
              redaction: "raw-private",
              retention: "retained",
              runId: request.runId,
              size: bytes.byteLength,
            },
            contentBase64: Buffer.from(bytes).toString("base64"),
          });
          outputArtifactDigests.push(digest);
        };
        for (const file of result.changedFiles) {
          if (file.contentBase64 === undefined)
            throw new Error(`adapter output bytes missing for ${file.path}`);
          const bytes = Buffer.from(file.contentBase64, "base64");
          const claimed = `sha256:${file.digest.replace(/^sha256:/u, "")}`;
          const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (claimed !== actual || file.size !== bytes.byteLength)
            throw new Error(`digest_mismatch: adapter output ${file.path}`);
          if (payload.protocolVersion === 3) {
            await storeOutput("patch", file.path, "application/octet-stream", bytes);
          } else {
            await ctx.call(assets.calls.putArtifact, {
              artifact: {
                classification: "private",
                digest: claimed,
                mediaType: "application/octet-stream",
                name: file.path,
                runId: request.runId,
                size: file.size,
              },
              contentBase64: file.contentBase64,
            });
            outputArtifactDigests.push(claimed);
          }
        }
        if (payload.protocolVersion === 3 && result.outcome !== undefined) {
          await storeOutput(
            "result.json",
            "result.json",
            "application/json",
            Buffer.from(JSON.stringify(result.outcome.data), "utf8"),
          );
          await storeOutput(
            "report.md",
            "report.md",
            "text/markdown; charset=utf-8",
            Buffer.from(result.outcome.summary, "utf8"),
          );
        }
        result = {
          ...result,
          changedFiles: result.changedFiles.map(({ digest, path, size }) => ({
            digest,
            path,
            size,
          })),
          ...(result.outcome === undefined
            ? {}
            : {
                outcome: {
                  ...result.outcome,
                  outputArtifactDigests,
                },
              }),
        };
      } catch (error) {
        const fallbackRequest =
          requestRecord === undefined
            ? ({ attemptId: row.attempt_id, startedAt: row.started_at } as AgentRequest)
            : payload.protocolVersion === 3
              ? parseAgentRequestV2(JSON.parse(requestRecord.request_json))
              : parseAgentRequest(JSON.parse(requestRecord.request_json));
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = infrastructureResult(
          fallbackRequest,
          errorMessage === "attempt_cancelled"
            ? "cancel"
            : /result|schema|validation|bound|required|must be/iu.test(errorMessage)
              ? "result-invalid"
              : "adapter",
          errorMessage,
          now(),
        );
      }
      await storeResult(db, row, result);
      const v2 = strictFinished(row, result);
      ctx.publish(execution.events.attemptFinishedV2, v2);
      const v1 = legacyFinished(row, result);
      if (v1 !== null) ctx.publish(execution.events.attemptFinishedV1, v1);
    },
  );

  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: executionMigrations,
    registrations: [recordAttemptOutcome, attemptWorker],
    resources: {
      collections: ["step-attempts", "workspaces"],
      queues: ["agent-workers"],
      tables: [
        "attempt_cancellations",
        "attempt_requests",
        "attempt_result_metadata",
        "attempt_results",
        "step_attempts",
        "workspace_lifecycle",
        "workspaces",
      ],
    },
    calls: {
      async cancelAttempt(ctx, input) {
        await (ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>)
          .insertInto("attempt_cancellations")
          .values({ attempt_id: input.attemptId, cancelled_at: input.cancelledAt })
          .onConflict((conflict) => conflict.column("attempt_id").doNothing())
          .execute();
        activeControllers.get(input.attemptId)?.abort();
        await agentRuntime.cancel(input.attemptId);
        return true;
      },
      async getAttemptProtocol(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const attempt = await db
          .selectFrom("step_attempts")
          .select("attempt_id")
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        if (attempt === undefined) return null;
        const request = await db
          .selectFrom("attempt_requests")
          .select("protocol_version")
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        return request?.protocol_version === 2 || request?.protocol_version === 3 ? "v2" : "v1";
      },
      async getAttemptProtocolV2(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const attempt = await db
          .selectFrom("step_attempts")
          .select("attempt_id")
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        if (attempt === undefined) return null;
        const request = await db
          .selectFrom("attempt_requests")
          .select("protocol_version")
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        return request?.protocol_version === 3
          ? "v3"
          : request?.protocol_version === 2
            ? "v2"
            : "v1";
      },
      async requestAttempt(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const requestJson = canonicalJson(input);
        const existing = await db
          .selectFrom("step_attempts")
          .selectAll()
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        if (existing !== undefined) {
          const existingRequest = await db
            .selectFrom("attempt_requests")
            .selectAll()
            .where("attempt_id", "=", input.attemptId)
            .executeTakeFirst();
          const pinMismatch =
            existingRequest === undefined
              ? existing.correlation_token !== input.correlationToken ||
                existing.run_id !== input.runId ||
                existing.step_id !== input.stepId ||
                existing.agent_profile_digest !== input.agentProfile.digest ||
                existing.started_at !== input.startedAt ||
                existing.input_artifact_digests_json !==
                  canonicalJson(input.inputArtifactDigests) ||
                existing.skill_digests_json !== canonicalJson(input.skillDigests)
              : existingRequest.protocol_version !== 1 ||
                existingRequest.request_json !== requestJson;
          if (pinMismatch)
            throw new Error("attempt_exists: immutable attempt identity has different pins");
          return attemptV1FromV2(await attemptFromRow(db, existing));
        }
        const row = legacyRow(input);
        await db.insertInto("step_attempts").values(row).execute();
        await insertRequest(db, input.attemptId, 1, requestJson);
        await insertWorkspace(db, input.attemptId, input.startedAt);
        const attempt = await attemptFromRow(db, row);
        await ctx.enqueue("agent-workers", { attemptId: input.attemptId, protocolVersion: 1 });
        ctx.publish(execution.events.attemptQueuedV1, attempt);
        return attemptV1FromV2(attempt);
      },
      async requestAttemptV2(ctx, rawInput) {
        const input = parseAgentRequest(rawInput);
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const requestJson = canonicalJson(input);
        const existing = await db
          .selectFrom("step_attempts")
          .selectAll()
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        if (existing !== undefined) {
          const existingRequest = await db
            .selectFrom("attempt_requests")
            .selectAll()
            .where("attempt_id", "=", input.attemptId)
            .executeTakeFirst();
          if (
            existingRequest?.protocol_version !== 2 ||
            existingRequest.request_json !== requestJson
          )
            throw new Error("attempt_exists: immutable attempt identity has different pins");
          return await attemptFromRowV3(db, existing);
        }
        const row = strictRow(input);
        await db.insertInto("step_attempts").values(row).execute();
        await insertRequest(db, input.attemptId, 2, requestJson);
        await insertWorkspace(db, input.attemptId, input.startedAt);
        const attempt = await attemptFromRowV3(db, row);
        await ctx.enqueue("agent-workers", { attemptId: input.attemptId, protocolVersion: 2 });
        ctx.publish(execution.events.attemptQueuedV2, input);
        ctx.publish(execution.events.attemptQueuedV1, stepAttemptV2.parse(attempt));
        return attempt;
      },
      async requestAttemptV3(ctx, rawInput) {
        const input = parseAgentRequestV2(rawInput);
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const requestJson = canonicalJson(input);
        const existing = await db
          .selectFrom("step_attempts")
          .selectAll()
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        if (existing !== undefined) {
          const existingRequest = await db
            .selectFrom("attempt_requests")
            .selectAll()
            .where("attempt_id", "=", input.attemptId)
            .executeTakeFirst();
          if (
            existingRequest?.protocol_version !== 3 ||
            existingRequest.request_json !== requestJson
          )
            throw new Error("attempt_exists: immutable attempt identity has different pins");
          return await attemptFromRowV3(db, existing);
        }
        const row = strictRow(input);
        await db.insertInto("step_attempts").values(row).execute();
        await insertRequest(db, input.attemptId, 3, requestJson);
        await insertWorkspace(db, input.attemptId, input.startedAt);
        const attempt = await attemptFromRowV3(db, row);
        await ctx.enqueue("agent-workers", { attemptId: input.attemptId, protocolVersion: 3 });
        ctx.publish(execution.events.attemptQueuedV3, input);
        ctx.publish(execution.events.attemptQueuedV1, stepAttemptV2.parse(attempt));
        return attempt;
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
      async getAttemptV3(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<ExecutionDatabase>;
        const row = await db
          .selectFrom("step_attempts")
          .selectAll()
          .where("attempt_id", "=", input.attemptId)
          .executeTakeFirst();
        return row === undefined ? null : await attemptFromRowV3(db, row);
      },
    },
  });
}

function legacyRow(input: {
  agentProfile: { digest: string };
  attemptId: string;
  correlationToken: string;
  inputArtifactDigests: string[];
  runId: string;
  skillDigests: Record<string, string>;
  startedAt: string;
  stepId: string;
}): StepAttemptRow {
  return {
    agent_profile_digest: input.agentProfile.digest,
    attempt_id: input.attemptId,
    correlation_token: input.correlationToken,
    finished_at: null,
    input_artifact_digests_json: canonicalJson(input.inputArtifactDigests),
    outcome: "pending",
    run_id: input.runId,
    skill_digests_json: canonicalJson(input.skillDigests),
    started_at: input.startedAt,
    step_id: input.stepId,
  };
}

function strictRow(input: AgentRequest): StepAttemptRow {
  return {
    agent_profile_digest: input.agentProfile.digest,
    attempt_id: input.attemptId,
    correlation_token: input.correlationToken,
    finished_at: null,
    input_artifact_digests_json: canonicalJson(input.inputArtifacts.map(({ digest }) => digest)),
    outcome: "pending",
    run_id: input.runId,
    skill_digests_json: canonicalJson(
      Object.fromEntries(input.skills.map((skill) => [skill.id, skill.digest])),
    ),
    started_at: input.startedAt,
    step_id: input.stepId,
  };
}

async function insertRequest(
  db: Kysely<ExecutionDatabase>,
  attemptId: string,
  protocolVersion: number,
  requestJson: string,
): Promise<void> {
  await db
    .insertInto("attempt_requests")
    .values({
      attempt_id: attemptId,
      protocol_version: protocolVersion,
      request_digest: createHash("sha256").update(requestJson).digest("hex"),
      request_json: requestJson,
    })
    .execute();
}

async function insertWorkspace(
  db: Kysely<ExecutionDatabase>,
  attemptId: string,
  createdAt: string,
): Promise<void> {
  await db
    .insertInto("workspaces")
    .values({
      attempt_id: attemptId,
      created_at: createdAt,
      status: "queued",
      workspace_id: `workspace:${attemptId}`,
    })
    .execute();
  await db
    .insertInto("workspace_lifecycle")
    .values({
      attempt_id: attemptId,
      cleaned_at: null,
      debug_retained: 0,
      finished_at: null,
      path: null,
      ready_at: null,
    })
    .execute();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function infrastructureResult(
  request: Pick<AgentRequest, "attemptId" | "startedAt">,
  category: "adapter" | "cancel" | "result-invalid",
  message: string,
  finished: Date,
): AgentResult {
  const started = new Date(request.startedAt);
  const safeStarted = Number.isNaN(started.getTime()) ? finished : started;
  return {
    attemptId: request.attemptId,
    changedFiles: [],
    failure: { category, message: message.slice(0, 8_192), retriable: category === "adapter" },
    logs: {
      stderrBytes: 0,
      stderrDigest: EMPTY_DIGEST,
      stderrTruncated: false,
      stdoutBytes: 0,
      stdoutDigest: EMPTY_DIGEST,
    },
    resources: { cpuMs: 0, maxRssBytes: 0 },
    status: "failed",
    tests: [],
    timing: {
      durationMs: Math.max(0, finished.getTime() - safeStarted.getTime()),
      finishedAt: finished.toISOString(),
      startedAt: safeStarted.toISOString(),
    },
  };
}

export const executionImplementation = createExecutionImplementation();
