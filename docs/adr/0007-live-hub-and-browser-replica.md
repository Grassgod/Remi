# ADR 0007: One Live Hub per API process, with a browser replica instead of per-tab polling

## Status

Draft (MUL-403, message architecture v2-C). Written at C0, before the
implementation, per the plan's §4 outline (MUL-403 `cmt_8u0ols22z3a1`), revised
when A-0's final commit (`43e41952`) merged into this branch, and rewritten in
place at C0 to the current decision under the plan's 7/6 revision (MUL-403
`cmt_c8hq9xitmhnh`, `cmt_47v5jalbtofp`) and the owner's decision table
(`cmt_co06ay4zo9ex`). C1–C11 fill in the code this ADR describes; the decisions
below are the ones the implementation must not contradict without a new ADR.

Ten questions were put to the product owner (MUL-403 `cmt_7fdlky2b1tp4`). This
document records the answer for each and marks every one that is still unconfirmed
as 「待确认」. Q1, Q2 and Q5 are invisible to users and are already being built
against the recommendation; Q3, Q4, Q6 and Q7 are user-visible and stay unbuilt
until they are confirmed; **Q8 is confirmed** (the product owner chose option A on
2026-09-27) and the change is recorded below; Q9 and Q10 are test-environment
questions and remain open. A different answer to an open question changes the
named sub-deliverable and nothing else.

| # | Question | Assumed answer | Status |
|---|---|---|---|
| Q1 | Browser replica implementation | Web Locks leader + DedicatedWorker + official `sqlite-wasm` `opfs-sahpool` + BroadcastChannel | 待确认 (building on it) |
| Q2 | No OPFS / no Web Locks | In-memory replica, same protocol, no persistence | 待确认 (building on it) |
| Q3 | Timeline draws the last 30 only | Top row 「还有 N 条更早 ▸」, description always first, no auto-load on scroll-up | 待确认 (user-visible) |
| Q4 | DOM ceiling after dropping virtualization | Flat list, 300 rows, then a 「回到最新 ▾」 chip | 待确认 (user-visible) |
| Q5 | Feishu receipt fails after 6 retries | Silent: audit and log only; messages and cards unaffected | 待确认 |
| Q6 | 「执行过程」 loads on open only | All five entry points lazy | 待确认 (user-visible) |
| Q7 | Six further user-visible changes | All confirmed | 待确认 (user-visible) |
| Q8 | `useAnchoredReveal` / `useStickToBottom` move into C8 | Yes (option A) — but they land in main first with MUL-450; C8 only calls them | **已确认 (option A)** |
| Q9 | When S1 (p75 ≤ 0.5s) is accepted | Local seed environment before release as a gate; 209 peak/off-peak after release | 待确认 (test environment) |
| Q10 | Environment for the Feishu receipt-failure check | A non-production test bot and group | 待确认 (test environment) |

ADR 0005 decides the daemon side of the same release (one socket per daemon,
traces owned by the daemon) and ADR 0006 decides the storage side (one
conversation log per session). This ADR decides how the server fans those streams
out and how a browser keeps a local copy of them.

## Context

Today the web client learns about change two ways, and both are wrong for the
target latency.

**Full reads.** The timeline, chat and the process record are fetched whole over
`GET /api/tasks/:id/messages`, `GET /api/chat/sessions/:id/messages` and a
paginated variant, and the process record is prefetched by five separate entry
points. There is no per-session ordering the client can trust, so every refresh
re-reads a range rather than asking for what it missed.

**A socket with no sequence.** `realtime.ts` fans out named events
(`task:message`, `chat:message`, `task:*`) over the browser WebSocket. These are
invalidation signals, not ordered data: a client that reconnects cannot say what
it missed, so the reconnect path invalidates caches and refetches. MUL-383's
(read-only) investigation of the production API measured the resulting load, and
ADR 0005 records the daemon half of the same problem.

Three constraints shape any replacement:

- **Each API process is single-threaded, and there is more than one of them.**
  Fan-out happens on the same event loop that serves HTTP, so a slow subscriber
  must never block an append and the fan-out cost per frame has to be one `send`
  per subscriber. The server also runs as two roles now (MUL-455 / S10), so a
  design that assumes one process would serve a silently partial stream: MUL-383
  measured 0/20 cross-process deliveries against 20/20 in-process, which is the
  evidence behind the current 「one hub per process, streams owned by process,
  pointers across processes」 decision rather than a single global hub.
