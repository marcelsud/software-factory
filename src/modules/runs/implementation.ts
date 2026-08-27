import { createHash } from "node:crypto";
import {
  type ChimpbaseModuleInterface,
  chimpbaseModuleResourcePrefix,
  defineChimpbaseModuleImplementation,
  defineChimpbaseModuleSubscription,
} from "chimpbase/core";
import { type Infer, workflow } from "chimpbase/runtime";
import type { Kysely } from "kysely";

import {
  type Run,
  type RunV2,
  run,
  runFinished,
  runFinishedV2,
  runV2,
} from "../../contracts/index.ts";
import { type RunRow, type RunsDatabase, runsMigrations } from "../../storage/runs-database.ts";
import { definitions } from "../definitions/interface.ts";
import { effects } from "../effects/interface.ts";
import { execution } from "../execution/interface.ts";
import { runs } from "./interface.ts";

const implementationInterface = runs as unknown as ChimpbaseModuleInterface<
  typeof runs.calls,
  typeof runs.events
>;

const factoryRunWorkflow = workflow<{ runId: string }, { phase: "waiting" | "done" }>({
  name: "factory-runs",
  version: 1,
  initialState: () => ({ phase: "waiting" }),
  run(ctx) {
    if (ctx.state.phase === "done") return ctx.complete(ctx.state);
    return ctx.waitForSignal("finish", {
      state: ctx.state,
      onSignal: () => ({ phase: "done" }),
    });
  },
});

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  );
}

type StartRunV2Input = Infer<typeof runs.calls.startRunV2.input>;

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function scopedWorkflowId(workflowId: string): string {
  const prefix = chimpbaseModuleResourcePrefix("runs", "workflow-instance");
  return workflowId.startsWith(prefix) ? workflowId : `${prefix}${workflowId}`;
}

function sameRunIdentity(
  row: RunRow,
  input: StartRunV2Input,
  initialCorrelationJson: string,
): boolean {
  return (
    row.run_id === input.runId &&
    row.factory_event_id === input.factoryEventId &&
    row.workflow_id === scopedWorkflowId(input.workflowId) &&
    row.workflow_version === input.workflowVersion &&
    row.workflow_version_digest === input.workflowVersionDigest &&
    row.definition_digest === input.definitionDigest &&
    row.flow_id === input.flowId &&
    row.flow_digest === input.flowDigest &&
    recordsEqual(JSON.parse(row.agent_profile_digests_json), input.agentProfileDigests) &&
    recordsEqual(JSON.parse(row.skill_digests_json), input.skillDigests) &&
    row.module_manifest_digest === input.moduleManifestDigest &&
    row.started_at === input.startedAt &&
    initialCorrelationJson === JSON.stringify(input.correlation ?? null)
  );
}

async function loadInitialCorrelation(db: Kysely<RunsDatabase>, runId: string): Promise<string> {
  const identity = await db
    .selectFrom("run_identities")
    .select("initial_correlation_json")
    .where("run_id", "=", runId)
    .executeTakeFirst();
  if (identity === undefined) throw new Error("run_exists: immutable run identity is missing");
  return identity.initial_correlation_json;
}

function runFromRow(row: RunRow): RunV2 {
  return runV2.parse({
    agentProfileDigests: JSON.parse(row.agent_profile_digests_json),
    auditSequence: row.audit_sequence,
    ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
    ...(row.current_correlation_token === null
      ? {}
      : { currentCorrelationToken: row.current_correlation_token }),
    ...(row.current_effect_key === null ? {} : { currentEffectKey: row.current_effect_key }),
    ...(row.current_gate_id === null ? {} : { currentGateId: row.current_gate_id }),
    ...(row.current_gate_status === null ? {} : { currentGateStatus: row.current_gate_status }),
    ...(row.current_step_id === null ? {} : { currentStepId: row.current_step_id }),
    definitionDigest: row.definition_digest,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    factoryEventId: row.factory_event_id,
    flowDigest: row.flow_digest,
    flowId: row.flow_id,
    moduleManifestDigest: row.module_manifest_digest,
    runId: row.run_id,
    skillDigests: JSON.parse(row.skill_digests_json),
    startedAt: row.started_at,
    stateId: row.state_id,
    status: row.status,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    workflowVersionDigest: row.workflow_version_digest,
  });
}
function runV1FromV2(value: RunV2): Run {
  return run.parse({
    agentProfileDigests: value.agentProfileDigests,
    definitionDigest: value.definitionDigest,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    factoryEventId: value.factoryEventId,
    flowDigest: value.flowDigest,
    flowId: value.flowId,
    moduleManifestDigest: value.moduleManifestDigest,
    runId: value.runId,
    skillDigests: value.skillDigests,
    startedAt: value.startedAt,
    stateId: value.stateId,
    status: value.status === "paused" ? "waiting" : value.status,
    workflowVersionDigest: value.workflowVersionDigest,
  });
}

