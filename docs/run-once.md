# Run-once operation

`factory run-once` is a one-shot process adapter around the same `createSoftwareFactoryApp` composition, Chimpbase modules, `factory-runs-v2` workflow, intake action, and operations projections used by `factory daemon`. It does not run a resident service or use a daemon lock, polling cursor, terminal, or process-global application instance.

## Invocation

The event file is a strict data-only JSON envelope. It identifies the repository, issue subject, GitHub delivery, event name/action, actor, installation metadata, invocation context, checked definition revision, correlation ID, observation time, and the untrusted GitHub payload. Unknown envelope keys, mismatched payload identities, invalid event/action pairs, non-UTC timestamps, and oversized payloads are rejected before storage or adapters are opened. Adapter names, commands, credentials, secrets, and environment configuration are not accepted from the event file.

All infrastructure choices are trusted command inputs:

```text
factory run-once \
  --event event.json \
  --config factory.yaml \
  --storage-engine sqlite --storage-path .factory/factory.sqlite \
  --agent-runtime local-process --agent-bin /usr/bin/node \
  --workspace-root .factory/workspaces \
  --artifact-root .factory/artifacts --artifact-export .factory/public \
  --credentials environment \
  --max-duration-ms 30000 --max-work 100 --json
```

Use `--credentials none` for a composition that must not read GitHub credentials. SQLite is suitable for one local runner. PostgreSQL is selected with `--storage-engine postgres --storage-url <url>` and is required for multi-runner operation. Memory storage is intentionally unavailable to the production command. Workspace, artifact storage, and public artifact export paths are explicit; private artifact bytes are never exported.

The process validates and pins the checked definition, normalizes the invocation through the GitHub EventSource adapter, calls `intake/acceptSourceEventV2@v1`, and performs a bounded Chimpbase worker drain. It stops when work is terminal, quiescent, waiting at a gate, delayed for retry, effect-pending, or when the explicit work/duration bound is reached. The host is then closed. A later invocation against the same SQLite database or shared PostgreSQL store resumes durable waiting, retry, workflow, and effect state.

## Results and recovery

JSON output is canonical, redacted, and limited to 256 KiB and 100 entries per collection. It contains result class and exit code, run IDs, product outcome, repository/subject/flow concurrency key, pending gate/retry/effect state, public artifact references, effect intents and receipts, invocation metadata, transition summaries, and truncation counts. It excludes credentials, tokens, prompts, reasoning, private logs, and private artifact bytes.

| Result class | Exit code | Operator action |
|---|---:|---|
| `completed` | 0 | Consume outputs. |
| `waiting` | 0 | Preserve the store; invoke later after the gate, retry time, or effect dependency is available. |
| `no-match` | 0 | No checked flow matched the normalized event. |
| `retryable-infrastructure-failure` | 75 | Restore infrastructure and invoke again with the same durable store and delivery. |
| `policy-rejection` | 77 | Correct policy or permissions; do not bypass the effect policy. |
| `terminal-failure` | 1 | Inspect redaction-safe operations events and recover through supported operator commands. |

Delivery acceptance and effects are idempotent. Recovery must reuse the configured durable store, the same definition revision, and the same delivery identity. Deleting the store, changing the pinned definition, or replaying with a different delivery creates different semantics and is not recovery.
