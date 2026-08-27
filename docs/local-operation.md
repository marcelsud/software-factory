# Local factory operation and recovery

This guide covers the checked `factory.yaml` contract and the local daemon. See [run-once operation](run-once.md) for one-shot execution and [the future Actions adapter contract](github-actions-adapter.md) for multi-runner composition.

## Factory definition schema

A definition is strict, versioned, data-only YAML. Unknown keys, YAML tags, executable configuration, duplicate IDs, unresolved references, and incompatible graphs are rejected before activation.

Top-level fields are:

- `version` and `dryRun`;
- `repositories`, each with `id`, `owner`, `name`, `defaultBranch`, and `localPath`;
- `sources`, each with `id`, `type`, `repository`, enabled `events`, and an optional `schedule`;
- `capabilities` and `effectPermissions`, which bind a capability to allowed `targets`, `flows`, `agentProfiles`, and effect kinds;
- `skills`, each pinned by `id`, `path`, and immutable `revision` digest;
- `agentProfiles`, which declare `model`, `command`, trusted `instructions`, resource `limits`, `skills`, and `capabilities`;
- `flows`, which declare `id`, `initialState`, `triggers`, `concurrency`, optional bounded `retriage`, declared `artifactHandoffs`, `steps`, `gates`, `states`, and `transitions`.

Every reference must resolve. State IDs are unique, the initial state exists, transitions name declared outcomes, terminal states declare success or failure, and every nonterminal path can reach a terminal state or an explicit gate. Step capabilities must be a subset of the selected agent profile and pinned skill. Effects require a matching checked permission. Artifact input is restricted to `artifactHandoffs`. A run pins the definition, flow, agent profiles, skills, Chimpbase module manifest, workflow version, and repository revision when it starts; later file changes do not mutate an active run.

Use `factory validate --config factory.yaml`, `factory plan --config factory.yaml --json`, and `chimpbase modules check` before activation.

## Issue-triage state machine

The checked flow executes these states in order on the positive path:

`reproduce` → `diagnose` → `verify-diagnosis` → `fix` → `verify-patch` → `label-fix-verified` → `publish-branch` → `publish-comment` → `label-fix-pending` → `confirm` → `pr-writer` → `publish-pr` → `done`.

`reproduce`, `diagnose`, `fix`, and `pr-writer` use the triage or writer profile. Both verification states use the independent verification profile. Each step gets a fresh attempt ID, its pinned skill digest, and only declared artifact handoffs. `fix` requires failing-then-passing test evidence (or a declared reproduction exception) before a patch can advance.

The legacy `approve-fix` gate at state `approve` is the deterministic approval gate. The current `confirm-fix` gate at state `confirm` accepts `operator.approve`, `operator.reject`, `operator.cancel`, the configured approval/rejection labels, approval/rejection/new-evidence comments, issue closure, and `confirmation.timeout`. Approval advances to PR metadata and publication. Rejection or new evidence runs the matching factory-owned branch cleanup and bounded retriage. Cancellation/issue closure ends as `cancelled`; timeout ends as `fix_rejected`. Gate identity and correlation token must match, and repeated signals are idempotent.

Early terminal states and outcomes are `not-actionable`/`not_actionable`, `needs-reproduction`/`needs_reproduction`, `skipped`/`skipped`, `unable-to-reproduce`/`unable_to_reproduce`, `intended-behavior`/`intended_behavior`, `unable-to-fix`/`unable_to_fix`, `fix-rejected`/`fix_rejected`, `failed`/`failed`, `verification-failed`/`failed`, `rejected`/`failed`, `cancelled`/`cancelled`, and `done`/`completed`. A negative verification ends before `fix`, patch publication, or any external effect.

Cleanup states are `cleanup-rejected`, `cleanup-evidence`, `cleanup-cancel`, and `cleanup-timeout`. The compatibility-only `legacy-publish` state remains pinned for older runs but is not selected by the current strict result contract. The signal-only `retriage-fix` gate bounds retriage to the configured maximum.

## Start, stop, and health

