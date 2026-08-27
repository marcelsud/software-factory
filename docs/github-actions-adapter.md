# Future GitHub Actions adapter contract

This repository does not ship a GitHub Actions workflow, `action.yml`, composite action, JavaScript action bundle, marketplace package, or hosted backend selector. A future adapter is only a process wrapper: it must produce the documented run-once invocation envelope and call `factory run-once`. It must not change module contracts, workflow versions, flow selection, retries, gates, effects, or recovery semantics.

The adapter preserves the definition, state machine, recovery, and replay rules in [local factory operation and recovery](local-operation.md) and the process contract in [run-once operation](run-once.md).

## Job sequence

1. Check out the exact repository revision that contains `factory.yaml`, pinned skills, and the factory executable. Do not execute configuration from the event payload.
2. Validate `factory.yaml` and the invocation envelope before opening credentials or storage.
3. Run `chimpbase modules check` against the checked composition. A compatibility failure stops the job; the adapter must not generate or rewrite module contracts.
4. Select trusted runtime, storage, workspace, artifact root/export, and credential providers from action inputs or administrator-controlled configuration. None can come from issue or comment content.
5. Call `factory run-once --event <file> --config <path> --json` with explicit bounds and infrastructure options.
6. Publish only files in the public artifact export and map the bounded result to declared action outputs.

## Least-privilege permissions

Permissions are separated by capability and are not granted to the agent process:

- GitHub issue and comment ingestion needs `contents: read` and `issues: read` (plus `pull-requests: read` only when a checked flow consumes pull-request metadata).
- GitHub issue labels/comments and pull-request publication need narrowly enabled `issues: write` or `pull-requests: write` only in the effect adapter step. Read-only jobs must omit these grants.
- Git push needs `contents: write` only in the verified git publisher step. It is distinct from GitHub API write permission and must remain unavailable to agent attempts.
- Future cloud identity uses `id-token: write` only when an administrator-selected OIDC exchange is required for shared storage, artifact storage, or another infrastructure provider. OIDC is not a GitHub content permission and is omitted otherwise.

Use a short-lived GitHub App installation token where possible. A job token, App token, git credential, cloud token, or OIDC assertion is injected only into its owning adapter. Secrets are not written into the event envelope, workspace handed to agents, cache key, artifact, command output, or run-once JSON. GitHub read, GitHub write, git push, and cloud/storage credentials remain separate even when one workflow job hosts all adapters.

## Concurrency and durable storage

Map Actions concurrency to the factory concurrency key `repository/subject/flow`. Actions serialization is an optimization, not the correctness boundary; Chimpbase admission and idempotency remain authoritative. Do not cancel an in-progress job merely because another delivery uses the same key unless the factory result explicitly permits cancellation.

A single local runner may use a persistent SQLite path that survives later invocations. Resumable ephemeral runners, matrix jobs, and every multi-runner deployment require shared PostgreSQL (or another equally durable adapter explicitly supported by Chimpbase) plus shared durable artifact storage. Never place SQLite in an ephemeral checkout or assume a local polling cursor or resident daemon will resume work.

## Artifacts, outputs, and recovery

Upload only the explicit public artifact export directory. Keep raw agent logs, prompts/reasoning, private reports, worktrees, database files, and private artifact storage out of Actions artifacts. Preserve digest, media type, logical name, run ID, and the `artifact://` reference when mapping uploaded artifacts.

Declare bounded outputs for `result-class`, `exit-code`, `run-ids`, `outcome`, `concurrency-key`, `pending`, `public-artifacts`, `effect-receipts`, and truncation indicators. Preserve run-once exit codes: 0 for completed/waiting/no-match, 75 for retryable infrastructure failure, 77 for policy rejection, and 1 for terminal failure. Do not reinterpret waiting as failure or hide nonzero results with shell error suppression.

On waiting, retry-delayed, or effect-pending results, retain the shared database and artifact store and schedule a later invocation with the same delivery, definition revision, and configuration. On runner loss, invoke again against the shared store; delivery and effect idempotency resume existing state. Policy rejection requires a policy/permission correction, not a direct write. Terminal failure is recovered only through the factory's audited operator commands. A future adapter may upload diagnostic operations projections, but it must apply the same redaction and output bounds.
