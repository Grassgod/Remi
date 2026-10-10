import { createPlan, type Report } from "../../../scripts/ci-backend.js";
import { describe, expect, it } from "bun:test";
import { failedBackendFiles, verifyRetryChanges, verifyShardedJobs } from "../../../scripts/retry-failed-backend-tests.js";

const finished = `tests/unit/example.test.ts:
(pass) passing case
(fail) timed out fixture

1 tests failed:
(fail) timed out fixture
1 pass
0 skip
1 fail
Ran 2 tests across 1 file. [8.00s]
[test-home] residual paths: []
`;

describe("verified backend retry", () => {
  it("selects files from actual failures without counting the repeated summary", () => {
    expect(failedBackendFiles(finished)).toEqual(["tests/unit/example.test.ts"]);
    expect(failedBackendFiles(finished.replace("tests/unit/example", "##[group]tests/unit/example"))).toEqual(["tests/unit/example.test.ts"]);
  });
  it("rejects interrupted suites, missing cleanup and mismatched failure inventories", () => {
    expect(() => failedBackendFiles(finished.replace("Ran 2 tests", "Ran 3 tests"))).toThrow();
    expect(() => failedBackendFiles(finished.replace("1 fail", "2 fail").replace("Ran 2 tests", "Ran 3 tests"))).toThrow();
    expect(() => failedBackendFiles(finished.replace("[test-home] residual paths: []", ""))).toThrow();
    expect(() => failedBackendFiles(finished.split("1 tests failed:")[0])).toThrow();
  });
  it("rejects unknown failure sources and unsafe paths", () => {
    expect(() => failedBackendFiles(finished.replace("tests/unit/example.test.ts:\n", ""))).toThrow();
    expect(() => failedBackendFiles(finished.replace("tests/unit/example", "tests/../example"))).toThrow();
  });
  it("allows retry infrastructure changes but rejects changed passed code or existing tests", () => {
    expect(() => verifyRetryChanges([".github/workflows/release-build-check.yml", "TESTING.md"])).not.toThrow();
    expect(() => verifyRetryChanges(["packages/server/src/worker/outbox.ts"])).toThrow();
    expect(() => verifyRetryChanges(["tests/unit/example.test.ts"])).toThrow();
    expect(() => verifyRetryChanges(["bun.lock"])).toThrow();
  });
});


it("sharded retry requires completed test failures and every non-backend job green", () => {
  const sha = "a".repeat(40);
  const plan = createPlan(["tests/a.test.ts"], 1, {}, sha, "tests", [], {});
  const report: Report = { schemaVersion: 1, sha, scope: "tests", shard: 0, startedAt: "start", finishedAt: "end", shardExitCode: 1, runner: { childExitCode: 1, homeEmpty: true, observerFailed: false, interrupted: false }, summary: { pass: 1, skip: 0, fail: 1, tests: 2, files: 1 }, files: [{ path: "tests/a.test.ts", seconds: 1, failures: 1 }] };
  const jobs = ["guards", "frontend-types", "frontend-tests", "cli-build", "api-build", "web-build", "session-archive-platform (ubuntu-latest)", "session-archive-platform (macos-latest)", "frontend-zero-jump", "frontend-replica", "backend-plan"].map(name => ({ name, conclusion: "success", steps: [] as { name: string; conclusion: string }[] }));
  jobs.push(...["backend-evidence", "backend-retry", "candidate-package"].map(name => ({ name, conclusion: "skipped", steps: [] })));
  jobs.push({ name: "backend (0)", conclusion: "failure", steps: [{ name: "Backend test shard", conclusion: "failure" }, { name: "Upload report", conclusion: "success" }] });
  jobs.push({ name: "build", conclusion: "failure", steps: [{ name: "Require every applicable check", conclusion: "failure" }] });
  expect(verifyShardedJobs(plan, [report], jobs)).toEqual(["tests/a.test.ts"]);
  expect(() => verifyShardedJobs(plan, [report], jobs.filter(job => job.name !== "web-build"))).toThrow();
  for (const [name, conclusion] of [["web-build", "failure"], ["backend-retry", "success"], ["backend-evidence", "success"], ["backend (0)", "cancelled"]]) {
    expect(() => verifyShardedJobs(plan, [report], jobs.map(job => job.name === name ? { ...job, conclusion } : job))).toThrow();
  }
  expect(() => verifyShardedJobs(plan, [report], jobs.map(job => job.name === "backend (0)" ? { ...job, steps: [...job.steps, { name: "Upload", conclusion: "failure" }] } : job))).toThrow();
});
