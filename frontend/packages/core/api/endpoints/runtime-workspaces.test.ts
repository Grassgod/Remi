import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";
import { ChatEndpoints } from "./chat";
import { IssuesEndpoints } from "./issues";

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("Runtime workspace API boundary", () => {
  it("rejects Issue creation or edits that silently drop the selected directory", async () => {
    const issue = { id: "issue", workspace_id: "ws-1", number: 1, identifier: "LOCAL-1", title: "Local", description: null,
      status: "backlog", priority: "none", assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "user",
      parent_issue_id: null, project_id: null, position: 0, start_date: null, due_date: null, created_at: "now", updated_at: "now" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response(issue))));
    const api = new IssuesEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.createIssue({ title: "Local", runtime_workspace_id: "rws-local" })).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.updateIssue("issue", { runtime_workspace_id: "rws-local" })).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.patchIssue("issue", { runtime_workspace_id: "rws-local" })).rejects.toBeInstanceOf(ApiContractError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ task_id: "task", issue })));
    await expect(api.quickCreateIssue({ agent_id: "agent", prompt: "Local", runtime_workspace_id: "rws-local" })).rejects.toBeInstanceOf(ApiContractError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...issue, runtime_workspace_id: "rws-local" })));
    await expect(api.updateIssue("issue", { runtime_workspace_id: "rws-local" })).resolves.toMatchObject({ runtime_workspace_id: "rws-local" });
  });

  it("rejects malformed catalogs instead of losing the user's selected environment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ workspaces: [{ id: "w", root_path: 42 }] })));
    const api = new RuntimesEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.listRuntimeWorkspaces("ws-1")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("does not acknowledge a Chat when the server drops its workspace binding", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: "chat", workspace_id: "ws-1", agent_id: "agent", creator_id: "user", title: "Local", status: "active", has_unread: false, created_at: "now", updated_at: "now" }));
    vi.stubGlobal("fetch", fetch);
    const api = new ChatEndpoints(new HttpClient("https://api.example.test"));
    await expect(api.createChatSession({ agent_id: "agent", runtime_workspace_id: "rws-local" })).rejects.toBeInstanceOf(ApiContractError);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ runtime_workspace_id: "rws-local" });
    fetch.mockResolvedValueOnce(response({ id: "chat", workspace_id: "ws-1", agent_id: "agent", creator_id: "user", title: "Project", status: "active", has_unread: false, created_at: "now", updated_at: "now" }));
    await expect(api.createChatSession({ agent_id: "agent", project_id: "project" })).rejects.toBeInstanceOf(ApiContractError);
  });
});
