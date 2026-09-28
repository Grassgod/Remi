---
title: Realtime peer channel
status: active
summary: Cross-process delivery, persisted message references, bounded serialized admission and one startup role.
---

# Realtime peer channel

[The fanout](../../packages/server/src/api/realtime-fanout.ts) subscribes to store
events and delivers locally by the effective API role. A configured
`MULTIREMI_PEER_URL` also enables forwarding through the
[peer channel](../../packages/server/src/api/peer/peer-channel.ts). Remote events
only deliver locally. Both processes must share the database.

## Wire And Ordering

[The contract](../../packages/contracts/src/peer-events.ts) defines envelopes
`{v:1, origin, kind, payload}` and batches
`{topic, epoch, batch_seq, events}`. POST bodies include all JSON wrapping and
separators in their 1 MiB limit. The sender has one active or frozen batch, and
retries identical body bytes under the same sequence after 1-10 seconds. The
receiver tracks its maximum handled sequence for each epoch and acknowledges
duplicates without delivering again. Receiver restart clears that memory;
existing sockets disconnect and new browser connections refetch.

Task-message envelopes carry only the existing six routing fields in `task`:
`id`, `workspaceId`, `agentId`, `chatSessionId`, `issueId`, `issueSessionId`.
The full form also carries `task_id` and one persisted message in `messages`.
Legacy header degradation retains `messages`, sets `degraded:true`, and omits
`task`. The receiver uses the existing task identity read with its six-field
fanout projection to reconstruct the routing subject.

If a message's actual serialized envelope exceeds the single-event limit, or
full messages would exceed the 64 MiB produce admission budget, the sender uses
a persisted message reference:

```json
{"v":1,"origin":"sender-epoch","kind":"task_messages","payload":{"task_id":"tsk_example","degraded":true,"seq_start":1,"seq_end":256}}
```

The range is inclusive. Adjacent references from one produce call may merge
only when they refer to the same task and consecutive sequences. A reference
contains neither message content nor a task body. The receiver pages through the
existing indexed `(task_id, seq)` range in ascending order. Every returned message
still produces its own frame using the full path's browser serializer and audience
authorization. Runtime-only processes have no task-message consumer and do not
read referenced message content.

References read the **current committed version at each page read**, not the
version at enqueue time. Store notifications occur after the append transaction
commits and use post-upsert rows; the peer is queued from those notifications.
No revision snapshots or old-version retention are added. An overwritten seq may
skip intermediate versions. Within a burst a reference may briefly deliver a new
version before a later queued full frame delivers an older intermediate version;
subsequent committed update frames converge to the current rows. Browser
[`mergeTaskMessages`](../../frontend/packages/core/chat/queries.ts) merges by seq
with later sources winning. Append-only input retains per-frame byte equality.

## Reference Pagination And Failure

Each page is one ASC, indexed task/seq query with `seq > cursor`, inclusive
`seq <= seq_end` and `LIMIT page_rows`; the cursor advances to its last returned
seq. A short page or the inclusive end stops the loop, without an extra query for
a full final page. For contiguous rows the query count is
`ceil(range_rows / page_rows)`, separately asserted from the per-reference
`degraded_received` counter. The producer's post-commit changed-row read uses the
same paging policy so a legal 256-message append does not itself cross the bridge
in one 64 MiB reply.

[The page policy](../../packages/server/src/store/task-message-pagination.ts)
caps a page at eight rows. Capped content/input/output/meta total 640 KiB per row,
plus a 512 B tool name; JSON escaping costs at most 6x. A conservative 4 MiB row
budget leaves over 250 KiB for normal IDs and row metadata. A further 64 KiB is
reserved for the reply wrapper. The bridge's effective ceiling is the smaller of
its configured positive limit and its 64 MiB shared buffer; an unset/off limit
still has the 64 MiB ceiling. Rows per page are:

```text
max(1, min(8, floor((effective_ceiling - 64 KiB) / 4 MiB)))
```

With the 8 MiB test/guardrail setting this is one row; with the limit disabled it
is eight rows, budgeted below 32 MiB + 64 KiB and hence below the shared buffer.
For deliberately smaller limits, unusually large uncapped identifiers or legacy
rows, even one row can exceed the ceiling. That is a read failure, not permission
to bypass the bridge limit. The limit and page policy share the bridge's cached
value; tests use `resetDbReplyLimitForTest` when changing it.

A reference query failure emits a **header-only** `task:message` frame containing
`task_id`, `issue_id`, optional Chat/issue-session IDs, `degraded:true`, and the
inclusive `seq_start`/`seq_end`. It contains no message `seq` or content and must
not be inserted as a transcript row. The browser handler clears that task's
pending frame buffer and invalidates only its task-message history query. The
header follows the same private-task and Chat audience checks as full messages.
The transport acknowledges it without retrying a poisoned read forever, records
`reference_read_failed` once per failed reference in peer health, and logs only a
payload-free warning. `degraded_received` still counts the reference once, not
once per page. Real-PG tests cover a 512 KiB bridge limit with successful pages
and a 128 KiB limit that refuses one 256 KiB row and triggers this fallback.

Task enqueued and task event envelopes retain their full-task contract and can
degrade to task IDs. Workspace events and opaque topics that cannot fit one
event are refused and counted as `oversize_dropped`.

## Byte Budget And Metrics

Serialized queue bytes plus active/frozen POST body bytes stay at or below
`32 MiB + 64 MiB + 1 MiB = 101,711,872 B`. Before admitting a produce burst, the
sender reduces existing backlog to 32 MiB. Persisted full message events shed
content in favor of references first. Remaining backlog beyond the byte or
10,000-event cap is evicted oldest first. Actual serialized burst bytes are
limited by code, including reference envelopes. One active/frozen batch adds at
most 1 MiB and is outside backlog eviction.

`degraded` counts emitted replacement envelopes, including burst references and
backlog conversions; `degraded_received` counts accepted replacement envelopes.
`dropped` counts backlog evictions and unacknowledged events stranded at close.
`oversize_dropped` counts events with no sendable full or reference form. These
two drop reasons are disjoint. A failure after close never rebuilds a batch.

The bound describes serialized live data, not process RSS. Allocators may retain
memory after large bursts and GC; RSS requires separate observation. Instantaneous
queue and inflight values are available in peer health, while minute summaries
report counter increments and RTT samples for that window.

## Role Resolution

[Startup configuration](../../packages/server/src/config/startup-env.ts) is the
sole production caller of `resolveApiRole(env)`. It carries `{role, configured}`
to startup checks, the app, the HTTP and WebSocket guards, fanout, health and
request metrics. An injected role takes precedence over env. Standalone test apps
use the same startup resolution entry; long-lived servers pass their existing
result into the app. Metrics require the caller's role and only resolve their
own tuning options. An unset role remains `all` with `configured:false`, preserving
the default health bytes. The architecture guard prevents downstream role env
reads or resolver calls.

Validation lives in the
[store-to-peer budget and golden tests](../../tests/unit/multiremi/peer-task-message-budget.test.ts),
[committed-reference and real-PG tests](../../tests/unit/multiremi/peer-task-message-reference.test.ts),
[protocol tests](../../tests/unit/multiremi/peer-channel.test.ts),
[fanout tests](../../tests/unit/multiremi/realtime-fanout.test.ts) and
[role architecture guard](../../tests/arch/api-role-resolution.test.ts).