function finishedFromRun(value: RunV2) {
  if (
    value.finishedAt === undefined ||
    !["succeeded", "failed", "cancelled"].includes(value.status)
  ) {
    throw new Error("run is not terminal");
  }
  return runFinishedV2.parse({
    agentProfileDigests: value.agentProfileDigests,
    auditSequence: value.auditSequence,
    definitionDigest: value.definitionDigest,
    factoryEventId: value.factoryEventId,
    finishedAt: value.finishedAt,
    flowDigest: value.flowDigest,
    flowId: value.flowId,
    moduleManifestDigest: value.moduleManifestDigest,
    runId: value.runId,
    skillDigests: value.skillDigests,
    startedAt: value.startedAt,
    stateId: value.stateId,
    status: value.status,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    workflowVersionDigest: value.workflowVersionDigest,
  });
}
function finishedV1FromV2(value: RunV2) {
  const finished = finishedFromRun(value);
  return runFinished.parse({
    agentProfileDigests: finished.agentProfileDigests,
    definitionDigest: finished.definitionDigest,
    factoryEventId: finished.factoryEventId,
    finishedAt: finished.finishedAt,
    flowDigest: finished.flowDigest,
    flowId: finished.flowId,
    moduleManifestDigest: finished.moduleManifestDigest,
    runId: finished.runId,
    skillDigests: finished.skillDigests,
    startedAt: finished.startedAt,
    stateId: finished.stateId,
    status: finished.status,
    workflowVersionDigest: finished.workflowVersionDigest,
  });
}

async function loadRun(db: Kysely<RunsDatabase>, runId: string) {
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();
  return row === undefined ? null : runFromRow(row);
}

async function appendAudit(
  db: Kysely<RunsDatabase>,
  row: RunRow,
  kind: string,
  occurredAt: string,
  payload: unknown,
  patch: Partial<RunRow> = {},
): Promise<RunRow> {
  const sequence = row.audit_sequence + 1;
  await db
    .insertInto("run_audit")
    .values({
      audit_json: JSON.stringify(payload),
      kind,
      occurred_at: occurredAt,
      run_id: row.run_id,
      sequence,
    })
    .execute();
  await db
    .updateTable("runs")
    .set({ ...patch, audit_sequence: sequence })
    .where("run_id", "=", row.run_id)
    .execute();
  return { ...row, ...patch, audit_sequence: sequence };
}

const attemptFinishedSubscription = defineChimpbaseModuleSubscription(
  execution.events.attemptFinishedV1,
  "record-attempt-outcome",
  async (ctx, outcome) => {
    const db = ctx.db.kysely<RunsDatabase>();
    const row = await db
      .selectFrom("runs")
      .selectAll()
      .where("run_id", "=", outcome.runId)
      .executeTakeFirst();
    if (
      row === undefined ||
      isTerminal(row.status) ||
      row.current_attempt_id !== outcome.attemptId ||
      row.current_correlation_token !== outcome.correlationToken
    )
      return false;
    const failed = outcome.outcome === "failed";
    const updated = await appendAudit(
      db,
      row,
      `attempt.${outcome.outcome}`,
      outcome.finishedAt,
      outcome,
      {
        current_attempt_id: null,
        current_correlation_token: failed ? null : row.current_correlation_token,
        current_effect_key: failed ? null : row.current_effect_key,
        current_gate_id: failed ? null : row.current_gate_id,
        current_gate_status: failed ? null : row.current_gate_status,
        current_step_id: failed ? null : row.current_step_id,
        finished_at: failed ? outcome.finishedAt : row.finished_at,
        status: failed ? "failed" : "running",
      },
    );
    const projection = runFromRow(updated);
    ctx.publish(runs.events.runStateChangedV1, runV1FromV2(projection));
    ctx.publish(runs.events.runStateChangedV2, projection);
    if (failed) {
      await ctx.workflow.signal(row.workflow_id, "finish", {});
      ctx.publish(runs.events.runFinishedV1, finishedV1FromV2(projection));
      ctx.publish(runs.events.runFinishedV2, finishedFromRun(projection));
    }
    return true;
  },
);

