import { describe, expect, it } from "vitest";
import { createIssueDialogContentClass } from "./create-issue-dialog";

describe("createIssueDialogContentClass", () => {
  it("keeps manual and agent modes at the same collapsed size", () => {
    expect(createIssueDialogContentClass("agent", false, null)).toBe(
      createIssueDialogContentClass("manual", false, null),
    );
  });

  it("keeps manual and agent modes at the same expanded size", () => {
    expect(createIssueDialogContentClass("agent", true, null)).toBe(
      createIssueDialogContentClass("manual", true, null),
    );
  });

  it("does not carry the manual backlog hint size into agent mode", () => {
    expect(createIssueDialogContentClass("agent", false, "iss_backlog")).toBe(
      createIssueDialogContentClass("manual", false, null),
    );
  });
});