Set `FACTORY_DB_PATH` to a durable SQLite file and configure adapter credentials outside the definition. Start one resident local process with:

```sh
factory daemon --config factory.yaml
```

For a controlled single poll and full worker drain, use `factory daemon --once --config factory.yaml`. The daemon acquires its lock before opening the app, activates the checked definition, starts the Chimpbase worker, long-polls enabled GitHub repositories, refreshes the worker heartbeat, and drains durable work. Stop it with `SIGINT` or `SIGTERM`; shutdown aborts polling, stops the worker, closes the host, and releases the daemon lock.

Check `factory status --json` for storage, workflow, worker, poll lag, pending/unreconciled effects, credentials, repository reachability, and stale locks. `factory doctor --json` additionally checks configuration, `chimpbase modules check`, daemon lock state, repositories, credentials, and unreconciled effects without applying writes.

Inspect and control the same durable state with:

```sh
factory runs --status waiting --json
factory show <run-id> --json
factory events --run <run-id> --json
factory effects --run <run-id> --json
factory pause <run-id> --actor <name>
factory resume <run-id> --actor <name>
factory retry <run-id> --actor <name>
factory approve <run-id> --actor <name> --gate <gate-id> --correlation <token>
factory reject <run-id> --actor <name> --gate <gate-id> --correlation <token>
factory cancel <run-id> --actor <name>
```

Every mutation has an idempotent command key and an audit record. Operators never edit SQLite directly.

## Recovery by durable state

Always retain the same database and artifact store, then inspect `factory show`, `factory effects`, `factory status`, and `factory doctor` before acting.

| Observed state | Recovery |
|---|---|
| Runnable or active attempt | Restart the daemon. The workflow and queued worker job resume. Do not start a second daemon or manufacture an attempt. `pause` prevents new claims without invalidating an active lease; `resume` restores eligibility. |
| Waiting gate | Supply the named gate and correlation token through `approve`/`reject`, or ingest the declared event signal. Repeating the same command key or delivery is safe. |
| Retry-delayed | Correct the reported infrastructure problem, wait until the recorded retry time, and restart. Use audited `retry` only after the failed attempt is durably retry-eligible; the old attempt and artifacts remain. |
| Effect pending or ambiguous | Restore the owning GitHub/git adapter and restart. The effects module probes/reconciles its idempotency key and receipt before applying; never issue the write manually. |
| Stale workflow/worker lease | Stop competing processes, allow the recorded lease to expire, then restart one daemon. Chimpbase reacquires the lease; do not edit lease rows. |
| Stale daemon lock | Verify that no daemon owns it, run `factory doctor`, remove only the stale lock file according to the local lock procedure, and start one daemon. Never remove an active lock. |
| Cancelled/terminal | Inspect the audit trail. `cancel` blocks unpublished effects. Start a new delivery or manual trigger only when new work is intended; do not mutate the terminal run. |

Crash recovery relies on atomic event acceptance and cursor compare-and-swap. A poll crash rolls back both facts and cursor; the next overlap poll rereads them. Accepted deliveries, operator commands, and effect receipts are deduplicated.

## Replay export, import, and run

Export a replay bundle through `operations/exportReplayBundle@v1` for the selected run. The bundle pins the definition, flow, agent profiles, skills, module manifest, workflow version, public artifacts, captured source facts, deterministic clock/ID values, fake agent results, and fake effect results. Store or transfer it through `operations/importReplayBundle@v1`; assets verifies its content digest.

Run the checked bundle with:

```sh
factory replay replay-bundle.json --config factory.yaml --json
```

Replay boots the real app in memory with deterministic fake GitHub read/write, fake agent, fake git publisher, and memory artifact adapters. It rejects pin drift, transition/effect drift, duplicate effects, extra capabilities, and any live adapter selection; `liveWrites` must be zero. Public replay data is size-bounded and redacts credentials, prompts, hidden reasoning, private reports/logs, private artifact bytes, and configured secret markers. Keep raw private evidence only under the configured retention policy.
