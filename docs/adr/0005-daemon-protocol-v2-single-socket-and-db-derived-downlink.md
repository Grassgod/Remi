# ADR 0005: One full-duplex socket per daemon, with a database-derived downlink

## Status

Accepted (MUL-401, sub-issue A-0). The protocol is specified in
[daemon-protocol-v2.md](../daemon-protocol-v2.md); the contract module lands with
this ADR and the connection layer follows in A-1/A-2.

## Context

The daemon reaches the control plane over HTTP only: `POST /api/daemon/heartbeat`
every 10 s, a claim poll on a 3–30 s ladder, plus human-request, steer and status
polls at 2–2.5 s. Explorer measured roughly 845 `/api/daemon/*` requests per
minute across the fleet, about 93–98% of the API's database-blocking time, and
`multiremi_task_messages` alone holds 4.9M rows and 79% of the database. An
outbound WebSocket already exists at `/api/daemon/ws`, but it is only a
task-available doorbell: no task state, no heartbeat, and no acknowledgement
travel over it. ADR 0001 cut the plugin-desired half of that polling with a
revision hash and explicitly deferred the rest.

Three constraints shape the replacement. Every fact the server pushes (offers,
steers, cancellations, pending runtime work) already lives in PostgreSQL, so a
second durable queue would be a second source of truth to reconcile. The daemon
already owns a durable per-task report queue in SQLite (`worker/outbox.ts`) with
monotonic row ids and replay, and the trace stream is far larger than the report
stream, so routing both through that queue would make it the bottleneck. And the
fleet upgrades one machine at a time, so a v1 daemon must still be able to learn
that it has to upgrade.

## Decision

We will replace the daemon's polling channels with one full-duplex WebSocket per
daemon process, carrying a versioned, sequenced JSON protocol whose downlink is
derived from database state rather than from a server-side queue.

- One socket per daemon **process**, multiplexing every runtime it hosts, so
  process-level directives (upgrade, drain, CLI update lock) keep one order.
- Reliable frames carry a sender-assigned `seq`. Uplink sequences are the daemon's
  existing outbox row ids, which are monotonic across process restarts and therefore
  need no new store; downlink sequences are per-connection and restart at 1.
- The server keeps **no** durable downlink queue. On connect and reconnect it
  re-derives offers from `multiremi_tasks`, steers from unconsumed rows, and each
  `pending_*` item from its own table, then resends a snapshot. Duplicate arrivals
  are absorbed by entity id.
- Trace events do not enter the outbox. The daemon's normalized trace file is both
  the upload source and the replay buffer, and trace sequences are dense and
  append-only per task so `first_seq .. head` is gapless.
- `POST /api/daemon/heartbeat` is retained as an **upgrade channel** only: a v1
  daemon's heartbeat receives `pending_update` and nothing else, every other v1
  route answers 426, and claim always returns null.

## Alternatives considered

- **One socket per runtime** — matches today's doorbell wiring and is a smaller
  diff, but upgrade, drain and the CLI update lock are process-level, so two
  sockets let a machine's two lanes observe those directives in different orders
  and force a second sequence scope. Revisit only if one daemon process must host
  runtimes from different workspaces.
- **A persistent server-side outbox for downlink frames** — the usual way to get
  at-least-once delivery, but every downlink fact is already a row, so this adds a
  second truth to reconcile on restart and duplicates the query the claim path
  already pays. Revisit when a downlink directive exists that is not persisted.
- **Route trace through the existing SQLite outbox** — reuses proven replay and
  sequencing, but the daemon must write a normalized trace file anyway (MUL-402),
  so this is a double write, and at 4.9M rows the message volume would make one
  SQLite queue the bottleneck.
- **Reject protocol v1 outright in the heartbeat handler** — the cleanest-looking
  cut, but the heartbeat ack is the *only* upgrade path the fleet has ever used,
  and one production daemon has no reachable SSH route. Rejected v1 daemons would
  never learn there is an upgrade available.

## Consequences

- **Positive:** no server-side queue to build, back up or reconcile; a reconnect is
  one snapshot query per runtime instead of a poll ladder; the report outbox keeps
  its existing shape and its existing idempotency tests.
- **Positive:** one sequence scope per daemon process makes the process-level
  directives ordered, and makes "no gaps, no duplicates" mechanically checkable as
  `(partition key, seq)`.
- **Negative:** a reconnect resends a downlink snapshot, so the daemon must dedupe
  by entity id. New frame types must add their dedupe key at the same time, and
  forgetting one means a duplicate directive, not a dropped one.
- **Negative:** one socket is a per-machine single point of failure; a lane-specific
  bug that drops the connection interrupts both runtimes. Reconnect is capped at
  30 s and the snapshot makes it lossless, but it is still one blast radius.
- **Negative:** the upgrade channel keeps a v1-shaped HTTP route alive indefinitely.
  It serves no task work, but it must not be "cleaned up" while any v1 daemon could
  still exist.
- **Neutral / open:** whether concurrent client-side dedupe sets are enough, or
  whether a dedupe window needs to be persisted, depends on how long a reconnect can
  take in practice; MUL-401's injection tests measure this.
- **Neutral / open:** whether `perMessageDeflate` is worth enabling should be
  decided from measured frame sizes after the fleet is on v2, not estimated now.
