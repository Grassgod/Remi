import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { browserScopeKey, notifyBrowserTaskEvent } from "@multiremi/api/realtime.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Project Chat startup progress", () => {
  it("publishes scoped progress and recovers it from the pending task after reopening Chat", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "Prepare" }).task;
    const events: Array<{ type: string; task: any }> = [];
    store.onTaskEvent(event => events.push(event));
    store.reportProgress(task.id, "正在准备项目仓库…", 1, 3);
    expect(events.map(event => event.type)).toEqual(["task:progress"]);
    const frames: string[] = [];
    const unrelatedFrames: string[] = [];
    const chatClient = { sendText: (frame: string) => frames.push(frame) } as any;
    notifyBrowserTaskEvent(
      new Map([["local", new Set([{ sendText: (frame: string) => unrelatedFrames.push(frame) } as any])]]),
      new Map([[browserScopeKey("chat", chat.id), new Set([chatClient])]]),
      events[0]!.type, events[0]!.task,
    );
    expect(JSON.parse(frames[0]!)).toMatchObject({ type: "task:progress", payload: {
      chat_session_id: chat.id, task_id: task.id, progress_summary: "正在准备项目仓库…",
    } });
    expect(unrelatedFrames).toEqual([]);
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/chat/sessions/${chat.id}/pending-task`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: task.id, progress_summary: "正在准备项目仓库…" });
  });

  it("keeps pure Chat and Issue topic progress behavior unchanged", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    const issue = store.createIssue({ title: "Issue", projectId: project.id });
    const app = createMultiremiApp({ store });
    for (const topic of [false, true]) {
      const chat = store.createChatSession({ agentId: agent.id, ...(topic ? { projectId: project.id } : {}) });
      if (topic) bindFeishuTopicFixture(store, db!, chat.id, issue.id);
      const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Work",
        ...(topic ? { issueId: issue.id } : {}) });
      const events: string[] = [];
      const unsubscribe = store.onTaskEvent(event => events.push(event.type));
      expect(store.reportProgress(task.id, "Original startup line", 1, 3).progressSummary).toBe("Original startup line");
      expect(events).toEqual([]);
      unsubscribe();
      const response = await app.request(`/api/chat/sessions/${chat.id}/pending-task`);
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("progress_summary");
    }
  });
});
