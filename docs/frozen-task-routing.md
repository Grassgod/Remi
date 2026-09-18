# Frozen task routing (MUL-333)

A custom-connection task freezes its selected model and connection at first claim.
Changing the Agent's model must not hide a runnable retry behind its newer tasks.
Native tasks have no connection snapshot and continue to use current Agent model
and thinking settings, including the existing authoritative-catalog, alias, pin,
execution-group and save-time validation policies.

## Connection provenance

The internal `multiremi_tasks.execution_runtime_id` records the Runtime that owns
that frozen connection. It is separate from the mutable `runtime_id` dispatch pin,
has no foreign key, survives repooling and retirement, and is inherited by retry.
A regular frozen retry never moves credentials or selects a different upstream.
The separate `runtime_workspace_id` retains a persistent directory binding; it
does not authorize moving that connection to a replacement Runtime. Standalone
workspace retries keep the directory and connection provenance but start a fresh
provider session. Claim and stale reclaim still enforce the workspace daemon,
protocol capability and shared-directory serialization rules.
Retirement can leave it queued with an actionable `wait_reason`; cancel and create
a new task to deliberately select a replacement connection.

Startup backfills missing historical sources only from immutable evidence: an
existing chat-workspace transition's encoded source, or a frozen API-key
credential's Runtime ownership within the task's workspace and provider.
The mutable dispatch pin is never evidence. Legacy environment-auth snapshots
without an encoded source remain unknown even if currently pinned or dispatched;
cancel and recreate these tasks to deliberately choose a connection. The
null-only recovery runs on each startup, including after a rollback to an older
binary, and never overwrites a recorded source.
Explicit Runtime identity merging is different from retirement: it already
re-encrypts and transfers credentials, and transfers this internal identity too.
Explicit chat-workspace transitions retain their existing destination-connection
contract, with the frozen model preserved and destination-local credentials.

## Capabilities and credentials

Credential versions are immutable. Rotation does not substitute the new key into
an existing task; the retained original credential remains usable on its source.
A removed credential waits explicitly. A remotely revoked credential can only be
detected by the provider, whose authentication failure remains an execution error;
there is no automatic key/upstream fallback.

Thinking is still the current Agent setting. Evidence for it must come from the
same normalized upstream identity and the frozen selected model. Display names,
credential IDs and schema metadata do not describe model capability. Endpoint,
authentication mode, environment reference and Claude auth-header changes do.
Without a thinking override, the frozen source connection is executed as recorded,
even if its live default model/catalog later changes. All route permissions still
apply. This exception is specific to an already frozen custom connection; ordinary
pinned tasks retain main's model validation.

## Claim cost and observability

Claim SQL retains workspace/owner, pin/group, plugin, device, lane, capacity and
chat-order guards. Candidate rows are read in pages of 128 preserving existing
priority/time ordering with a stable final key: SQLite rowid preserves its
same-millisecond insertion order; PostgreSQL task ID defines its previously
unspecified tie order. Physical PostgreSQL tuple IDs are not used because
updating a wait reason can move a row during the scan. Agent hydration,
capability decisions and catalog reads are cached for the duration of a claim;
only the chosen task is fully hydrated. No task-ID exclusion list is generated.
Normal paged candidate-query parameter count is bounded regardless of queue length. Reading candidate rows
still scales with the queue, offset pages may rescan earlier rows inside the
database, and distinct requirements require distinct checks.

Frozen-source/credential/protocol problems use the owned wait-reason prefix
`等待冻结执行连接恢复：`, including when retirement leaves no candidates. The existing
capability monitor evaluates the frozen model, requires the same profile
protocol support as claim/reclaim, and clears recovered reasons;
ordinary model waits retain MUL-335's grace period and alert behavior. Existing
Task API/CLI `wait_reason` fields expose these reasons without a new endpoint.

## Claim and observer alignment audit

`runtimeTaskEnvironmentBlocker` is shared by stale-dispatch eligibility and the
queued observer. The normal claim retains equivalent SQL filtering before task
hydration. The observer caches by the complete execution context (including
workspace binding, Issue/Session/Chat, directory ownership, and plugin snapshot),
so two tasks for one Agent cannot mask each other's different requirements.
Routing-eligible candidates rejected by environment gates now produce
`等待执行条件恢复：` after the same
two-minute grace period as model waits, and clear after recovery. This prefix is
owned by `isQueuedCapabilityWaitReason`; human, directory-lock and other reasons
are neither overwritten nor cleared. Alerts remain persisted and deduplicated.

