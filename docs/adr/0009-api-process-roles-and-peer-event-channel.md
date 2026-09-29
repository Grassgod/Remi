# ADR 0009: API process roles split by surface, with a loopback peer event channel

## Status

Accepted (MUL-455 S10, child issues MUL-461/462/464). Deployments are opt-in: the
role resolves to `all` when `MULTIREMI_API_ROLE` is unset or empty, the peer
channel is off until `MULTIREMI_PEER_URL` is set, and the second container sits
behind the Compose `split` profile. Nothing changes on an installation that does
not set them.

The Compose templates interpolate the role with an **empty** default
(`${REMI_API_ROLE:-}`), not a literal `all`. That distinction is load-bearing:
MUL-461 reports a `role` field in `/health`, `/readyz` and `/health/realtime`
only when the variable is explicitly set (`isApiRoleConfigured()`), so shipping
`all` as the default would add a field to those payloads on every existing
installation. Empty means "unset" to the server, which still resolves to `all`
internally: same behaviour, same bytes on the wire.

## Context

One API process serves two surfaces with very different traffic. Over 24 hours on
production (2026-09-26 20:43 → 09-27 20:43) `Bun/` user agents made 1,527,947
requests against 88,466 non-Bun ones, and the top eight routes were all under
`/api/daemon/`: messages 310k, status 305k, steer 256k, heartbeat 247k, claim
141k, agent-plugins/desired 117k, plus two smaller ones. Every SQL statement in
that process goes through a synchronous Postgres bridge, so a daemon request
holds the main thread while it waits. The observable result is the browser
surface queuing behind daemon polling: `event_loop_lag_max_ms` on the UI process
is what the S10 acceptance measures.

The store's realtime events are the second half of the problem. `createTask`,
`createIssueComment`, task events, task messages and workspace events each
publish into in-process subscription registries (`store.ts:579-609`), and a
browser WebSocket and a daemon WebSocket subscribe to different scopes of those
same registries. Splitting the process therefore splits the registries: a comment
written by the daemon-side process would never reach a browser connected to the
other one.

Three constraints bound the design. The platform and the daemon CLI upgrade
separately, so a server change cannot assume a new client. The role must be
switchable and revertible without a schema change, because it is an operational
decision. And the compose file name `api` is load-bearing: the Web image bakes
`REMOTE_API_URL=http://api:6120` (`deploy/docker/Dockerfile.web:8`), so the
browser-facing container has to keep that name.

## Decision

1. **Split by role, not into N identical workers.** `MULTIREMI_API_ROLE` is
   `all` (default) | `ui` | `runtime`. Each role keeps every route mounted and
   answers a wrong-surface request with `421 misdirected` plus
   `X-Remi-Api-Role`, rather than serving a smaller route table. A missing route
   is indistinguishable from a typo in a client, while a misdirected answer names
   the misrouting. The `ui` role rejects `/api/daemon/*` HTTP and the
   `/api/daemon/ws` upgrade; the `runtime` role rejects everything except
   `/api/daemon/*`, `/health*`, `/readyz`, `/healthz` and `/internal/*`, and
   rejects the `/ws` and `/api/realtime/ws` upgrades. Path matching for the
   daemon surface must use a trailing slash (`/api/daemon/`): `/api/daemons/:id`
   is a browser route.
2. **Cross-process realtime events travel over a loopback HTTP peer channel.**
   Each process publishes the store events it produces to its peer's
   `POST /internal/peer/events` and re-delivers what it receives into its own
   registries, according to its role. The sender batches in a macrotask, so an
   event raised inside a transaction is only sent after the commit; delivery is
   serial to preserve order, failures back off 1 s → 10 s, and the queue is
   bounded at 10,000 entries with the oldest dropped and counted. A received
   event is never forwarded again, so two peers cannot loop. The channel is
   symmetric: whichever process holds the browser socket, and whichever writes
   the data, delivery works in both directions. `MULTIREMI_PEER_URL` unset keeps
   today's behaviour exactly. Its payloads have no size limit and it needs no new
   dependency.
3. **`api` stays the browser process.** The split adds `api-runtime` for the
   daemon surface and leaves `api` as `ui` (or `all` during the transition).
   Renaming roles into new container names would break the image's baked
   `REMOTE_API_URL` and every Nginx route that sends `/` to Web and Web's rewrite
   to `api:6120`. The updater's service list is data
   (`MULTIREMI_PLATFORM_CORE_SERVICES`, default
   `api,web,ssh-mesh-control-plane`), so an installation adds `api-runtime` to
   the pull/switch/restart set without rebuilding the updater.

## Alternatives

