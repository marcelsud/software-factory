import { type ChimpbaseModuleInterface, defineChimpbaseModuleImplementation } from "chimpbase/core";
import type { Kysely } from "kysely";

import { compileFactoryDefinition } from "../../compiler.ts";
import { definitionRevision, executionPlan } from "../../contracts/index.ts";
import {
  type DefinitionsDatabase,
  definitionsMigrations,
} from "../../storage/definitions-database.ts";
import { definitions } from "./interface.ts";

const implementationInterface = definitions as unknown as ChimpbaseModuleInterface<
  typeof definitions.calls,
  typeof definitions.events
>;

async function resolveStoredRevision(db: Kysely<DefinitionsDatabase>, definitionDigest: string) {
  const row = await db
    .selectFrom("definition_revisions")
    .selectAll()
    .where("definition_digest", "=", definitionDigest)
    .executeTakeFirst();
  if (row === undefined) return null;
  return definitionRevision.parse({
    definitionDigest: row.definition_digest,
    flowDigests: Object.fromEntries(
      (
        await db
          .selectFrom("flow_revisions")
          .select(["flow_id", "flow_digest"])
          .where("definition_digest", "=", definitionDigest)
          .execute()
      ).map((flow) => [flow.flow_id, flow.flow_digest]),
    ),
    normalizedJson: row.normalized_json,
    sourceName: row.source_name,
  });
}

export function createDefinitionsImplementation() {
  return defineChimpbaseModuleImplementation({
    interface: implementationInterface,
    migrations: definitionsMigrations,
    resources: {
      collections: [
        "agent-profile-revisions",
        "definition-revisions",
        "execution-plans",
        "flow-revisions",
      ],
      tables: [
        "agent_profile_revisions",
        "definition_revisions",
        "execution_plans",
        "flow_revisions",
      ],
    },
    calls: {
      async compileDefinition(ctx, input) {
        const compiled = compileFactoryDefinition(input.source, { sourceName: input.sourceName });
        const db = ctx.db.kysely() as unknown as Kysely<DefinitionsDatabase>;
        const existing = await resolveStoredRevision(db, compiled.revision.definitionDigest);
        if (existing !== null) return existing;

        await db
          .insertInto("definition_revisions")
          .values({
            definition_digest: compiled.revision.definitionDigest,
            normalized_json: compiled.revision.normalizedJson,
            source_name: compiled.revision.sourceName,
          })
          .execute();
        for (const [flowId, plan] of Object.entries(compiled.plans)) {
          await db
            .insertInto("execution_plans")
            .values({
              definition_digest: plan.definitionDigest,
              flow_digest: plan.flowDigest,
              flow_id: flowId,
              plan_json: JSON.stringify(plan),
            })
            .execute();
          await db
            .insertInto("flow_revisions")
            .values({
              definition_digest: plan.definitionDigest,
              flow_digest: plan.flowDigest,
              flow_id: flowId,
              normalized_json: plan.normalizedJson,
            })
            .execute();
          for (const [profileId, profile] of Object.entries(plan.agentProfiles)) {
            const digest = plan.agentProfileDigests[profileId];
            if (digest === undefined) {
              throw new Error(`invalid_definition: missing digest for ${profileId}`);
            }
            await db
              .insertInto("agent_profile_revisions")
              .values({
                digest,
                profile_json: JSON.stringify(profile),
              })
              .onConflict((conflict) => conflict.column("digest").doNothing())
              .execute();
          }
        }
        ctx.publish(definitions.events.definitionPublishedV1, compiled.revision);
        return compiled.revision;
      },
      async resolveRevision(ctx, input) {
        return await resolveStoredRevision(
          ctx.db.kysely() as unknown as Kysely<DefinitionsDatabase>,
          input.definitionDigest,
        );
      },
      async getExecutionPlan(ctx, input) {
        const db = ctx.db.kysely() as unknown as Kysely<DefinitionsDatabase>;
        const row = await db
          .selectFrom("execution_plans")
          .select("plan_json")
          .where("definition_digest", "=", input.definitionDigest)
          .where("flow_id", "=", input.flowId)
          .executeTakeFirst();
        return row === undefined ? null : executionPlan.parse(JSON.parse(row.plan_json));
      },
    },
  });
}

export const definitionsImplementation = createDefinitionsImplementation();
