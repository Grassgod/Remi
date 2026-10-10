import { describe, expect, it } from "bun:test";
import { failedBackendFiles, verifyRetryChanges } from "../../../scripts/retry-failed-backend-tests.js";

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