- **(a) Temporary PostgreSQL `LISTEN/NOTIFY`.** Strongest argument: `NOTIFY`
  itself is delivered at commit time, so its semantics are correct by
  construction; it is symmetric and extends to N processes without new
  configuration. Rejected: this repository's transactions are synchronous (`Atomics.wait`
  in `store/db/postgres.ts:204-260`), and the peer channel's sender flushes in a
  macrotask, so it too only emits after `COMMIT` — the semantic advantage does
  not exist here. Against that it costs a client: Bun 1.3.14 has no `sql.listen`
  and the release pipeline, Dockerfiles and CI all pin 1.3.14, so (a) needs
  either a version upgrade or a second Postgres driver in-process, staged on the
  release path. `NOTIFY` also caps a payload at 8000 bytes, while the events it
  would carry include task messages and workspace event envelopes; roughly 40
  event kinds would have to become "notify an id, then read it back", which is a
  rewrite of half of `realtime.ts` rather than a transport swap. **Conditions to
  reconsider:** Bun ships `sql.listen` at the pinned version (or a second driver
  is accepted), and the events needing transport are all under 8000 bytes, or a
  read-back path is wanted anyway for replay or persistence. If that happens the
  peer channel is the thing to delete: it is ~3 days of work and the interface
  below is what makes it replaceable.
- **(b) Wait for the Live Hub (MUL-403/ADR 0007).** Strongest argument: it was
  the original advice not to build a temporary bus for the old WebSocket
  registries, because the Hub is going to own realtime delivery and the
  registries are supposed to shrink. Rejected for today's timeline: the Hub is
  later than this split, and it does not cover what the split needs. Browser
  lifecycle events are deliberately outside the Hub (ADR 0007 decision 1), and
  the daemon wake-up is a server-side `onTaskEnqueued` path, not a Hub
  responsibility. So the Hub arriving first would still leave both the browser
  registry and the daemon registry to be bridged across processes, and the old
  registries stay in place afterwards as well. **Conditions to reconsider:**
  the Hub takes over browser delivery end to end, including lifecycle events,
  and a Hub-based path exists for daemon wake-ups. The peer channel is built to
  survive that: it exposes `publish(topic, payload)` / `subscribe(topic,
  handler)`, so MUL-403 can add a `kind:"peer"` `HubTransport` adapter (about 30
  lines) instead of replacing the transport.
- **Serve a reduced route table per role instead of answering 421.** Smaller
  diff, but a wrong-surface request would then look like a 404, which is
  indistinguishable from a client typo, and the failure would only be noticed as
  missing functionality.
- **N identical replicas behind a load balancer.** Does not separate browser
  latency from daemon polling, since every replica would still serve both
  surfaces; it also needs sticky WebSocket routing and multiplies the background
  sections instead of removing them from one process.
- **Persist and replay peer events.** Today's in-process registries neither
  persist nor replay: a browser that reconnects refetches, and a daemon falls
  back to polling. Adding durability to the transport would be a new contract,
  not a like-for-like replacement.

## Consequences

- **Positive:** daemon polling and browser work stop sharing an event loop, which
  is the S10 goal; the split is a deployment decision that can be rolled back in
  four independent layers with no schema change; the peer channel's
  `publish`/`subscribe` shape is reusable as a Hub transport adapter, so the
  fallback cost of route (a) or (b) is bounded.
- **Positive:** an unconfigured installation is untouched. `MULTIREMI_API_ROLE`
  is passed through as an empty string and resolves to `all` inside the process,
  so existing `/health` payloads keep their shape; `MULTIREMI_PEER_URL` unset
  disables the channel; the second container only exists under the Compose
  `split` profile; and the updater's default service list is byte-identical to
  the previous constant. The host hands the deployment its topology; the updater
  binary does not bake one in.
- **Negative:** two processes now hold the same database and the same mounts.
  Local delivery rules must be role-aware, and the peer channel is a new failure
  surface: it can drop events (counted as `peer.dropped`) when a peer is
  unavailable. Delivery has never been durable, and the drop counter plus the
  polling fallback are what keep that honest.
- **Negative:** the transition state has both processes able to serve both
  surfaces, and daemon WebSockets established before an Nginx change stay on the
  old process. This is intentional, since it makes the routing change revertible
  on its own, but it means "the counters are near zero" rather than "zero" is the
  observation to expect while old sockets age out.
- **Negative:** the updater binary is a host artifact and does not ride the daily
  image release. Adding a service to the topology therefore requires editing the
  updater env file as well as the Compose file; forgetting that step makes the
  second container drift one release behind. That is documented as a numbered
  step in `deploy/README.md` rather than hidden in code.
- **Neutral:** `/api/daemon/*` still crosses the Web container for daemon
  requests that use task tokens (attachment downloads and the CLI calls an agent
  task makes). Those stay on the UI process by design; they are human-semantic
  requests, and separating them is a later decision.
