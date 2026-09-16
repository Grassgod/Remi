import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat completion across Issue decoupling", () => {
  it.each(["completed", "failed"] as const)("does not restore an inherited Issue session when an old turn becomes %s", (status) => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Legacy Chat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Legacy Chat", provider: "codex", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Former Chat binding" });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: "Already running before migration" }).task;
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    // Migration retains the running task's Issue audit and Chat work directory,
    // but clears the provider pointer that included the old Issue bootstrap.
    db!.run("UPDATE multiremi_tasks SET issue_id = ? WHERE id = ?", [issue.id, task.id]);
    db!.run("UPDATE multiremi_chat_sessions SET work_dir = ? WHERE id = ?", ["/work/legacy-chat", chat.id]);
    if (status === "completed") {
      store.completeTask(task.id, { output: "Finished after migration", sessionId: "old-issue-provider-session", workDir: "/work/legacy-chat" });
    } else {
      store.failTask(task.id, { error: "Finished with an error", failureReason: "agent_error", sessionId: "old-issue-provider-session", workDir: "/work/legacy-chat" });
    }

    expect(store.getTask(task.id)).toMatchObject({ status, issueId: issue.id, sessionId: "old-issue-provider-session" });
    expect(store.getChatSession(chat.id)).toMatchObject({
      sessionId: null,
      sessionRuntimeId: null,
      sessionProvider: null,
      sessionExecutionFingerprint: null,
      workDir: "/work/legacy-chat",
    });
    expect(store.listChatMessages(chat.id).map((message) => message.role)).toEqual(["user", "assistant"]);
    const next = store.sendChatMessage(chat.id, { body: "Continue independently" }).task;
    expect(next).toMatchObject({ issueId: null, sessionId: null });
    expect(store.buildTaskSessionProjection(next.id)?.mode).toBe("bootstrap");
  });
});