const effectFinishedSubscription = defineChimpbaseModuleSubscription(
  effects.events.effectFinishedV2,
  "record-effect-outcome",
  async (ctx, outcome) => {
    const db = ctx.db.kysely<RunsDatabase>();
    const row = await db
      .selectFrom("runs")
      .selectAll()
      .where("run_id", "=", outcome.runId)
      .executeTakeFirst();
    if (
      row === undefined ||
      isTerminal(row.status) ||
      row.current_effect_key !== outcome.idempotencyKey ||
      row.current_correlation_token !== outcome.correlationToken
    )
      return false;
    const failed = outcome.outcome === "rejected";
    const updated = await appendAudit(
      db,
      row,
      `effect.${outcome.outcome}`,
      outcome.finishedAt,
      outcome,
      {
        current_attempt_id: failed ? null : row.current_attempt_id,
        current_correlation_token: failed ? null : row.current_correlation_token,
        current_effect_key: outcome.outcome === "ambiguous" ? row.current_effect_key : null,
        current_gate_id: failed ? null : row.current_gate_id,
        current_gate_status: failed ? null : row.current_gate_status,
        current_step_id: failed ? null : row.current_step_id,
        finished_at: failed ? outcome.finishedAt : row.finished_at,
        status: failed ? "failed" : outcome.outcome === "ambiguous" ? "waiting" : "running",
      },
    );
    const projection = runFromRow(updated);
    ctx.publish(runs.events.runStateChangedV1, runV1FromV2(projection));
    ctx.publish(runs.events.runStateChangedV2, projection);
    if (failed) {
      await ctx.workflow.signal(row.workflow_id, "finish", {});
      ctx.publish(runs.events.runFinishedV1, finishedV1FromV2(projection));
      ctx.publish(runs.events.runFinishedV2, finishedFromRun(projection));
    }
    return true;
  },
);

