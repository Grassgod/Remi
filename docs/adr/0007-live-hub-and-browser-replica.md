# ADR 0007: One in-process Live Hub, with a browser replica instead of per-tab polling

## Status

Draft (MUL-403, message architecture v2-C). Written at C0, before the
implementation, per the plan's §4 outline (MUL-403 `cmt_8u0ols22z3a1`). C1–C11
fill in the code this ADR describes; the six decisions below are the ones the
implementation must not contradict without a new ADR.

Ten questions were put to the product owner (MUL-403 `cmt_7fdlky2b1tp4`). This
document records the **recommended** answer for each and marks it 「待确认」.
Q1, Q2 and Q5 are invisible to users and are already being built against the
recommendation; Q3, Q4, Q6 and Q7 are user-visible and stay unbuilt until they are
confirmed; Q8–Q10 are cross-issue scope and test environment, still open. A
different answer changes the named sub-deliverable and nothing else.

| # | Question | Assumed answer | Status |
|---|---|---|---|
| Q1 | Browser replica implementation | Web Locks leader + DedicatedWorker + official `sqlite-wasm` `opfs-sahpool` + BroadcastChannel | 待确认 (building on it) |
| Q2 | No OPFS / no Web Locks | In-memory replica, same protocol, no persistence | 待确认 (building on it) |
| Q3 | Timeline draws the last 30 only | Top row 「还有 N 条更早 ▸」, description always first, no auto-load on scroll-up | 待确认 (user-visible) |
| Q4 | DOM ceiling after dropping virtualization | Flat list, 300 rows, then a 「回到最新 ▾」 chip | 待确认 (user-visible) |
| Q5 | Feishu receipt fails after 6 retries | Silent: audit and log only; messages and cards unaffected | 待确认 |
| Q6 | 「执行过程」 loads on open only | All five entry points lazy | 待确认 (user-visible) |
| Q7 | Six further user-visible changes | All confirmed | 待确认 (user-visible) |
| Q8 | `useAnchoredReveal` / `useStickToBottom` move into C8 | Yes; MUL-390 becomes a consumer and keeps ADR 0008 | 待确认 (cross-issue) |
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

- **The API is a single Bun process, and it is single-threaded.** Fan-out happens
  on the same event loop that serves HTTP, so a slow subscriber must never block
  an append, and the fan-out cost per frame has to be one `send` per subscriber.
  MUL-383 answered its own "cross-process or explicitly single process" question
  in favour of single process (0/20 cross-process deliveries against 20/20
  in-process in a local measurement), so the design must state and enforce
  single-process rather than assume it.
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

We will replace the per-tab invalidation socket with a process-local Live Hub that
fans out two ordered streams, and give the browser a single local replica per
`(user, workspace)` instead of a per-tab view of the network.

### 1. One in-process hub, sequences taken from upstream

`packages/server/src/api/hub/` holds one `LiveHub` that serves two stream keys:
`log:<session_id>` (MUL-402's conversation log: display units and hidden markers)
and `trace:<task_id>` (MUL-401's trace events). The hub assigns **no** sequence:
a `log:` frame carries the conversation-log row's own `seq`, a `trace:` frame the
daemon's `trace_seq`. Deduplication follows from that — anything at or below the
head is a replay and is dropped.

The hub does **not** read the database to backfill. A subscription whose
`fromSeq` predates the retained ring gets `gap: {from, to}`, and the subscriber
fetches that range from the read route that owns it: the browser from
`GET /api/sessions/:id/log?anchor&before&after`, the Feishu connector from
`trace.fetch`, the server from MUL-402's `readTrace`. A cold stream reads
`head_seq` / `log_version` once at first subscription (C4's read pool) so the
first `stream.ack` is honest, and nothing more.

Single-process is a **runtime invariant**, not a convention: C1 takes a
`pg_try_advisory_lock` on a dedicated connection at startup, retries for 30 s (the
updater's `up -d --no-deps` stops then starts), and exits non-zero if it never
gets it. `HubTransport` is the seam for the opposite decision: a future
cross-process bus adds an adapter and leaves every subscription call site alone.

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
`data-perf-state=ready` (forced after an 800ms budget). Both hooks are C's (Q8),
named as MUL-390 planned them; ADR 0008 stays with MUL-390.

### 5. The adapter seam, not a bus

`HubTransport` has one implementation today, `local`, which does nothing on
publish because the hub already fanned the frame out in this process. The
interface exists so that C2's re-evaluation can add a cross-process adapter by
publishing every frame that entered a ring and feeding remote frames into the
local ring first. Ordering stays the hub's job; the bus only moves bytes.

### 6. What the browser socket carries

The browser WebSocket keeps its `auth` / `auth_ack` handshake and gains
`stream.subscribe` / `stream.unsubscribe` / `ping` upward and `stream.ack` /
`stream.data` / `stream.gap` / `stream.error` / `pong` downward. `stream.data`
carries a batch of `{seq, kind, payload}` frames with `kind` in
`entry | patch | trace`. The old `subscribe{scope}` frames and the
`task`/`chat` scopes are deleted in C12 — C3 only adds — so every intermediate
state of `agent/MUL-403` still runs.

## Alternatives considered

- **A hub that backfills from the database.** Makes the hub a second read route
  alongside MUL-402's window endpoints, with two implementations of the same
  query and two places to change when the log schema moves.
- **Routing every realtime event through the hub.** The lifecycle and
  workspace/user events have no sequence, so they would need one invented here,
  and the target scope is frozen. They stay invalidation signals; only `log:` and
  `trace:` become ordered streams.
- **A cross-process `LISTEN/NOTIFY` bus now.** MUL-383 measured cross-process
  delivery at 0/20 and there is one API process; a bus would buy nothing and cost
  a second source of truth. The `HubTransport` seam keeps the door open.
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
- **Negative:** the single-process constraint binds deployment. Adding a second
  API replica requires the `HubTransport` adapter first; without it the second
  process would serve a silently partial stream.
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
- **Neutral / open:** the trace termination signal for the Feishu connector (a
  `trace.end` row or an `ended` flag on the push frame) is still being aligned
  with the daemon side, and the 400ms `/status` poll is not deleted until it is.
