# ADR 0001: Cut daemon polling with a desired revision in the heartbeat ack

## Status

Accepted. Server compatibility half lands with MUL-368 PR-1; the daemon
behaviour it enables is MUL-377.

## Context

Production serves roughly 14 req/s and about 94% of it is daemon polling: plugin
state, plugin desired, task claim and heartbeat each contribute a quarter. Plugin
state alone is a POST per Runtime per Plugin every ~5.5s, and desired state is a
GET on every poll tick. Every request shares one PostgreSQL connection and blocks
the main thread waiting on it, so poll volume is what queues web requests.

Two constraints shape any fix. The daemon fleet upgrades gradually, so a new
server must stay correct for daemons that predate the change. And
`POST /api/daemon/heartbeat` already runs the desired-state reconciliation and
loads every `desired = 1` row for that Runtime inside one transaction, so the
heartbeat handler already holds the data a change token would be computed from.

## Decision

We will carry a desired-state revision in the heartbeat ack
(`agent_plugins.revision`) and let the daemon skip
`GET .../agent-plugins/desired` while its cached revision matches.

`desiredRevision(rows)` hashes, with canonicalJson and sha256, the Runtime's
`desired = 1` rows sorted by `id`, reduced to `{ id, plugin_version_id,
retry_generation }`. Both the desired snapshot route and the heartbeat path call
that one function. State the daemon itself produces (`status`, `observed_digest`,
`retry_count`, `updated_at`) is deliberately excluded. The field is additive, so
the Agent Plugin protocol version stays at 1.

The daemon half — state dedupe, split heartbeat/claim cadence, WebSocket claim
wake-up, and keep-alive probing after a terminal 401/403/410 — is MUL-377.

## Alternatives considered

- **ETag / `If-None-Match` returning 304** — cuts the cost of each request but not
  the number of them: the server still has to reconcile desired state and JOIN
  rows to derive a hash before it can answer 304, which is the hot path MUL-366 is
  already shrinking. Old daemons never send `If-None-Match`, so they gain nothing.
- **Folding plugin state into the heartbeat body** — after dedupe, steady-state
  state POSTs approach zero, so the remaining traffic does not justify a heartbeat
  contract change or the loss of the reconciler's report-per-transition ordering.
- **Long-polling the claim route** — collides with the Bun.serve and nginx idle
  timeouts, while `/api/daemon/ws` already exists and already pushes
  `daemon:task_available`.
- **Exiting the process on a terminal authority error** — `Restart=always` turns
  it into a fresh retry storm, and changing the fleet's unit files is an ops
  action rather than a code change.

## Consequences

- **Positive:** one fewer request per poll tick per Runtime once a daemon is
  upgraded, with no new query on the server. Both heartbeat transports (HTTP and
  the websocket) get it for free because they share one store method.
- **Negative:** the benefit is proportional to daemon upgrade progress — a new
  server with an old fleet changes nothing. The revision covers three fields
  only, so a future field that changes daemon behaviour must be added to
  `desiredRevision` or it will not propagate until the daemon's fallback refresh.
- **Negative:** the ack allowlist in `daemonHeartbeatHttpResponse` has to forward
  `agent_plugins` explicitly. Dropping it fails silently, and the symptom is
  merely that polling returns.
- **Neutral / open:** the daemon must degrade to a fixed-interval desired GET when
  it talks to a server whose ack has no `agent_plugins`, and keep a slow fallback
  refresh against gaps in the revision definition. Both are MUL-377 acceptance
  criteria.
- **Neutral / open:** whether the remaining state/claim traffic warrants a further
  contract change should be decided from nginx `timing.log` after the fleet mostly
  upgraded, not estimated now.
