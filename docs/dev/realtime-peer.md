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
contains neither message content nor a task body. The receiver calls the existing
`listTaskMessages(task_id, seq_start - 1, seq_end)` path once per reference,
using the indexed `(task_id, seq)` range and ascending order. It uses the same
browser serializer and authorization as full events: every persisted message
still produces its own browser frame.

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
[protocol tests](../../tests/unit/multiremi/peer-channel.test.ts),
[fanout tests](../../tests/unit/multiremi/realtime-fanout.test.ts) and
[role architecture guard](../../tests/arch/api-role-resolution.test.ts).
