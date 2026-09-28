# ADR 0010: Recover terminal model failures from ACP bridge metadata

## Status

Accepted for MUL-478. Implements the decision in issue comment
`cmt_uuiy9i1f4fp3` and the native compaction recovery refinement in
`cmt_n5vqhlx6rone`; retains MUL-336's single model switch per recovery chain.

## Context

The pinned Codex ACP bridge can emit a terminal gateway error as assistant text
and resolve `session/prompt` with `end_turn`. The daemon then completes a task
whose final text is a model-not-supported error, moves the issue to `in_review`,
and bypasses failure recovery. Earlier progress makes whole-output heuristics
particularly unreliable.

Claude ACP rejects failed turns, but its error detail lives in JSON-RPC
`error.data`, which the client previously discarded. Model lookup errors can
also mention lack of access and be mistaken for an authentication failure.

Both pinned bridges already support JetBrains AIR `sessionFailure` metadata.
They advertise it in top-level `InitializeResult._meta`, not under
`agentCapabilities`. Claude's native `/compact` failure is a separate exit:
`tool_call_update(status=failed, _meta.contextCompaction.error)` followed by
`end_turn`, without an AIR error.
Their categories are broad (for example Claude uses `request` for both an
invalid request and model lookup), so categories alone cannot determine Remi's
recovery policy. Keep the original title/details and RPC `errorKind` as well.

The queued capability observer previously only explained waiting after two
minutes and recorded an analytics alert after fifteen minutes. It never used
the configured fallback even when a candidate Runtime supported it.

## Decision

1. The ACP client advertises AIR `sessionFailure` to both bridges and records
   whether both sides negotiated support using `InitializeResult._meta`;
   nested `agentCapabilities._meta` is only a compatibility fallback.
   `AcpProvider` consumes the failure metadata
   from `session_info_update` and `PromptResult`. Error severity throws
   `AcpSessionFailureError`, using the daemon's existing exception path.
   Warning severity does not fail the turn. Failure state resets for every
   prompt and notifications for other sessions are ignored.
   Independently of AIR negotiation, a failed context compaction tool also
   fails the prompt, retaining its error as details. Only assistant text after
   that failure in the same prompt clears it and logs a recovery warning;
   earlier output, compaction banners and thinking do not clear it. This does
   not clear independent AIR errors or treat ordinary failed tools as fatal.
2. Preserve JSON-RPC error data for structured classification, but exclude it
   from JSON serialization. Append only string `errorKind`, `message` and
   `details` fields (or legacy string data), redact credential patterns before
   truncating the appended text to 500 characters. Failure classification prefers known
   structured error kinds, then uses text. Model unavailability precedes auth;
   HTTP status matching excludes request IDs and UUID fragments.
   Availability text must describe the model itself, not an unsupported input
   feature; `invalid_request_error` is recognized even without an HTTP code.
3. For bridges without negotiated support, the daemon checks only the final
   emitted message in a naturally completed turn. It must be a short text
   message beginning with a known Codex transport error prefix and classify as
   a provider/model failure. Earlier progress cannot hide this final error.
   Bridges with typed support use structured metadata, including native
   compaction failures, as the failure authority.
4. The fallback set includes account-pool exhaustion, quota exhaustion, model
   unavailability, provider server errors and `queued_model_unavailable`.
   Rate limiting/overload (429/529) still retries the same model with bounded
   delay. Auth/configuration/network and other existing reasons retain their
   previous recovery policies. Every chain can switch only once; switching
   discards the old provider session and frozen model profile.
5. After five minutes of capability waiting, a queued task may fail with
   `queued_model_unavailable` only when it has attempts and switch budget left
   and a structurally eligible candidate supports its configured fallback.
   The observer uses the existing candidate/placement restrictions, including
   pinned runtimes. A shared `fallbackSwitchPlan` preflights recovery.
   Failure plus retry creation is atomic under the workspace lifecycle lock,
   with a guarded queued update. Events publish after commit. A missing retry
   rolls back the transition. Ineligible tasks retain their fifteen-minute
   alert. Age follows the observer's existing task creation timestamp.
6. Record switches using the existing `gateway_resource:` reason prefix and
   `fallbackSwitched`. The execution view gives model, server and queue reasons
   their own labels. No new API or CLI command is required.

## Alternatives Considered

- Whole-output text detection loses the bridge's known turn outcome, can
  mistake diagnostic prose for a failure and misses errors after long output.
  Keep text matching only as a compatibility fallback for older bridges.
- Forking both upstream bridges to add a new stop reason duplicates an existing
  capability and adds dependency maintenance work.
- Mutating the queued task's model in place or redispatching it would duplicate
  recovery/session cleanup, delegation suppression and switch accounting.
  Terminal failure followed by a retry reuses those policies and creates an
  auditable timeline record.
- Keeping fallback limited to account/quota exhaustion leaves unavailable
  models and compaction 5xx incidents stranded despite a configured backup.

## Consequences and Verification

Typed errors no longer enter assistant output as successful results. Failed
attempts use existing issue-state and delegation-return handling; a retry keeps
the issue in progress, and only the end of the chain wakes the delegator.

A gateway-wide 5xx can spend one extra attempt on the fallback. The single
switch and attempt limits bound this cost. Old bridge text matching retains a
limited ambiguity when a legitimate final answer is exactly a transport error.
Queue failure records are intentional and expose why the model changed.

Regression entry points are `tests/unit/acp/session-failure.test.ts`,
`tests/unit/multiremi/multiremi-task-failure.test.ts`,
`tests/unit/multiremi/agent-model-fallback-recovery.test.ts` and
`tests/integration/agent-model-fallback-drill.test.ts`. The drill isolates the
model process while exercising the real API/daemon/store chain. It does not
prove production gateway behavior or imply deployment authorization.

Rollback removes the two AIR capability declarations and reverts the fallback
policy/queue observer changes. The legacy daemon detector remains independently
available for sessions without negotiated capability support.
