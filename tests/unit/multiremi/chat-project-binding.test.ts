import { afterEach, describe, expect, it } from "bun:test";
import { ChatValidationError } from "@multiremi/store/repos/chat-repo.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat Project binding", () => {
  it("creates optional Project bindings with explicit null taking precedence over the alias", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project context" });
    const create = (fields = {}) => store.createChatSession({ agentId: agent.id, ...fields });
    expect(create().projectId).toBeNull();
    expect(create({ projectId: project.id }).projectId).toBe(project.id);
    expect(create({ project_id: project.id }).projectId).toBe(project.id);
    expect(create({ projectId: null, project_id: project.id }).projectId).toBeNull();
    expect(store.listChatSessions().filter((chat) => chat.projectId === project.id)).toHaveLength(2);
  });

  it("rejects missing, foreign, archived and malformed Projects", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const other = store.createWorkspace({ name: "Other", slug: "chat-project-other" });
    const foreign = store.createProject({ title: "Foreign", workspaceId: other.id });
    const archived = store.createProject({ title: "Archived" });
    store.archiveProject(archived.id);
    for (const projectId of [foreign.id, archived.id, "missing", "", 123]) {
      expect(() => store.createChatSession({ agentId: agent.id, projectId } as any)).toThrow(ChatValidationError);
    }
  });
});
