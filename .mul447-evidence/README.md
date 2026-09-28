# MUL-447 Step 1 Evidence

Scope: step 1 items 1-4 implemented; item 5 deferred under the issue's explicit
fallback. Steps 2 and 3 are not implemented. Independent strict QA is pending.

## Inputs

- Initial branch: `agent/MUL-447` at `b95dd2fa`.
- Ordered merge of `agent/MUL-403` at `c366a949`: `6fd1e434`.
- Then merge of `agent/MUL-421` at `17e92d48`: `f0f340b9`.
- Parent rulings: `cmt_i2j9hbxusljl`, `cmt_culn1zd0rgk3`.
- Prerequisite reconciliation: `69143233`. It preserves the main branch's
  batched runtime list and MUL-421's protocol projection, without raising the
  existing query-count budgets. The wire golden adds only prerequisite protocol
  fields; replica fixture changes correct types, not QA assertions.

## Acceptance Mapping

| Requirement | Evidence |
| --- | --- |
| Resume at `throughSeq + 1`, no duplicates or omissions | `tests/unit/connectors/feishu-trace-subscription.test.ts`: consumed checkpoint case; `tests/unit/multiremi/feishu-concierge-host.test.ts`: saved checkpoint 7 produces event 8 |
| Reconnect from consumed cursor | Subscription disconnect case uses the real `DaemonTraceSubscriptions`; local integration asserts wire cursors `[2,4]` and received sequences `[3,4,5,6]` |
| `closed` ends the workflow | Empty closed stream test, plus real daemon/API terminal push and native `RUN_FINISHED` in local integration |
| Unknown type remains unchanged | Subscription/timeline raw-object and complete-payload assertions; integration's `future.widget` native event |
| No connector gap backfill | Connector calls only `subscribeTrace`; prerequisite `trace.test.ts` covers internal `trace.fetch` for gaps |
| No 400 ms messages/status polling | Local integration asserts zero messages GETs, no status reads before closed, exactly one final status GET |

The connector scope command completed with **412 pass, 0 fail**:

```sh
bun test tests/unit/connectors \
  tests/unit/multiremi/feishu-concierge-host.test.ts \
  tests/unit/multiremi/feishu-task-command-handler.test.ts \
  tests/unit/multiremi/feishu-cancel-wire-compat.test.ts \
  tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts \
  tests/unit/daemon/trace-derive.test.ts
```

Prerequisite upgrade/projection/performance cases completed with **28 pass, 0 fail**:

```sh
bun test tests/integration/daemon-protocol-v2/upgrade-channel.test.ts \
  tests/unit/multiremi/runtime-protocol.test.ts \
  tests/unit/multiremi/first-screen-hotspots-auth-runtimes.test.ts \
  tests/unit/multiremi/first-screen-hotspots-pr2-golden.test.ts
```

Other successful local checks: `bunx tsc --noEmit`, `npm run docs:test`
(13 tests), `npm run docs:check`, API snapshot check, and CLI capability checker
(678 mapped / 70 exempt / 0 missing / 748 routes).

The broader prerequisite regression also completed with **1129 pass, 0 fail**:

```sh
bun test tests/arch/ tests/unit/daemon/ tests/integration/daemon-protocol-v2/ \
  tests/unit/multiremi/api-role-guard.test.ts \
  tests/unit/multiremi/api-role-peer-unification.test.ts \
  tests/unit/multiremi/realtime-fanout.test.ts \
  tests/unit/multiremi/cli-capabilities-manifest.test.ts
```

## Mutation Tests

Actual source mutations, not simulated expectations:

1. Pass `throughSeq + 1` to `daemon.subscribeTrace`: the consumed checkpoint
   test fails, receiving `[5,6]` instead of `[4,5,6]`. See `mutation-cursor.log`.
2. Remove the `closed` branch: the empty closed stream test fails with
   `TimeoutError`. See `mutation-closed.log`.

Both mutations were reverted; all five subscription tests passed again.

## Local Integration

```sh
MULTIREMI_TEST_MUL447_EVIDENCE_PATH=.mul447-evidence/step1-local-integration.json \
  bun test tests/integration/feishu-trace-subscription.test.ts
```

Result: **1 pass, 0 fail**, 15 assertions. Real local Bun API, real co-resident
daemon, real sockets and temporary SQLite/outbox/trace state. The provider trace
and Feishu sender are simulated; no real Feishu message was sent. All services
and temporary data are disposed by the harness.

The JSON and self-contained HTML record native CoT events, trace subscription
RPCs, and local HTTP method/path pairs. No headers, tokens or credentials are
recorded. Checkpoint 2 receives 3; after consuming 4 and disconnecting, wire
cursor 4 resumes at 5. Received `[3,4,5,6]`; final checkpoint 6; `closed` ends the
stream on the existing native message.

## Item 5 Gap

`subscribeHumanRequests` is API-process local in the Hub interface; the concrete
Hub on `agent/MUL-436` is also API-process local. The connector lives with
`MultiremiDaemon`, in another process. `task.human_request.settled` appears in
the daemon protocol vocabulary, but `agent/MUL-421` has no producer or receiver
for this push. No existing cross-process E5/Hub event subscription is available
to the connector. Wiring that existing transport is required before removing
the interaction lane's 750 ms loop.

Therefore `apps/remi/cli/multiremi.ts` retains its human-request `sleep(750)`.
This CoT fixture has no human requests: its zero human-request GET count does
**not** prove item 5 complete. No new protocol API or contracts change was added.

## Repository Search

Repository code search found no `pollFeishuTask` or
`listFeishuBotTaskMessages` references. No `sleep(400)` remains in the connector;
two unrelated `Bun.sleep(400)` calls in task-steer test synchronization are out
of scope. The one `sleep(750)` above is deliberately retained and reported.
Old routes/frames from steps 2 and 3 remain outside this change.

Production 209 and Wiki were not modified. No deployment, branch switching,
default-branch push, or PR merge was performed.
