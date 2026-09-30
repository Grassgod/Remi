# MUL-444 A-stage integration report

Validated code head: `86065b9eec516b1ce38fe8cd165cfb4559832b3c`.
Branch: `agent/MUL-444`, Draft PR #327, target `agent/MUL-403`.
Changes since step 4: merge `8088bdbf`, test adaptation `ebd0d3f7`, golden recapture `86065b9e`.

## Parent merge and targeted checks

- Merged parent `41e81555`. The resulting `server.ts` keeps the parent's single Hub, stream auth and read-pool initialization, while the two trace HTTP reads route to runtime. `api-role-guard.test.ts` derives UI/runtime counts from explicit route rules, including those two trace reads: 25/25 passed. The earlier UI refused count of 86 becomes 88 because `GET /api/tasks/:id/trace` and `GET /api/shares/:token/tasks/:task_id/trace` are runtime-owned. The full UI count is 89 including the upgrade-only daemon socket; runtime is 694 scanned / 696 full. The generated API route inventory has 793 routes and CLI coverage has 682 mapped, 111 exempt, 0 missing.
- `multiremi-api-realtime.test.ts`: 9/9. The parent fanout passes `store` to the creator notification path.
- `body-html-backfill.test.ts`: 16/16 after using the migrated table rather than creating it twice.
- Regenerated `scripts/api-routes.golden.json`; `body_html` is non-null for the snapshot Issue, session message, and result entries.
- `issue-detail.test.tsx`: 59/59. Fourteen deleted Virtuoso/timeline cases have an individual coverage map in [issue-detail-coverage.md](issue-detail-coverage.md); retained cases use the seq-window model.
- Frontend full suite: core 1235 passed, views 2488 passed and 18 skipped, web 60 passed, no failures. Backend `tsc`, frontend typecheck, and architecture suite 151/151 passed.
- Regenerated the task-message fanout golden with `bun run tests/fixtures/multiremi/capture-task-message-fanout-golden.ts`. Four `created_at` values moved by 3 ms because the merged migration set advances the deterministic fixture clock; every other captured field matches. The targeted golden checks passed 18/18.

## Browser checks on the fixed head

All checks use production-mode Next, local API, temporary data, and Chromium. These reports contain local fixture data only; service logs are not part of this delivery.

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Trace dialog | `bun run tests/integration/task-trace-dialog-check.ts --out reports/performance/MUL-444-A/trace` | 15/15, all-role and UI/runtime split, five states, mobile | [trace-dialog-check.json](trace/trace-dialog-check.json) |
| Chat log | `bun run tests/integration/chat-log-check.ts --out reports/performance/MUL-444-A/chat` | 12/12, tail 30, manual prepend stable, ten sends stay pinned and deduplicated after reconnect, four SSR fallbacks | [chat-check.json](chat/chat-check.json) |
| Issue first screen | `bun run tests/integration/issue-log-check.ts --out reports/performance/MUL-444-A/issue-step1` | 68/68, cold and navigation jumps 0 | [report.json](issue-step1/report.json) |
| Issue deep links | `bun run tests/integration/issue-log-check.ts --step2 --out reports/performance/MUL-444-A/issue-step2` | 26/26, deep link and both window expansions stable | [report.json](issue-step2/report.json) |
| Full zero-jump matrix | `bun run tests/integration/zero-jump-check.ts --strict --out reports/performance/MUL-444-A/zero-jump.json` | 27/27, all `jumps=0` | [zero-jump.json](zero-jump.json) |

## Full backend regression

- SQLite: `env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL bun test` on the fixed head: 6289 passed, 416 skipped, 1 failed across 491 files. The failure is `MUL-458 human dependency force (SQLite) > rolls back task, status and force activity together when force audit fails`, assigned to the B1/main transaction reconciliation in MUL-402. No test threshold or assertion was relaxed.
- Real PostgreSQL 17.5, `role=all`: `env -u MULTIREMI_TOKEN MULTIREMI_TEST_POSTGRES_URL=<private-local-PG> bun test --preload <role-all-preload> tests/unit/ tests/integration/`: 6481 passed, 24 failed across 478 files. Twenty-three are the same B1/main transaction cases that failed CI; the remaining one is the P8 timeout below. The exact CI failure names are in [WAIT-402.md](WAIT-402.md). No production database was used; the private PG instance was stopped and removed after the run.

## P8: pending-tasks query-count test

The SQLite run passes 10/10 and the targeted case takes about 2 seconds. With a private PostgreSQL 17.5 instance and the same 20-second limit, the target case on this head timed out at 21.68 seconds after 11 assertions; parent `41e81555` passed the same source test on the same instance in 18.64 seconds. Instrumentation places the extra time in fixture setup: seeding 200 Chats takes about 11.26 seconds, while the actual pending-tasks read takes about 34 ms. The fixture calls B1's `sendChatMessage` for each Chat, which now mirrors into the conversation log inside its transaction. This is a B1/main integration performance follow-up for MUL-402; the query-count behavior itself remains constant. The 20-second limit was not raised.

## CI and follow-up

PR #327 on the validated code head: six checks succeeded; `build` failed in Backend test suite (run `36520460248`). It ran 6628 passed, 6 skipped, 23 failed. Architecture guards and CLI capability coverage passed before that step; the later frontend CI steps were skipped because the backend step failed, while the separate frontend-replica and frontend-zero-jump checks passed. All 23 names and their owner are in [WAIT-402.md](WAIT-402.md). The outstanding transaction and PostgreSQL timing items retain their real red status until MUL-402 supplies a reconciled head; this report does not treat them as green.
