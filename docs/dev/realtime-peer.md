---
title: Realtime peer channel
status: active
summary: Cross-process task and workspace event delivery with bounded batching and startup role routing.
---

# Realtime peer channel

[The fanout](../../packages/server/src/api/realtime-fanout.ts) subscribes to task
enqueue, task lifecycle and workspace events. It delivers locally according to
the effective API role and forwards the same event to the other process when
`MULTIREMI_PEER_URL` is configured. Remote events are delivered locally once;
they are never forwarded back. Both processes must share the database.

Browser task transcripts no longer use this channel. SessionLog rows use the
log Hub stream, and execution events use the trace stream. The old
`task_messages` peer kind remains accepted by the generic protocol parser for
wire compatibility, but [realtime-fanout.ts](../../packages/server/src/api/realtime-fanout.ts)
does not produce or consume it.

## Wire And Ordering

[The contract](../../packages/contracts/src/peer-events.ts) defines envelopes
`{v:1, origin, kind, payload}` and batches
`{topic, epoch, batch_seq, events}`. Each POST body, including JSON wrapping,
fits the 1 MiB limit. The sender has one active or frozen batch and retries
identical bytes with the same sequence after 1-10 seconds. The receiver tracks
the highest sequence handled per epoch and acknowledges duplicates without
delivering again. A receiver restart clears that memory; reconnecting browser
clients recover from the authoritative log and trace streams.

Oversize task enqueue and lifecycle events degrade to a task ID. The receiver
re-reads the task from the shared database before delivery. Workspace events
and opaque topics that cannot fit one event are refused and counted as
`oversize_dropped`. The queue caps backlog by count and serialized bytes;
active retry bytes are outside backlog eviction. Health reports queue,
inflight, dropped, degraded and RTT counters.

## Role Resolution

[Startup configuration](../../packages/server/src/config/startup-env.ts) is the
production caller of `resolveApiRole(env)`. It passes `{role, configured}` to
the HTTP and WebSocket guards, fanout, health and metrics. An injected role
takes precedence over the environment. An unset role remains `all` with
`configured:false`; the [architecture guard](../../tests/arch/api-role-resolution.test.ts)
prevents downstream role environment reads.

Validation lives in the [protocol tests](../../tests/unit/multiremi/peer-channel.test.ts),
[fanout tests](../../tests/unit/multiremi/realtime-fanout.test.ts) and the
architecture guard.