- **The sequence already exists upstream.** The daemon assigns dense, append-only
  `trace_seq` per task (ADR 0005), and MUL-402's conversation log is keyed by
  `(session_id, seq)` with an explicit `revision` for in-place updates (ADR 0006).
  A second numbering in the hub would immediately disagree with the file offsets
  and read windows both of those define.
- **The browser cannot use a SharedWorker the way the original plan assumed.**
  Android Chrome has no SharedWorker, OPFS synchronous access handles exist only
  in a DedicatedWorker, and Chrome cannot start a DedicatedWorker from a
  SharedWorker. The literal "SharedWorker + OPFS SQLite" design cannot be built.

## Decision

We will replace the per-tab invalidation socket with an in-process Live Hub in
**every** API process that carries one, fan out two ordered streams whose owner is
decided per stream kind, and give the browser a single local replica per
`(user, workspace)` instead of a per-tab view of the network.

Sources for this decision: MUL-403 方案 7/6 (`cmt_c8hq9xitmhnh` 结论与选型,
`cmt_47v5jalbtofp` 实施与验收) and the owner's decision table
(`cmt_co06ay4zo9ex`). Where the C0 draft said something else, this section is the
current decision and the draft's wording lives only in Alternatives.

### 1. One hub per API process, stream ownership per kind

