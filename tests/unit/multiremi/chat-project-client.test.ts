import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Chat Project daemon claim transport", () => {
  it.each(["snake", "camel"] as const)("preserves the explicit Project marker in %s case", async (casing) => {
    let requestPath = "";
    const project = { id: "prj_chat", title: "Chat project", instructions: "Use project context", workspace_id: "local" };
    const task = casing === "snake" ? {
      id: "tsk_chat", prompt: "Continue", status: "dispatched", agent_id: "agt_chat",
      workspace_id: "local", chat_session_id: "chat_project", chat_project_id: project.id,
      project, project_resources: [{ id: "resource_chat", project_id: project.id, workspace_id: "local",
        resource_type: "local_directory", resource_ref: { local_path: "/abs/project", daemon_id: "directory" } }],
    } : {
      id: "tsk_chat", prompt: "Continue", status: "dispatched", agentId: "agt_chat",
      workspaceId: "local", chatSessionId: "chat_project", chatProjectId: project.id,
      project: { ...project, workspaceId: "local" },
      projectResources: [{ id: "resource_chat", projectId: project.id, workspaceId: "local",
        resourceType: "local_directory", resourceRef: { local_path: "/abs/project", daemon_id: "directory" } }],
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestPath = new URL(String(input)).pathname;
      return Response.json({ task });
    }) as unknown as typeof fetch;

    const claimed = await new MultiremiDaemonClient("https://remi.example", "daemon-test-token").claimTask("runtime-chat");

    expect(requestPath).toBe("/api/daemon/runtimes/runtime-chat/tasks/claim");
    expect(claimed).toMatchObject({
      id: "tsk_chat", chatSessionId: "chat_project", chatProjectId: project.id,
      issueId: null, project: { id: project.id, workspaceId: "local", instructions: "Use project context" },
      projectResources: [{ id: "resource_chat", projectId: project.id, resourceType: "local_directory",
        resourceRef: { local_path: "/abs/project", daemon_id: "directory" } }],
    });
  });

  it("does not infer a Chat binding from an unmarked legacy Project payload", async () => {
    globalThis.fetch = (async () => Response.json({ task: {
      id: "tsk_legacy", prompt: "Continue", status: "dispatched", agent_id: "agt_chat",
      workspace_id: "local", chat_session_id: "chat_legacy",
      project: { id: "prj_old_issue", title: "Historical Issue project" },
    } })) as unknown as typeof fetch;

    const claimed = await new MultiremiDaemonClient("https://remi.example", "daemon-test-token").claimTask("runtime-chat");

    expect(claimed.chatSessionId).toBe("chat_legacy");
    expect(claimed.chatProjectId).toBeNull();
  });
});
