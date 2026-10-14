import { createResponsibleTestIssue } from "./helpers.js";
import { expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

// A person retries their own Chat's failed or cancelled turn through the turn
// API. Issue turns and other credentials keep the supervisor requirement.
pendingTurnBackendTests("Chat creator turn retry", (fixture) => {
  async function scaffold() {
    const { store } = fixture();
    const user = store.getOrCreateUser({ externalId: "chat-retry-creator", name: "Creator" });
    const member = store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
    const otherUser = store.getOrCreateUser({ externalId: "chat-retry-other", name: "Other" });
    store.createWorkspaceMember({ userId: otherUser.id, name: otherUser.name, role: "admin" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", visibility: "workspace" });
    const runtime = store.registerRuntime({ name: "Retry host", provider: "codex", daemonId: "chat-retry", maxConcurrency: 16 });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: user.id });
    const pat = await store.createAccessToken({ name: "Creator", type: "pat", userId: user.id, workspaceId: "local" });
    const otherPat = await store.createAccessToken({ name: "Other", type: "pat", userId: otherUser.id, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "chat-retry-master" });
    const retry = async (turnId: string, body: Record<string, unknown> = {}, auth = pat.token) => {
      const response = await app.request(`/api/turns/${turnId}/retry`, { method: "POST",
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    /** Send a Chat message and run its attempt; returns the attempt and its turn. */
    const run = (body: string) => {
      const task = store.sendChatMessage(chat.id, { body }).task;
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      return { task, turn: store.getTurnForAttempt(task.id)! };
    };
    const failed = (body = "Do the work") => {
      const { task, turn } = run(body);
      store.failTask(task.id, { error: "Provider rejected the prompt", failureReason: "agent_error", sessionId: "provider-1" });
      expect(store.getTurn(turn.id)?.status).toBe("failed");
      return { task, turn };
    };
    return { store, user, member, agent, runtime, chat, pat, otherPat, retry, run, failed };
  }

  it("lets the Chat's creator retry a failed turn warm, then a cancelled one cold", async () => {
    const f = await scaffold();
    const first = f.failed();
    const warm = await f.retry(first.turn.id);
    expect(warm.status, JSON.stringify(warm.data)).toBe(200);
    expect(warm.data.turn.id).toBe(first.turn.id);
    expect(warm.data.organizer_action).toBeUndefined();
    const warmAttempt = warm.data.turn.current_attempt_id;
    expect(warmAttempt).not.toBe(first.task.id);
    expect(f.store.listTurnAttempts(first.turn.id)).toHaveLength(2);
    // The previous attempt keeps its failed status; a warm retry resumes the provider session.
    expect(f.store.getTask(first.task.id)?.status).toBe("failed");
    expect(f.store.getTask(warmAttempt)).toMatchObject({ status: "queued", sessionId: "provider-1", chatSessionId: f.chat.id });

    expect(f.store.claimTask(f.runtime.id)?.id).toBe(warmAttempt);
    f.store.startTask(warmAttempt);
    f.store.cancelTurn(first.turn.id);
    expect(f.store.getTurn(first.turn.id)?.status).toBe("cancelled");
    const cold = await f.retry(first.turn.id, { cold: true });
    expect(cold.status, JSON.stringify(cold.data)).toBe(200);
    const coldAttempt = cold.data.turn.current_attempt_id;
    expect(f.store.listTurnAttempts(first.turn.id)).toHaveLength(3);
    expect(f.store.getTask(coldAttempt)).toMatchObject({ status: "queued", sessionId: null });
  });

  it("refuses another member, the master token and an unrelated task credential", async () => {
    const f = await scaffold();
    const { turn } = f.failed();
    const other = await f.retry(turn.id, {}, f.otherPat.token);
    expect([403, 404]).toContain(other.status);
    const master = await f.retry(turn.id, {}, "chat-retry-master");
    expect([403, 404]).toContain(master.status);
    const otherAgent = f.store.createAgent({ name: "Unrelated", provider: "codex", visibility: "workspace" });
    const otherChat = f.store.createChatSession({ agentId: otherAgent.id, creatorId: f.user.id });
    const unrelated = f.store.sendChatMessage(otherChat.id, { body: "Other work" }).task;
    const token = await f.store.createTaskAccessToken(unrelated, "local");
    const byTask = await f.retry(turn.id, {}, token.token);
    expect([403, 404]).toContain(byTask.status);
    expect(f.store.listTurnAttempts(turn.id)).toHaveLength(1);
  });

  it("keeps Issue turns behind the supervisor requirement for a person", async () => {
    const f = await scaffold();
    const issue = createResponsibleTestIssue(f.store, { title: "Issue work", assigneeType: "agent", assigneeId: f.agent.id, responsibleMemberId: f.member.id });
    const task = f.store.createTask({ agentId: f.agent.id, prompt: "Work", issueId: issue.id });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
    f.store.startTask(task.id);
    const turn = f.store.getTurnForAttempt(task.id)!;
    f.store.cancelTurn(turn.id);
    const result = await f.retry(turn.id);
    expect(result.status).toBe(403);
    expect(result.data.code).toBe("organizer_supervisor_required");
    expect(f.store.listTurnAttempts(turn.id)).toHaveLength(1);
  });

  it("refuses a turn that is still running, an archived Chat, and a retry beside a newer active turn", async () => {
    const f = await scaffold();
    const live = f.run("Still working");
    const running = await f.retry(live.turn.id);
    expect(running.status).toBe(409);
    expect(running.data.code).toBe("turn_not_retryable");
    f.store.failTask(live.task.id, { error: "boom", failureReason: "agent_error" });

    f.store.sendChatMessage(f.chat.id, { body: "A newer request" });
    const beside = await f.retry(live.turn.id);
    expect(beside.status).toBe(409);
    expect(beside.data.code).toBe("chat_turn_active");

    f.store.updateChatSession(f.chat.id, { status: "archived" });
    const archived = await f.retry(live.turn.id);
    expect(archived.status).toBe(409);
    expect(archived.data.code).toBe("chat_archived");
    expect(f.store.listTurnAttempts(live.turn.id)).toHaveLength(1);
  });
});
