# Leader serialization and parallel Agent execution

## Scheduling

- A continuous Agent context is serialized by Issue Session and Agent. Leader
  turns and delegation-return turns use this continuous context.
- Each independent delegation has its own execution scope, derived from the
  existing delegation ID. Different delegations can run together, including
  multiple delegations to the same Agent. Retries keep their delegation scope.
  `remi task continue <task-id> --prompt <request>` creates a distinct Task but
  reuses the referenced delegation's scope, provider session, cursor and runtime
  affinity. The caller must identify the exact prior delegated Task; the server
  never infers continuation from an Issue or Agent match.
- Continued Tasks in one execution scope are serialized. A new rich-mention
  delegation gets a new scope and remains eligible to run in parallel. Queued
  rich mentions may coalesce only with ordinary mention-created work; an
  explicit continuation is marked by `continued_from_task_id` and is never a
  coalescing candidate for an independent mention. If the
  prior provider session or execution fingerprint is no longer resumable, the
  existing lane reset path cold-bootstraps only that scope and records a
  `session_agent_lane_reset` Issue activity with the recovery reason.
- Issue-free one-shot tasks (including Wiki builds) are independent. Private
  Chat turns remain serialized. Existing Agent and Runtime capacity limits,
  project device routing, permissions and workspace affinity still apply.
- Tasks bound to the same [Runtime workspace](dev/runtime-workspaces.md) remain
  serialized across Agents and Sessions. Explicit Chat project selections keep
  their device routing even though Chat tasks do not hold an Issue workspace.
- A child result can immediately queue a Leader turn; other children do not
  delay it. Unclaimed returns coalesce, but a frozen prompt gets a later turn.
- Scheduled Wiki targets fill available Agent slots. Builds for the same
  publication target still deduplicate; different targets can progress together.

## Model routing and fixed execution groups

Agents without `runtime_id` or `execution_group_id` use model routing. Each
candidate Runtime must match the selected model and thinking level within the
agent's permitted workspace and engine. A fixed `execution_group_id` keeps
matching inside that group; legacy explicit Runtime pins remain compatible.

The workspace model catalog supplies model-routing choices; a fixed target
uses its scoped catalog. Without an explicit model, the Runtime default and
its reported thinking capabilities apply. An unadvertised model remains queued
until a compatible Runtime reports it. Claims recheck current capabilities and
skip incompatible queued work so another runnable task can proceed. Existing
ownership, capacity and session-affinity constraints still apply.

Custom-connection retries keep their frozen model and credentials on the
original host. A thinking override still requires matching reported capabilities
for that connection. After a workspace transition, a destination with a custom
connection must support the frozen model; a native destination uses and checks
the current Agent model. Queue filtering is per Task so an incompatible new
turn does not hide a compatible frozen retry from the same Agent.

## Shared code, private execution state

Repository checkouts remain under the existing `issues/<issue-key>` root and
`agent/<issue-key>` branch. This change does not introduce per-task worktrees,
branches, automatic merges, or a single-writer restriction. Concurrent code
edits can conflict; Agents must coordinate edits and preserve peers' changes.

Task configuration, skills, Wiki working copies and provider caches use a
private execution directory under `.runtime/<session>/<agent>/.../work`.
Delegations add `delegations/<delegation-id>` to the provider generation path.
Prompts report absolute repository and session-history paths; the platform
continues to report the shared code workspace as the Issue workspace.

Executions hold shared lifecycle locks. Final archive, cleanup and workspace
migration still require exclusive ownership. Only repository preparation is
serialized briefly; the lock is not held exclusively while the model runs.

The activity card counts task states separately (running, starting, queued,
waiting for confirmation, waiting for a directory), including multiple tasks
using the same Agent. Queued tasks are not counted as running.

## Deployment requirements

1. Pause new claims and drain active tasks before upgrading the control plane.
2. Apply the normal database migration. It extends provider checkpoint keys
   with execution scope. Existing checkpoints and queued native-session pins
   cold-bootstrap once; canonical Session events, comments, code and history
   files are retained. The migration is idempotent.
3. Upgrade the Daemons before resuming claims. New Daemons register
   `parallel_agent_execution: 1`. Versioned old Daemons are intentionally
   ineligible for Issue tasks because their shared configuration is unsafe for
   parallel execution. Updating only the server is insufficient.
4. Check Agent and Runtime capacity using the existing settings or CLI. A
   Runtime limited to one task remains serial. This PR changes no live limits.

The task creation API accepts `continueTaskId` / `continue_task_id` only as an
explicit reference. It derives delegation lineage server-side and rejects
cross-workspace, cross-Session, cross-Agent, non-delegated, unauthorized, and
wrong-delegator requests. `delegationId` remains an internal field that public
callers cannot set. `execution_scope` and the daemon capability flag remain
internal execution protocol fields.
