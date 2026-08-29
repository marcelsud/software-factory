import type { FactoryEvent, RunOnceInvocationEnvelope } from "../contracts/index.ts";
import { parseRunOnceInvocationEnvelope } from "../contracts/index.ts";
import { GitHubEventNormalizer } from "./github-event-normalizer.ts";

export interface EventSourceAdapter<TEnvelope> {
  normalize(envelope: TEnvelope): readonly FactoryEvent[];
}

export class GitHubInvocationEventSource implements EventSourceAdapter<RunOnceInvocationEnvelope> {
  readonly #normalizer: GitHubEventNormalizer;

  constructor(normalizer = new GitHubEventNormalizer()) {
    this.#normalizer = normalizer;
  }

  normalize(value: RunOnceInvocationEnvelope): readonly FactoryEvent[] {
    const envelope = parseRunOnceInvocationEnvelope(value);
    const payload = value.payload as Record<string, unknown>;
    return this.#normalizer.normalize({
      kind: "actions",
      observedAt: envelope.observedAt,
      payload: {
        ...payload,
        action: envelope.event.action,
        repository: {
          ...(payload.repository as Record<string, unknown>),
          full_name: envelope.repository.fullName,
        },
        sender: {
          ...(payload.sender as Record<string, unknown> | undefined),
          login: envelope.actor.login,
          type: envelope.actor.type === "bot" ? "Bot" : "User",
        },
      },
      repositoryId: envelope.repository.id,
    });
  }
}
