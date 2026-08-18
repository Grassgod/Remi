import { describe, expect, it } from "vitest";
import { paths } from "../paths";
import { getAutopilotRunHref } from "./run-link";

describe("getAutopilotRunHref", () => {
  const wsPaths = paths.workspace("acme");

  it("deep-links a trigger-issue run to the Session created for that run", () => {
    expect(
      getAutopilotRunHref(wsPaths, {
        issue_id: "issue-1",
        issue_session_id: "session-1",
      }),
    ).toBe("/acme/issues/issue-1?session=session-1");
  });

  it("falls back to the Issue when a run has no Session id", () => {
    expect(
      getAutopilotRunHref(wsPaths, {
        issue_id: "issue-1",
        issue_session_id: null,
      }),
    ).toBe("/acme/issues/issue-1");
  });

  it("does not create a link for a standalone run", () => {
    expect(
      getAutopilotRunHref(wsPaths, {
        issue_id: null,
        issue_session_id: null,
      }),
    ).toBeNull();
  });
});