`packages/server/src/api/hub/` holds one `LiveHub` **per API process**. The
process's role comes from MUL-461's `config/api-role.ts` — `resolveApiRole()` reads
`MULTIREMI_API_ROLE` and returns `ui | runtime | all` (default `all`). Each process
serves two stream keys: `log:<session_id>` (MUL-402's conversation log: display
units and hidden markers) and `trace:<task_id>` (MUL-401's trace events). The hub
assigns **no** sequence: a `log:` frame carries the conversation-log row's own
`seq`, a `trace:` frame the daemon's `trace_seq`. Deduplication follows from that —
anything at or below the head is a replay and is dropped.

**`log:` streams are owned by the database, not by a process.** The process that
writes an entry appends to its own ring and publishes a **head pointer only** —
`{kind: "head", key, head, log_version}`, roughly 100 bytes. A peer that holds the
stream (an active subscriber, or a ring that is not yet evicted) reads
`(local_head, head]` through C4's read-only pool, feeds the ring and fans it out; a
peer that does not hold the stream only records `known_head`. A frame whose `seq`
is not `head + 1` waits in a **500ms continuity buffer** and is filled through the
pool if the hole does not close, so `subscribe(fromSeq)`, `gap` and replay keep the
2/6 semantics verbatim in both processes. A subscription whose `fromSeq` predates
what the ring still retains gets `gap: {from, to}` and fetches that range from the
read route that owns it — the browser from
`GET /api/sessions/:id/log?anchor&before&after`, the Feishu connector from
`trace.fetch`. The pool fill above is the hub repairing its own ring, not a read
route for subscribers.

**`trace:` streams do not cross processes.** They live only in the process the
daemon is connected to — `runtime`. Browser trace subscriptions therefore go to
`/api/trace/ws`, which nginx routes to `runtime` (B5's trace HTTP endpoints route
there too). Trace bytes across processes are zero by construction.

**The cross-process channel is MUL-462's `publish(topic) / subscribe(topic)` peer channel**,
topic `hub`; C1 adds the `HubTransport` peer adapter on top of it (topic `hub`,
sending `{kind: "head"}`). The roles on either side of that channel and the
channel's own delivery rules are ADR 0009's subject (MUL-464, not yet in `main`);
this ADR owns only what the hub puts on it and what the receiver does with a
pointer. There is no second peer link: 7/6's `/internal/hub`,
`X-Peer-Secret`, `api/role.ts` and `EventBridge` are superseded by MUL-461/462. The
head pointer is the whole payload, so the channel's ≤200ms budget is comfortable.
The Hub adapter detects loss with its own pre-enqueue sequence and sender epoch;
MUL-462's batch sequence cannot reveal a queue eviction. A new epoch or a gap
makes the process **reconcile**: it re-reads the head of every subscribed log stream and fills the
difference. A link that reconnects with continuous sequence numbers needs no reconciliation.

The role guard is an advisory lock **per role**, not one global lock: C1 takes
`pg_try_advisory_lock(hashtext('remi:hub:ui'))` or
`hashtext('remi:hub:runtime')` on a dedicated connection at startup, retries for
30 s (the updater's `up -d --no-deps` stops then starts), and exits non-zero if it
never gets the lock. An `all` process takes **both** locks when it has no peer
configured; an `all` process **with** a peer configured takes only the `ui` lock,
because the transition topology runs `api=all` beside `api-runtime=runtime` and a
second taker for the runtime lock would make one of them exit.

`HubTransport` remains the seam for the adapter, and the local adapter stays the
default: with a single process, or with `MULTIREMI_API_ROLE` unset, fan-out and
observable behaviour are exactly what they were before this ADR changed.

### 2. The browser replica is chosen once per browser, not once per tab

The replica lives under `frontend/packages/core/replica/`. A tab takes
`navigator.locks.request("remi-replica:<user>:<ws>", {mode: "exclusive"})`; the
holder is the leader, runs the DedicatedWorker that opens the official
`sqlite-wasm` build over the `opfs-sahpool` VFS, holds the page WebSocket (the
token lives in `localStorage`, which a worker cannot read) and writes frames into
the database. Other tabs read through a BroadcastChannel. One browser therefore
has one database, one subscription and one write path; closing the leader
releases the lock and the next tab takes over within a second, resuming from the
`head_seq` already in the database.

Freshness is `log_version` equality **and** head equality: `head_seq` alone cannot
see an in-place update, which is why the subscription ack carries both. When a
tab gets a WebSocket it sends `from_seq: local_head + 1` and treats the ack as
resumption; there is no invalidation step on reconnect.

Without OPFS or Web Locks the same protocol runs in memory: identical semantics,
no hot start. Persistence is an optimisation under the freshness rule, not a
correctness requirement, so a second storage engine is not worth its cost.

### 3. Write-time rendering, a flat list, and explicit windows

Server-side `renderMarkdown(md)` produces sanitized HTML with the same schema the
frontend renders (shiki with `defaultColor: false`, KaTeX inline) and stores it in
MUL-402's `body_html` with a `render_version`. The client renders stored HTML and
only enhances it after mount, and the enhancement must not change a row's height.
A height cache keyed by `(entry_id, revision:render_version, width bucket)` backs
the fixed-height reservation before measurement.

The virtualized list goes away. Both the Issue timeline and chat use one flat list
over the same conversation-log stream, with explicit before/after windows
(MUL-402's `anchor&before&after`) and a DOM ceiling of 300 rows. Virtuoso's
`customScrollParent` + `firstItemIndex` + `followOutput` + `startReached`
combination is the direct cause of today's jumpiness and of "opened not at the
bottom"; with heights predictable it only costs.

### 4. Scroll states are explicit

`useStickToBottom` is a `pinned | released | returning` state machine: within 24px
of the bottom, appends keep the view pinned and height changes are compensated in
the same frame; scrolling up enters `released`, where appends only increment a
「N 条新消息」 chip; the chip returns to `pinned`. Deep links open `released`
centred on the target row. `useAnchoredReveal` keeps the scroll root hidden until
the anchor has a position and its reserved height is measured, then publishes
`data-perf-state=ready` (forced after an 800ms budget).

**Q8 (confirmed, option A):** the two hooks are not written by this issue. They
land in `main` first with MUL-450 and keep the names MUL-390 planned; C8 imports
and calls them, and owns nothing but their call sites. MUL-390 stays a consumer
and keeps ADR 0008. This supersedes the plan's "both hooks are C's" wording, which
was written when MUL-390 had no branch and would have blocked every frontend
sub-issue behind it.

### 5. The adapter seam over MUL-462's peer channel (roles: ADR 0009)

`HubTransport` has one implementation today, `local`, which does nothing on
publish because the hub already fanned the frame out in this process. C1 adds the
second one on top of MUL-462's `publish(topic) / subscribe(topic)` peer channel
rather than on a link of its own: the adapter publishes `{kind: "head", key, head,
log_version}` on topic `hub` and feeds the peer's pointers into the receiving
ring, where the pool does the filling. Existing realtime events and the daemon
wake-up frame travel that same channel through MUL-462's own `realtime` topic.

Ordering stays the hub's job; the channel only moves small messages. A `trace:`
stream never enters it. Because the pointer is derived from the database rather
than from a durable queue, a dropped or late pointer cannot lose data — the
receiver's reconcile pass re-reads the head and fills the difference.

Hub peer counters and link state are reported in `/health.hub`; `/readyz` keeps
the role response from main and does not depend on peer health. A silent peer
link marks `peer_link=stale` after 15 seconds without forcing a reconciliation.

### 6. Close codes: four are terminal, everything else reconnects

The daemon's close codes have an explicit terminal set — **`4401`**
(authority revoked), **`4403`** (token lacks the scope), **`4410`** (daemon
retired) and **`4426`** (protocol v2 required). Any other code, including the
`1006` / `1011` / `1012` / `1013` / `1000` / `1001` the WebSocket stack produces
on its own, is an ordinary connection loss and is retried with backoff.

The set is deliberately a deny-list rather than an allow-list of retryable codes.
Defaulting to terminal is the dangerous direction: the code a daemon actually
observes when the network drops or a server is killed is `1006` (abnormal
closure, which the peer never emits), so an allow-list would make every one of
those "terminal" and leave a daemon unreachable until someone intervened.
Defaulting to retry costs a little reconnect churn for a code nobody anticipated.

`4426` is on the list although it is not permanent: the daemon must not retry the
socket, because the server rejects it again until the binary is upgraded. It
enters `upgrade_wait` and polls the HTTP upgrade channel instead.

### 7. What the browser socket carries

The browser WebSocket keeps its `auth` / `auth_ack` handshake and gains
`stream.subscribe` / `stream.unsubscribe` / `ping` upward and `stream.ack` /
`stream.data` / `stream.gap` / `stream.error` / `pong` downward. `stream.data`
carries a batch of `{seq, kind, payload}` frames with `kind` in
`entry | patch | trace`. The old `subscribe{scope}` frames and the
`task`/`chat` scopes are deleted in C12 — C3 only adds — so every intermediate
state of `agent/MUL-403` still runs.

## Alternatives considered

- **A hub that answers backfill reads from the database.** Makes the hub a second
  read route alongside MUL-402's window endpoints, with two implementations of the
  same query and two places to change when the log schema moves. The receiver-side
  pool fill above is a continuity repair of a ring the process already holds, not a
  read route: a subscriber that falls behind a gap is still sent to the endpoint
  that owns the window.
- **Routing every realtime event through the hub.** The lifecycle and
  workspace/user events have no sequence, so they would need one invented here,
  and the target scope is frozen. They stay invalidation signals; only `log:` and
  `trace:` become ordered streams.
- **「单进程 + 全局锁」** (the C0 draft's decision: one process holding one global
  advisory lock). It binds the whole realtime path to a single API process, and the
  server is being split into `ui` / `runtime` roles (MUL-455 / S10), so the second
  process would serve a silently partial stream. Replaced by one hub per process
  with per-role locks.
- **A PostgreSQL `LISTEN/NOTIFY` bus.** Not available: Bun 1.3.14's `Bun.SQL` has
  no `listen`/`notify` (it arrived in Bun 1.4.0), and an 8000-byte NOTIFY payload
  cannot carry a daemon trace batch anyway — a `trace:` stream has no home in the
  other process to fetch from.
- **A second PostgreSQL driver, only for `LISTEN`.** Adding `postgres` or any
  other driver means a second connection pool and a second set of failure modes
  for one notification path, when MUL-462's peer channel already exists.
- **An independent WebSocket peer link** (the route 7/6 planned as C1b:
  `/internal/hub`, `X-Peer-Secret`, `api/role.ts`, `EventBridge`; C1b was never
  opened). Superseded by MUL-462's `publish/subscribe` channel: it would duplicate
  that code, fight it for `MULTIREMI_PEER_URL` (one `ws://`, one `http://`) and put
  a second inter-process channel on production.
- **Fanning out every ring frame across processes** (so both processes hold every
  stream). It moves the heaviest data across the link for consumers only one
  process has, requires two copies of every ring plus two continuity judgements,
  and turns any frame loss into a `gap`.
- **A database table polled as a cross-process bus.** A `SELECT` every 100ms
  against PostgreSQL is exactly the load MUL-383 exists to remove.
- **Per-tab OPFS databases (wa-sqlite `opfs-wl`).** Connections and subscriptions
  grow with tab count, it introduces a non-official VFS, and it does not answer
  "which tab subscribes".
- **IndexedDB as the no-OPFS fallback.** Persistence is a hot-start optimisation
  only, so this buys little and costs a second storage implementation.
- **Retaining Virtuoso and fixing `initialTopMostItemIndex`.** Treats the symptom
  of a fake pagination model that is being replaced anyway.
- **Rendering on read with a height cache.** Shiki swapping in taller highlighted
  code is one of the main causes of the jumps being measured; caching helps only
  the second visit.
- **Making the connector derive cards and receipts from the stream.** MUL-400 E5
  makes the server write delivery rows; a second derivation would disagree with
  it.

## Consequences

- **Positive:** a browser reconnects by asking for `local_head + 1`, so recovery
  needs no cache invalidation and no refetch; per-session ordering is the same
  number the storage layer and the daemon use; the fan-out cost per frame is one
  buffered `send` per subscriber; and the replica survives navigation and
  reloads.
- **Negative:** the memory ceiling is real — each stream is capped at 1024 frames
  or 4 MiB, the process at 128 MiB, and streams with no subscriber are evicted by
  LRU after 15 minutes of no access. Eviction only shortens replay, because a
  short ring is reported as a `gap` and the subscriber backfills.
- **Negative:** two processes means the `log:` head pointer can arrive late. A
  late pointer is invisible to subscribers — the receiver fills the difference
  through the pool and the frames simply arrive later — but a channel that stays
  down for longer than the ring retains takes the ordinary `stream.gap` path.
  `trace:` is unaffected, because it never crosses.
- **Negative / recovery cost, stated once so it is not rediscovered in an incident:**
  a peer disconnect shows up as **lateness, not loss**, and the repair is **one
  reconcile pass** — MUL-462's 「可能漏了」 signal makes each process re-read the head
  of every `log:` stream it holds and fill the difference. That cost is bounded by
  the number of streams with subscribers, it happens once per reconnect rather than
  per frame, and it is why the pointer does not need a durable queue behind it.
- **Negative / transition:** while the topology runs `api=all` beside
  `api-runtime=runtime`, a daemon still attached to the `all` process keeps its
  trace in that process, so a browser routed to `runtime` cannot see it until the
  daemon reconnects. nginx sends daemon traffic to `runtime`, so the window is
  short.
- **Negative:** the advisory lock keys (`hashtext('remi:hub:ui')`,
  `hashtext('remi:hub:runtime')`) are a new lock namespace; they must not collide
  with MUL-405's migration constants or the parent-id transaction locks.
- **Negative:** a single-threaded fan-out can be delayed by a blocking
  `Atomics.wait`. Mitigations are pre-serializing frames once, batching per
  subscriber, merging flushes with `setImmediate`, and never blocking the producer
  on a slow subscriber. `/health` publishes stream count, ring occupancy, lagging
  subscriber count and flush p95; the reversal condition is flush p95 > 50ms
  sustained, which moves fan-out to a worker thread behind the same seam.
- **Negative:** `render_version` upgrades need a backfill. Rows whose stored HTML
  is stale render on the client, so the zero-jump target is not met for them until
  the backfill finishes, and the release notes must say how long that takes.
- **Neutral / open:** the DOM ceiling (Q4) and the 30-row first paint (Q3) are
  user-visible and stay unbuilt until confirmed.
- **Neutral / open:** whether `trace-reader` exposes `head(taskId)` for a cold
  `trace:` stream's warm-up is still being aligned with MUL-402; until then a cold
  trace stream reports `head: null` and the subscriber backfills the whole range.
- **Settled (was open in the C0 draft):** the trace completeness signal is the
  subscription's `closed` flag and nothing else. There is no `trace.end` event
  type and no `ended` field on any frame — MUL-402 ruled a terminator row out, and
  A-0's final `TraceSinkSubscription` carries `closed` as a live getter
  (`{first_seq, head, gap, closed, unsubscribe}`) beside `close?(taskId)`, which
  the hub calls when the task's trace is final. `task.complete` / `task.fail`
  frames carry `trace{head, event_count, closed: true, ...}`, so a receiver that
  sees the completion frame knows the trace it names is final. The Feishu
  connector therefore waits on `closed` instead of polling `/status`; C12 deletes
  that 400ms poll. Reading `closed` live is what makes it work without
  re-subscribing: a caller that holds one subscription for the life of a turn sees
  the flag flip.
