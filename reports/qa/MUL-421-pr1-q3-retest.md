# MUL-421 PR 1: Q3 Regression Evidence

This records the regression procedure, not an acceptance result. QA owns the
strict review. Final command output is attached to the MUL-401 delivery comment
and linked from [PR #313](https://github.com/Grassgod/Remi/pull/313).

## Reported Failures

QA reviewed `17e92d48` in MUL-401 comment `cmt_83bl29jv5sn7`:

- Full suite: 5678 pass, 222 skip, 1 fail; the retired-daemon authority body
  deadline in `multiremi-daemon-heartbeat.test.ts` timed out.
- Four directories: 4564 pass, 222 skip, 1 fail, 1 error; the 4426 upgrade probe
  in `upgrade-channel.test.ts` exceeded its existing five-second budget.
- Both tests passed separately. The same revision's CI PostgreSQL backend had
  5868 pass and 0 fail. These results do not cancel either local failure.

## Final-Head Procedure

Use a new detached worktree at this report's commit, Bun 1.3.14, the public npm
registry, and `bun install --frozen-lockfile`. Run these suites sequentially and
preserve unfiltered output, including skips and failures:

```sh
bun test
bun test tests/arch/ tests/unit/daemon/ tests/unit/multiremi/ tests/integration/daemon-protocol-v2/
```

If either reported timeout recurs, run both commands unchanged in a separate
detached worktree at `b8608f71`. A failure only on this PR requires diagnosis;
one also present on the parent is reported as existing, with both raw outputs.
Do not increase timeouts, skip cases, or substitute single-test results.

The local host has no `postgres`, `psql`, `pg_ctl`, `initdb`, or `docker` on PATH.
Local PostgreSQL coverage is unavailable; skipped tests are not passes. Verify
the final revision's CI PostgreSQL job and retain its raw output. Any local PG
run must use `env -u MULTIREMI_TOKEN`. Tests must use local services only.

Other gates remain mandatory: TypeScript, docs tests/checks, API route snapshot,
CLI capabilities with zero missing mappings, and all final-head CI checks.