| Claim dimension | Observer / lifecycle ownership |
| --- | --- |
| Model, thinking, frozen source and credential | Shared execution-requirement predicate; model waits and immediate frozen-connection reasons retain their existing meanings. |
| Frozen or live custom-profile protocol | Profile readiness and the live-connection guard are checked even before a first snapshot exists. |
| Runtime workspace | Check row existence, task workspace, archive state, daemon ownership and `runtime_workspaces` protocol. A directory binding never permits moving frozen credentials. |
| Plugins | Same current-Agent or frozen-version readiness predicate, including desired state, observed digest and plugin protocol. |
| Code snapshot | Require the same daemon aliases as the recorded code Runtime. |
| Issue workspace protocol | Require the minimum daemon version for workspace-holding Issue tasks. |
| Parallel Issue execution | Require the existing versioned-daemon protocol declaration. |
| Project device routing | Reuse the exact SQL predicate for project binding and dedicated devices. |
| Retained Issue workspace affinity | Check the same retained workspace rows and daemon aliases as normal claim, separately from registered Runtime workspaces. |
| Agent / task tenant and route permissions, pins, fixed group | Preserve main's authorization candidate boundary; foreign or nonexistent routing candidates do not become model-capability failures. Empty candidate sets remain an administrative provisioning/binding condition, as required by existing MUL-335 tests. Frozen missing-source cases still have explicit reasons. Supported Agent tenant changes cancel pending tasks; provider/pin/group changes cancel frozen work and repool native work. |
| Archived Agent | Explicit administrative pause, visible through `archived_at`; restoring the Agent resumes its parked queue. Not a Runtime capability failure. |
| Archived/deleted Chat or obsolete topic binding | Supported Chat lifecycle cancels pending tasks; invalid legacy destinations are cancelled before dispatch. SQL guards remain defensive. |
| Offline/busy Runtime, CLI-update drain | Availability/drain state has its own Runtime/operation lifecycle. A compatible offline or busy candidate is deliberately not labelled capability-incompatible. |
| Agent capacity / execution lane / shared directory serialization | Existing `getTaskQueueBlocker` identifies the active blocking task. The local filesystem lock has `waiting_local_directory` and its own reason. |
| Runtime capacity / earlier Chat turn | Temporary scheduling/fairness conditions, represented by active task and ordered Chat queue state; do not overwrite reasons with a capability warning. |
| Binary Skill transport | Negotiated per claim request, not persisted in Runtime metadata. Unsupported requests roll back and return explicit HTTP 409 `binary_skill_files_unsupported`; an upgraded poll may immediately succeed. |

Regression coverage lives in `task-claim-capability-wait.test.ts`, the existing
`task-capability-wait.test.ts`, and `task-wait-reason.test.ts`; the latter also
checks escalation ownership and mixed structural/model failures. These checks do
not alter ordinary claim pagination or introduce per-task hydration into it.

## Profile schema boundary

The current Codex/Claude wire contracts are closed: normalization preserves all
currently executable fields and deliberately projects away unknown historical
metadata. It cannot infer whether a future unknown field controls tenant, routing
or API version. Before introducing such a field, version the snapshot contract
(or reject unknown semantic fields) and extend normalization, capability identity
and daemon readers together. Rejecting every unknown field now would break the
supported historical metadata compatibility without protecting any current wire
field; this change therefore documents the boundary rather than changing it.

## Provenance recovery and concurrent identity merge

Startup recovery discovers affected workspaces, then takes the same workspace row
lock as Runtime lifecycle operations in a transaction. It re-reads the missing
snapshots and credential ownership only after that lock is acquired, and retains
it through the provenance writes. An identity merge either observes the recovered
source and moves it with the credential, or finishes before recovery reads the new
owner. No source read outside the lock is cached for later use. A failed workspace
recovery rolls back its writes together; missing workspace rows remain unresolved.

`mergeRuntimeInto` also performs the shared strong-evidence recovery inside its
existing transaction before moving identity-affine state. This matters for an old
NULL-source env-auth transition: its fingerprint still names the original host,
so the source must be recorded before that identity disappears. The subsequent
source update moves that provenance with the host. Env snapshots without encoded
provenance remain unknown even if their mutable dispatch pin names the merged
Runtime. Ordinary retirement still leaves frozen provenance on the original host.

Credential owner reads are deduplicated and batched at 128 IDs (at most 129 SQL
parameters including workspace). The recovery does not read or copy key material.
It still scans/parses O(U) unresolved snapshots and writes each proven source once;
this is a startup/identity-maintenance cost, not a constant-time operation. The
200-distinct-missing-credential regression performs two owner queries on each
startup instead of 200, preserves every unknown source, and keeps the batch bound
independent of queue size. Repeated ambiguous rows remain retryable on future
startup; no negative lookup is persisted across Runtime identity changes.

`frozen-task-provenance-concurrency.test.ts` covers atomic rollback, batching,
encoded versus unknown env sources, and both lock acquisition orders using two
real PostgreSQL connections and actual `mergeRuntimeInto` calls. Its fixture pauses
after ownership is read and observes database lock contention before releasing
recovery, so it exercises the old stale-source write window directly.
