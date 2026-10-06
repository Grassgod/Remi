import { describe, expect, it } from "bun:test";
import { findSsrSeedRereads } from "../../integration/zero-jump-check";

const request = (path: string, query = "") => ({ path, query });
const seededReads = [
  request("/api/issues/issue-1"),
  request("/api/issues/parent-1"),
  request("/api/issues/issue-1/sessions"),
  request("/api/issues/issue-1/children"),
  request("/api/issues/issue-1/task-runs"),
  request("/api/workspaces/ws-1/members"),
  request("/api/sessions/session-1/log", "?anchor=0&before=1"),
  request("/api/sessions/session-1/log", "?anchor=40&before=1&after=0"),
];
const bootstrap = {
  ssrSeed: true, workspaceId: "ws-1", issueId: "issue-1", parentIssueId: "parent-1", sessionId: "session-1",
};

describe("Issue SSR seed request gate", () => {
  it("rejects every seeded data reread, including seq-0 and replay rows", () => {
    expect(findSsrSeedRereads({ ...bootstrap, requests: seededReads })).toEqual(seededReads);
  });

  it("permits CSR reads when no seed was rendered", () => {
    expect(findSsrSeedRereads({ ...bootstrap, ssrSeed: false, requests: seededReads })).toEqual([]);
  });

  it("allows data outside this seed, optional queries and history pagination", () => {
    expect(findSsrSeedRereads({ ...bootstrap, requests: [
      request("/api/issues/other-issue"), request("/api/workspaces/other-ws/members"),
      request("/api/issues/issue-1/subscribers"), request("/api/me"),
      request("/api/sessions/other-session/log", "?anchor=0&before=1"),
      request("/api/sessions/session-1/log", "?anchor=10&before=30"),
    ] })).toEqual([]);
  });
});
