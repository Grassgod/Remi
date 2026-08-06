import { describe, expect, it } from "vitest";

import type { SessionResult } from "../types";
import { sessionResultKind, sessionResultRefs } from "./session-results";

function makeResult(metadata: Record<string, unknown>): SessionResult {
  return {
    id: "sres-1",
    issue_id: "issue-1",
    source_session_id: "session-main",
    title: "Merged the projection fix",
    body: "Landed on main.",
    metadata,
    published_by_type: "agent",
    published_by_id: "agent-1",
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("sessionResultKind", () => {
  it("returns a known kind", () => {
    expect(sessionResultKind(makeResult({ kind: "mr" }))).toBe("mr");
    expect(sessionResultKind(makeResult({ kind: "deploy" }))).toBe("deploy");
    // Published by the daemon's auto-checkout, not the CLI.
    expect(sessionResultKind(makeResult({ kind: "branch" }))).toBe("branch");
  });

  it("degrades to other for absent, unknown, or non-string kinds", () => {
    expect(sessionResultKind(makeResult({}))).toBe("other");
    expect(sessionResultKind(makeResult({ kind: "merge-request" }))).toBe("other");
    expect(sessionResultKind(makeResult({ kind: 7 }))).toBe("other");
    expect(sessionResultKind(makeResult({ kind: null }))).toBe("other");
    // A result whose metadata never survived parsing at all.
    expect(sessionResultKind({ ...makeResult({}), metadata: undefined as never })).toBe("other");
  });
});

describe("sessionResultRefs", () => {
  it("keeps well-formed refs in order", () => {
    expect(
      sessionResultRefs(
        makeResult({
          refs: [
            { type: "issue", value: "MUL-12" },
            { type: "url", value: "https://example.test/mr/12" },
          ],
        }),
      ),
    ).toEqual([
      { type: "issue", value: "MUL-12" },
      { type: "url", value: "https://example.test/mr/12" },
    ]);
  });

  it("keeps an unknown ref type as written", () => {
    expect(sessionResultRefs(makeResult({ refs: [{ type: "dashboard", value: "ops-7" }] })))
      .toEqual([{ type: "dashboard", value: "ops-7" }]);
  });

  it("degrades to no refs when the list is missing or not an array", () => {
    expect(sessionResultRefs(makeResult({}))).toEqual([]);
    expect(sessionResultRefs(makeResult({ refs: null }))).toEqual([]);
    expect(sessionResultRefs(makeResult({ refs: "issue:MUL-12" }))).toEqual([]);
    expect(sessionResultRefs({ ...makeResult({}), metadata: undefined as never })).toEqual([]);
  });

  it("drops malformed entries instead of the whole list", () => {
    expect(
      sessionResultRefs(
        makeResult({
          refs: [
            "issue:MUL-12",
            null,
            { type: "task" },
            { type: 9, value: "MUL-13" },
            { value: "MUL-14" },
          ],
        }),
      ),
    ).toEqual([
      { type: "", value: "MUL-13" },
      { type: "", value: "MUL-14" },
    ]);
  });
});
