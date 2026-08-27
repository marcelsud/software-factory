# Software factory domain language

- **Factory definition:** Versioned declaration of event sources, flows, agent profiles, skill references, capabilities, and effect permissions. A run pins one immutable revision.
- **Event source:** Declared origin of observations that can start a flow, such as a GitHub event, manual request, or schedule.
- **Factory event:** Normalized, immutable observation accepted from an event source. It retains source and delivery identity and an untrusted payload snapshot.
- **Flow definition:** Directed set of states, steps, transitions, gates, retry policy, and concurrency policy that describes how a factory event is handled.
- **Run:** One execution of a flow for a factory event. It pins all definition, profile, skill, and execution-version revisions used by that execution.
- **Step attempt:** One bounded attempt to perform a step in a run. A correlation token distinguishes the current attempt from stale results.
- **Agent profile:** Digest-pinned declaration of provider-neutral model and command selection, instructions, execution limits, allowed skills, and capabilities for agent steps.
- **Skill revision:** Immutable, digest-identified revision of instructions or supporting material resolved from a skill reference.
- **Artifact:** Immutable, digest-addressed output associated with a run and classified as public or private.
- **Gate:** Flow state that waits for one of its declared event, signal, or operator-command kinds before the run can continue.
- **Effect:** Authorized intent to change external state, identified by a deterministic key and completed with a reconcilable receipt.
- **Operator command:** Idempotent, identified instruction from an operator to approve, reject, cancel, or retry a run.
