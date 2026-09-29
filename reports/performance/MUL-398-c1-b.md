# MUL-398 C-1: observe by default, enforce explicitly

This report implements Senior ruling B (`cmt_q2m2lomd48pm`) and the continuation steering. It supersedes the earlier rejection-default validation. PR #318 stays Draft. No production access, configuration change, deployment or browser verification was performed.

## Implementation and merge

- Archive `84101310` preserves HEAD-to-GET lookup and the 15 QA messaging exceptions. The exception set is frozen there: 418 HTTP keys plus one independent background key. Workspace context, source allowlist and MUL-487 human-request card findings are not added.
- Archived the current 57-column probe work in `a03b2d0a`, then merged main `57f42dec5db6a03fb555ba5a764aa3b5a099c2bb` in `1b1a0392`. The only conflict was the blank line after `MeteredDb`'s constructor in `bench-repository-wikis-a2-scale.ts`; its delegated dialect marker and main's SQLite factory migration both remain. MUL-460's `markSqliteDialect(getDb())` change affects the SQLite branch, not the PostgreSQL policy or parse guard.
- Product edits remain in `request-metrics.ts` and `postgres.ts`. No repo projection or pagination algorithm was changed.
- `MULTIREMI_PG_REPLY_MAX_BYTES`: unset/empty = 8,388,608; 0 disables the configured threshold; invalid values fall back and warn with only the raw value as variable information.
- `MULTIREMI_PG_REPLY_ENFORCE`: unset/empty/0 = observe; 1 = enforce; invalid = observe and one warning at cached resolution. Production default is off. C-2 needs fresh authorization to change that default.
- Effective ceiling is 64 MiB when exempt, observing, or threshold=0; otherwise min(threshold, 64 MiB). The bridge and `postgresReplyMaxBytes()` share this calculation, and MUL-462 uses that value. Observe mode therefore retains eight-row pages everywhere. Configuration is cached; each SQL reads context and checks the frozen Set once.
- `api_large_db_reply` retains one line per >1 MiB reply, without throttling or a new event. Added fields are `limit_bytes`, `exempt`, `enforced`; no SQL, parameters or request values. `api_db_reply_rejected` appears only for actual enforced rejection, before decode/parse. The worker's 64 MiB physical limit remains in all modes.
- Hermetic preload explicitly uses 8 MiB and ENFORCE=1. Guards assert equal thresholds and the enforced test default. Production observes to preserve current HTTP behavior; tests still expose unbounded reads.
- HEAD continues to dispatch through GET keys, metrics=0 still creates request context, and the two pagination caller guard remains. Request-started detached async work inherits the route context; timer-started work has background context.

## Reproduction

Use a self-owned loopback PostgreSQL instance. Supply its admin target through the existing `MULTIREMI_TEST_POSTGRES_URL` input; do not print it or persist it. A locked detached worktree supplies main's source/dependencies. Each run creates and drops its own database. Requests use a 20-second timeout and no external service.

```bash
env -u MULTIREMI_TOKEN bun tests/manual/probe-pg-reply-c1-routes.ts --root <main-worktree> --out reports/performance/MUL-398-c1-b-main-routes.json
env -u MULTIREMI_TOKEN bun tests/manual/probe-pg-reply-c1-routes.ts --out reports/performance/MUL-398-c1-b-observe-routes.json
env -u MULTIREMI_TOKEN bun tests/manual/probe-pg-reply-c1-routes.ts --enforce --out reports/performance/MUL-398-c1-b-enforced-routes.json
env -u MULTIREMI_TOKEN bun tests/manual/probe-pg-reply-c1-matrix.ts --root <main-worktree> --out reports/performance/MUL-398-c1-b-main-matrix.json
env -u MULTIREMI_TOKEN bun tests/manual/probe-pg-reply-c1-matrix.ts --enforce --out reports/performance/MUL-398-c1-b-enforced-matrix.json
env -u MULTIREMI_TOKEN bun tests/manual/report-pg-reply-c1-probe.ts
```

The full fixture populates 57 representative payload columns at >=9 MiB; task transcript is 96 x 256 KiB = 24 MiB, within its writer's row cap. An isolated matrix reruns every GET/HEAD per column to attribute failures to a root instead of hiding later reads behind workspace context. Actual app registration is used, including template messaging routes. This is coverage of payload categories, not a claim that every one of 1,562 schema columns (including identifiers, enums, credentials and internal records) has a reachable long row.

`maxReplyBytes` is the largest single bridge reply while a request runs. Successful statements use the same `JSON.stringify({rows,count})` serialization as the worker; rejected statements use the exact logged bridge length. This is neither HTTP body length nor aggregate request `db_bytes`. Raw attachments contain patterns, statuses, byte counts and reasons; no bodies, real IDs, SQL, credentials or connection strings.

## Column risks and recommended C-2 work

- `WorkspacesRepo.getWorkspace/listWorkspaces` selects the context/settings row before many handlers and access guards. Project only required workspace columns for guards/config/list consumers; bound context writes when the full context is required. The initial stop measured 21 affected patterns from context alone.
- `MessagingRepo.listSources/getSource` selects allowlist/name even for connection/conversation consumers. Project metadata, separately fetch the needed allowlist, and bound each entry plus total serialized bytes. The initial stop measured eight additional patterns; these are not exception additions.
- MUL-487 `getTaskHumanRequest` reads payload/response whole-row for card delivery. Read only the card fields or give payload/response an explicit writer budget. That POST is statically reviewed, not included in the GET/HEAD probe.
- For capped writes C and bounded reads L, reason about L x C and JSON escaping; capped writes with unbounded collection reads still need paging/projection. Single 9 MiB rows that bypass an application cap are contract stress tests, not evidence ordinary clients can store that row.
- The runtime/schema audit remains manual report-only: classification has unresolved conservative candidates. Its green smoke guard does not prove the frozen exception table complete. The enforced matrix is a C-2 seed, not production rejection authorization.

## Background withdrawal list

Nine reader classes remain: scheduled target runs; SCM polling; issue-title scheduling; messaging scheduling; outbound-dispatcher sweep; task-capability monitor; repository-wiki storage jobs; WebSocket message processing (subscribe scope and daemon heartbeat); startup migrations. Queued runs must be bounded before removing background, and production single-reply observations after an instrumented version is deployed must remain below 6 MiB. The 20 x 512 KiB queued sample demonstrates the contract, not production size (Senior reported about 4.6 KiB average run rows). A background reply at or beyond 64 MiB is an existing physical-limit failure and is not repaired here.

Rollback the final PR merge with `git revert -m 1 <merge>`. If enforcement was explicitly enabled, ENFORCE=0 or MAX_BYTES=0 disables configured rejection. Production edits remain the maintainer's decision; C-1 neither changes production settings nor claims a deployment time.

## Verification

Results are added after execution. Page checks are waived by ruling B; no browser session or messaging write-action probe is claimed. All full suites use the hermetic 8 MiB/ENFORCE=1 defaults and the default-on lock-order sentinel. Owned PostgreSQL, detached worktrees and temporary directories are removed before delivery.
