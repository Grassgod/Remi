# MUL-444 Step 4 local verification

The transcript reads `GET /api/tasks/:id/trace` only after opening. Live
dialogs subscribe through the trace socket and refill gaps from the trace read
endpoint. B5's page and share trace reads are routed to the runtime API role.

## Trace dialog

- `bun run tests/integration/task-trace-dialog-check.ts`: production Next build,
  zero trace requests before opening, and all five states in both `role=all`
  and UI/runtime route splitting passed. The split proxy sent every trace HTTP
  read to runtime. Results: `trace-dialog-check.json`; screenshots:
  `all-*-desktop.png`, `split-*-desktop.png`, `unreachable-mobile.png`.
- Split roles used separate local API app instances with a shared in-memory
  SQLite fixture. This verifies role guards and browser path routing, not a
  multi-process PostgreSQL deployment or WebSocket proxy configuration.
- Targeted views tests: 40 passed, 0 failed across the trace dialog and four
  related entry components. `bun run typecheck:frontend` and
  `bunx tsc --noEmit` passed.

## Earlier steps

- `bun run tests/integration/issue-log-check.ts --out reports/performance/MUL-444-step4/step1-regression`:
  3 cold opens and 3 in-app navigations had zero jumps; the four SSR failure
  paths recovered, and HTML sanitization checks passed.
- `bun run tests/integration/issue-log-check.ts --step2 --skip-build --out reports/performance/MUL-444-step4/step2-regression`:
  3 deep links had zero jumps, centered targets and stable highlight height.
- `bun run tests/integration/chat-log-check.ts --out reports/performance/MUL-444-step4/chat-regression`:
  tail SSR, earlier paging, ten sends, reconnect reconciliation and four SSR
  failure paths passed.
- `bun run tests/integration/zero-jump-check.ts --out reports/performance/MUL-444-step4/zero-jump.json`:
  9 scenario rows x 3 repetitions passed with no unlisted jump.

## Known integration gate

`bun test tests/unit/multiremi/api-role-guard.test.ts` reports 23 pass / 2 fail.
All route-by-route assertions pass. The two fixed route-count baselines are
pending the already planned parent merge sync: UI expects 70 and sees 86;
runtime expects 692 and sees 694. The counts were left unchanged here as
directed. The earlier full frontend run on this step's UI code had 37 failures
in the legacy `issue-detail.test.tsx`; migration of those tests is deferred
until the Step 1+2 QA result.
