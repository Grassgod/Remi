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
SQL parameter count is bounded regardless of queue length. Reading candidate rows
still scales with the queue, offset pages may rescan earlier rows inside the
database, and distinct requirements require distinct checks.

Frozen-source/credential/protocol problems use the owned wait-reason prefix
`等待冻结执行连接恢复：`, including when retirement leaves no candidates. The existing
capability monitor evaluates the frozen model, requires the same profile
protocol support as claim/reclaim, and clears recovered reasons;
ordinary model waits retain MUL-335's grace period and alert behavior. Existing
Task API/CLI `wait_reason` fields expose these reasons without a new endpoint.