export const runsImplementation = defineChimpbaseModuleImplementation({
  interface: implementationInterface,
  migrations: runsMigrations,
  registrations: [factoryRunWorkflow],
  subscriptions: [attemptFinishedSubscription, effectFinishedSubscription],
  resources: {
    collections: ["operator-commands", "run-gates", "runs", "workflow-signals"],
    tables: [
      "operator_commands",
      "run_audit",
      "run_gates",
      "run_identities",
      "runs",
      "workflow_signals",
    ],
    workflows: ["factory-runs"],
  },
  calls: {
    async startRun(ctx, input) {
      const projection = await ctx.call(runs.calls.startRunV2, {
        ...input,
        workflowId: input.runId,
        workflowVersion: factoryRunWorkflow.definition.version,
      });
      return runV1FromV2(projection);
    },
    async startRunV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<RunsDatabase>;
      const existing = await db
        .selectFrom("runs")
        .selectAll()
        .where("run_id", "=", input.runId)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (!sameRunIdentity(existing, input, await loadInitialCorrelation(db, existing.run_id))) {
          throw new Error("run_exists: immutable run identity has different pins");
        }
        return runFromRow(existing);
      }
      const existingEvent = await db
        .selectFrom("runs")
        .selectAll()
        .where("factory_event_id", "=", input.factoryEventId)
        .executeTakeFirst();
      if (existingEvent !== undefined) {
        if (
          !sameRunIdentity(
            existingEvent,
            input,
            await loadInitialCorrelation(db, existingEvent.run_id),
          )
        ) {
          throw new Error("run_exists: factory event identity has different pins");
        }
        return runFromRow(existingEvent);
      }
      if (input.workflowVersion !== factoryRunWorkflow.definition.version) {
        throw new Error("invalid_revision_pin: unsupported workflow version");
      }
      const plan = await ctx.call(definitions.calls.getExecutionPlan, {
        definitionDigest: input.definitionDigest,
        flowId: input.flowId,
      });
      if (
        plan === null ||
        plan.flowDigest !== input.flowDigest ||
        !recordsEqual(plan.agentProfileDigests, input.agentProfileDigests) ||
        !recordsEqual(plan.skillRevisions, input.skillDigests)
      ) {
        throw new Error("invalid_revision_pin: run pins do not match the compiled execution plan");
      }
      const workflowInstance = await ctx.workflow.start(
        factoryRunWorkflow,
        { runId: input.runId },
        { workflowId: input.workflowId },
      );
      const state = plan.states.find((candidate) => candidate.id === plan.initialState);
      if (state === undefined) throw new Error("invalid_revision_pin: initial state is missing");
      const correlation = input.correlation;
      const gate =
        correlation?.gateId === undefined
          ? undefined
          : plan.gates.find((candidate) => candidate.id === correlation.gateId);
      if (correlation?.gateId !== undefined && gate === undefined) {
        throw new Error("invalid_revision_pin: correlated gate is not declared");
      }
      const row: RunRow = {
        agent_profile_digests_json: JSON.stringify(input.agentProfileDigests),
        audit_sequence: 1,
        current_attempt_id: correlation?.attemptId ?? null,
        current_correlation_token: correlation?.correlationToken ?? null,
        current_effect_key: correlation?.effectKey ?? null,
        current_gate_id: correlation?.gateId ?? null,
        current_gate_status: gate === undefined ? null : "pending",
        current_step_id: correlation?.stepId ?? state.step ?? null,
        definition_digest: input.definitionDigest,
        factory_event_id: input.factoryEventId,
        finished_at: null,
        flow_digest: input.flowDigest,
        flow_id: input.flowId,
        module_manifest_digest: input.moduleManifestDigest,
        run_id: input.runId,
        skill_digests_json: JSON.stringify(input.skillDigests),
        started_at: input.startedAt,
        state_id: plan.initialState,
        status: gate === undefined ? "running" : "waiting",
        workflow_id: workflowInstance.workflowId,
        workflow_version: input.workflowVersion,
        workflow_version_digest: input.workflowVersionDigest,
      };
      await db.insertInto("runs").values(row).execute();
      await db
        .insertInto("run_identities")
        .values({
          initial_correlation_json: JSON.stringify(input.correlation ?? null),
          run_id: input.runId,
        })
        .execute();
      await db
        .insertInto("run_audit")
        .values({
          audit_json: JSON.stringify({ factoryEventId: input.factoryEventId }),
          kind: "run.started",
          occurred_at: input.startedAt,
          run_id: input.runId,
          sequence: 1,
        })
        .execute();
      if (gate !== undefined && correlation !== undefined) {
        await db
          .insertInto("run_gates")
          .values({
            accepted_json: JSON.stringify(gate.accepted),
            correlation_token: correlation.correlationToken,
            gate_id: gate.id,
            kind: gate.kind,
            run_id: input.runId,
            satisfied_at: null,
            satisfied_by: null,
            status: "pending",
          })
          .execute();
      }
      const projection = runFromRow(row);
      ctx.publish(runs.events.runStateChangedV1, runV1FromV2(projection));
      ctx.publish(runs.events.runStateChangedV2, projection);
      if (
        projection.currentStepId !== undefined &&
        projection.currentCorrelationToken !== undefined
      ) {
        ctx.publish(runs.events.stepRequestedV1, {
          correlationToken: projection.currentCorrelationToken,
          runId: projection.runId,
          stepId: projection.currentStepId,
        });
      }
      return projection;
    },
    async getRun(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<RunsDatabase>;
      const projection = await loadRun(db, input.runId);
      return projection === null ? null : runV1FromV2(projection);
    },
    async getRunV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<RunsDatabase>;
      return await loadRun(db, input.runId);
    },
    async applyOperatorCommand(ctx, input) {
      const current = await ctx.call(runs.calls.getRunV2, { runId: input.runId });
      if (current === null) throw new Error("run_not_found");
      const projection = await ctx.call(runs.calls.applyOperatorCommandV2, {
        ...input,
        ...(current.currentCorrelationToken === undefined
          ? {}
          : { correlationToken: current.currentCorrelationToken }),
        ...(current.currentGateId === undefined ? {} : { gateId: current.currentGateId }),
      });
      return runV1FromV2(projection);
    },
    async applyOperatorCommandV2(ctx, input) {
      const db = ctx.db.kysely() as unknown as Kysely<RunsDatabase>;
      const row = await db
        .selectFrom("runs")
        .selectAll()
        .where("run_id", "=", input.runId)
        .executeTakeFirst();
      if (row === undefined) throw new Error("run_not_found");
      const duplicate = await db
        .selectFrom("operator_commands")
        .select(["command_json", "run_id"])
        .where("command_id", "=", input.commandId)
        .executeTakeFirst();
      if (duplicate !== undefined) {
        if (duplicate.command_json !== JSON.stringify(input) || duplicate.run_id !== input.runId) {
          throw new Error("command_not_allowed: command identity has different fields");
        }
        return runFromRow(row);
      }
      if (isTerminal(row.status)) throw new Error("command_not_allowed: run is terminal");

      let patch: Partial<RunRow>;
      if (input.kind === "pause") {
        if (row.status === "paused") throw new Error("command_not_allowed: run is already paused");
        patch = { status: "paused" };
      } else if (input.kind === "resume") {
        if (row.status !== "paused") throw new Error("command_not_allowed: run is not paused");
        patch = { status: row.current_gate_status === "pending" ? "waiting" : "running" };
      } else if (input.kind === "cancel") {
        patch = {
          current_attempt_id: null,
          current_correlation_token: null,
          current_effect_key: null,
          current_gate_id: null,
          current_gate_status: null,
          current_step_id: null,
          finished_at: input.issuedAt,
          status: "cancelled",
        };
      } else if (input.kind === "retry") {
        if (row.current_gate_status === "pending") {
          throw new Error("command_not_allowed: retry cannot bypass a pending gate");
        }
        const token = createHash("sha256")
          .update(`${row.current_correlation_token ?? row.run_id}\0${input.commandId}`)
          .digest("hex");
        patch = { current_correlation_token: token, finished_at: null, status: "running" };
      } else {
        if (
          row.current_gate_id === null ||
          row.current_gate_status !== "pending" ||
          input.gateId !== row.current_gate_id ||
          input.correlationToken !== row.current_correlation_token
        ) {
          throw new Error("command_not_allowed: stale or missing gate correlation");
        }
        const gate = await db
          .selectFrom("run_gates")
          .selectAll()
          .where("run_id", "=", row.run_id)
          .where("gate_id", "=", row.current_gate_id)
          .where("correlation_token", "=", row.current_correlation_token ?? "")
          .executeTakeFirstOrThrow();
        const accepted = JSON.parse(gate.accepted_json) as string[];
        const signal = `operator.${input.kind}`;
        if (!accepted.includes(signal)) throw new Error("command_not_allowed: gate rejects signal");
        await db
          .updateTable("run_gates")
          .set({
            satisfied_at: input.issuedAt,
            satisfied_by: input.commandId,
            status: input.kind === "approve" ? "approved" : "rejected",
          })
          .where("run_id", "=", row.run_id)
          .where("gate_id", "=", row.current_gate_id)
          .where("correlation_token", "=", row.current_correlation_token ?? "")
          .execute();
        patch =
          input.kind === "approve"
            ? { current_gate_status: "approved", status: "running" }
            : {
                current_attempt_id: null,
                current_correlation_token: null,
                current_effect_key: null,
                current_gate_id: null,
                current_gate_status: "rejected",
                current_step_id: null,
                finished_at: input.issuedAt,
                status: "failed",
              };
      }
      await db
        .insertInto("operator_commands")
        .values({
          command_id: input.commandId,
          command_json: JSON.stringify(input),
          issued_at: input.issuedAt,
          kind: input.kind,
          run_id: input.runId,
        })
        .execute();
      await db
        .insertInto("workflow_signals")
        .values({
          correlation_token: input.correlationToken ?? row.current_correlation_token ?? row.run_id,
          identity: input.commandId,
          payload_json: JSON.stringify(input),
          recorded_at: input.issuedAt,
          run_id: input.runId,
          signal_kind: `operator.${input.kind}`,
        })
        .execute();
      const updated = await appendAudit(
        db,
        row,
        `operator.${input.kind}`,
        input.issuedAt,
        input,
        patch,
      );
      const projection = runFromRow(updated);
      if (isTerminal(projection.status)) {
        await ctx.workflow.signal(row.workflow_id, "finish", {});
      }
      ctx.publish(runs.events.runStateChangedV1, runV1FromV2(projection));
      ctx.publish(runs.events.runStateChangedV2, projection);
      if (isTerminal(projection.status)) {
        ctx.publish(runs.events.runFinishedV1, finishedV1FromV2(projection));
        ctx.publish(runs.events.runFinishedV2, finishedFromRun(projection));
      }
      return projection;
    },
  },
});
