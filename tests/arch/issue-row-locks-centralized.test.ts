import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// ADR 0003 #8: IssuesRepo takes Issue row locks only through issue-row-lock,
// so every lock set is one ascending batch and can be audited in one place.
it("IssuesRepo has no hand-written Issue row lock", () => {
  const source = readFileSync("packages/server/src/store/repos/issues-repo.ts", "utf8");
  expect(source).not.toMatch(/SET\s+id\s*=\s*id/i);
});
