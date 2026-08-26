import { describe, it, expect } from "vitest";
import { paths, isGlobalPath } from "./paths";

describe("paths.workspace(slug)", () => {
  const ws = paths.workspace("acme");

  it("builds workspace paths with slug prefix", () => {
    expect(ws.usage()).toBe("/acme/usage");
    expect(ws.issues()).toBe("/acme/issues");
    expect(ws.issueDetail("abc-123")).toBe("/acme/issues/abc-123");
    expect(ws.issueSession("abc-123", "session-1")).toBe(
      "/acme/issues/abc-123?session=session-1",
    );
    expect(ws.inboxIssue("abc-123", "session-1")).toBe(
      "/acme/inbox?issue=abc-123&session=session-1",
    );
    expect(ws.inboxItem("item-123", "session-1")).toBe(
      "/acme/inbox?item=item-123&session=session-1",
    );
    expect(ws.workbenchIssue("abc-123", "session-1")).toBe(
      "/acme/workbench?issue=abc-123&session=session-1",
    );
    expect(ws.projects()).toBe("/acme/projects");
    expect(ws.repositories()).toBe("/acme/repos");
    expect(ws.projectDetail("p1")).toBe("/acme/projects/p1");
    expect(ws.projectWiki("p1")).toBe("/acme/projects/p1/wiki");
    expect(ws.projectWikiPage("p1", "build-notes")).toBe(
      "/acme/projects/p1/wiki/build-notes",
    );
    expect(ws.knowledge()).toBe("/acme/knowledge");
    expect(ws.autopilots()).toBe("/acme/autopilots");
    expect(ws.autopilotDetail("a1")).toBe("/acme/autopilots/a1");
    expect(ws.agents()).toBe("/acme/agents");
    expect(ws.memberDetail("u1")).toBe("/acme/members/u1");
    expect(ws.inbox()).toBe("/acme/inbox");
    expect(ws.myIssues()).toBe("/acme/my-issues");
    expect(ws.runtimes()).toBe("/acme/runtimes");
    expect(ws.runtimeMachine("local:daemon-1")).toBe(
      "/acme/runtimes?machine=local%3Adaemon-1",
    );
    expect(ws.plugins()).toBe("/acme/plugins");
    expect(ws.pluginDetail("plugin_123")).toBe("/acme/plugins/plugin_123");
    expect(ws.skills()).toBe("/acme/skills");
    expect(ws.skillDetail("skl_123")).toBe("/acme/skills/skl_123");
    expect(ws.squads()).toBe("/acme/squads");
    expect(ws.squadDetail("sq_1")).toBe("/acme/squads/sq_1");
    expect(ws.settings()).toBe("/acme/settings");
    expect(ws.attachmentPreview("att_42")).toBe("/acme/attachments/att_42/preview");
  });

  it("URL-encodes special characters in ids", () => {
    expect(ws.issueDetail("id with space")).toBe("/acme/issues/id%20with%20space");
    expect(ws.issueSession("id with space", "session with space")).toBe(
      "/acme/issues/id%20with%20space?session=session%20with%20space",
    );
    expect(ws.inboxIssue("id with space", "session with space")).toBe(
      "/acme/inbox?issue=id%20with%20space&session=session%20with%20space",
    );
    expect(ws.inboxItem("item with space", "session with space")).toBe(
      "/acme/inbox?item=item%20with%20space&session=session%20with%20space",
    );
    expect(ws.workbenchIssue("id with space", "session with space")).toBe(
      "/acme/workbench?issue=id%20with%20space&session=session%20with%20space",
    );
    expect(ws.pluginDetail("plugin with space")).toBe(
      "/acme/plugins/plugin%20with%20space",
    );
    expect(ws.runtimeMachine("machine with space")).toBe(
      "/acme/runtimes?machine=machine%20with%20space",
    );
  });

  it("URL-encodes a non-ASCII wiki slug", () => {
    expect(ws.projectWikiPage("p1", "部署手册")).toBe(
      `/acme/projects/p1/wiki/${encodeURIComponent("部署手册")}`,
    );
  });
});

describe("paths (global)", () => {
  it("builds global paths without slug", () => {
    expect(paths.login()).toBe("/login");
    expect(paths.newWorkspace()).toBe("/workspaces/new");
    expect(paths.invite("inv-1")).toBe("/invite/inv-1");
    expect(paths.authCallback()).toBe("/auth/callback");
  });
});

describe("isGlobalPath", () => {
  it("returns true for pre-workspace routes", () => {
    expect(isGlobalPath("/login")).toBe(true);
    expect(isGlobalPath("/workspaces/new")).toBe(true);
    expect(isGlobalPath("/invite/abc")).toBe(true);
    expect(isGlobalPath("/auth/callback")).toBe(true);
  });

  it("returns false for workspace-scoped paths", () => {
    expect(isGlobalPath("/acme/issues")).toBe(false);
    expect(isGlobalPath("/")).toBe(false);
  });
});
