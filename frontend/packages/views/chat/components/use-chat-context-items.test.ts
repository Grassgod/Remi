import { describe, expect, it } from "vitest";
import { parseCurrentContextRoute } from "./use-chat-context-items";

describe("parseCurrentContextRoute", () => {
  it("detects issue detail pages", () => {
    expect(parseCurrentContextRoute("/acme/issues/issue-1", new URLSearchParams())).toEqual({
      type: "issue",
      id: "issue-1",
    });
  });

  it("detects project detail pages", () => {
    expect(parseCurrentContextRoute("/acme/projects/project-1", new URLSearchParams())).toEqual({
      type: "project",
      id: "project-1",
    });
  });

  it("keeps the project as context on its wiki routes", () => {
    expect(parseCurrentContextRoute("/acme/projects/project-1/wiki", new URLSearchParams())).toEqual({
      type: "project",
      id: "project-1",
    });
    expect(parseCurrentContextRoute("/acme/projects/project-1/wiki/runbook", new URLSearchParams())).toEqual({
      type: "project",
      id: "project-1",
    });
  });

  it("does not treat a deeper project path as project context", () => {
    expect(parseCurrentContextRoute("/acme/projects/project-1/wiki/a/b", new URLSearchParams())).toBeNull();
  });

  it("uses the inbox issue query param as the current issue id", () => {
    expect(parseCurrentContextRoute("/acme/inbox", new URLSearchParams("issue=issue-42"))).toEqual({
      type: "issue",
      id: "issue-42",
    });
  });

  it("does not treat the bare inbox route as current issue context", () => {
    expect(parseCurrentContextRoute("/acme/inbox", new URLSearchParams())).toBeNull();
  });
});
