import { afterEach, describe, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

afterEach(resetMultiremiTestEnv);

function setup(kind: "round" | "human" | "user" = "round") {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_destination", name: "Destination", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "Topic", provider: "codex", workspaceId: "local" });
  const first = store.createIssue({ title: "ISSUE_A_PRIVATE", workspaceId: "local" });
  const second = store.createIssue({ title: "Issue B", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id });
  bindFeishuTopicFixture(store, db!, chat.id, first.id);
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, issueId: first.id,
    prompt: kind === "user" ? "User question" : "OLD_ISSUE_A_WAKE", holdsWorkspace: false });
  const bindingId = `fcb_${chat.id}`;
  if (kind === "round") {
    db!.run(`INSERT INTO multiremi_feishu_bot_round_pushes
      (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
      VALUES ('push_destination', 'local', ?, ?, 'source_destination', ?, 'proactive', ?, ?)`,
    [bindingId, first.id, task.id, task.createdAt, task.createdAt]);
  } else if (kind === "human") {
    db!.run(`INSERT INTO multiremi_feishu_bot_human_request_pushes
      (id, workspace_id, binding_id, issue_id, source_task_id, request_id, wake_task_id, created_at, updated_at)
      VALUES ('push_destination', 'local', ?, ?, 'source_destination', 'request_destination', ?, ?, ?)`,
    [bindingId, first.id, task.id, task.createdAt, task.createdAt]);
  }
  return { store, runtime, agent, first, second, chat, task, bindingId, kind };
}

type Fixture = ReturnType<typeof setup>;
const drifts = {
  "A to B": (f: Fixture) => db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE id = ?", [f.second.id, f.bindingId]),
  "NULL binding Issue": (f: Fixture) => db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = NULL WHERE id = ?", [f.bindingId]),
  "missing binding": (f: Fixture) => db!.run("DELETE FROM multiremi_feishu_bot_chat_bindings WHERE id = ?", [f.bindingId]),
  "wrong binding agent": (f: Fixture) => db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET agent_id = 'different_agent' WHERE id = ?", [f.bindingId]),
  "wrong binding workspace": (f: Fixture) => db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET workspace_id = 'foreign' WHERE id = ?", [f.bindingId]),
  "push Issue disagrees": (f: Fixture) => db!.run(`UPDATE ${f.kind === "round" ? "multiremi_feishu_bot_round_pushes" : "multiremi_feishu_bot_human_request_pushes"} SET issue_id = ? WHERE wake_task_id = ?`, [f.second.id, f.task.id]),
  "push references missing destination": (f: Fixture) => db!.run(`UPDATE ${f.kind === "round" ? "multiremi_feishu_bot_round_pushes" : "multiremi_feishu_bot_human_request_pushes"} SET binding_id = 'missing' WHERE wake_task_id = ?`, [f.task.id]),
};

describe("Chat task destination invariant", () => {
  for (const kind of ["round", "human"] as const) {
    for (const [name, drift] of Object.entries(drifts)) {
      it(`rejects ${kind} wake ${name} at fresh claim and stale wire`, () => {
        const f = setup(kind);
        const hydrated = f.store.getTaskWithAgent(f.task.id)!;
        drift(f);
        expect(() => daemonTaskClaimResponse(f.store, hydrated)).toThrow("destination no longer matches");
        expect(f.store.claimTask(f.runtime.id)).toBeNull();
        expect(f.store.getTask(f.task.id)?.status).toBe("cancelled");
        expect(f.store.listChatMessages(f.chat.id)).toHaveLength(0);
        expect(f.store.getChatSession(f.chat.id)?.sessionId).toBeNull();
      });
      for (const terminal of ["complete", "fail"] as const) {
        it(`rejects late ${terminal} for ${kind} wake ${name} before any Chat write`, () => {
          const f = setup(kind);
          const claimed = f.store.claimTask(f.runtime.id)!;
          expect(claimed.id).toBe(f.task.id);
          drift(f);
          expect(() => terminal === "complete"
            ? f.store.completeTask(f.task.id, { output: "OLD_ISSUE_REPLY", sessionId: "old_issue_lineage" })
            : f.store.failTask(f.task.id, { error: "OLD_ISSUE_ERROR", sessionId: "old_issue_lineage" }))
            .toThrow("destination no longer matches");
          expect(f.store.listChatMessages(f.chat.id)).toHaveLength(0);
          expect(f.store.getChatSession(f.chat.id)?.sessionId).toBeNull();
          expect(f.store.getTask(f.task.id)?.result).toBeNull();
        });
      }
    }
    it(`does not re-claim a dispatched ${kind} wake after A to B`, () => {
      const f = setup(kind);
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
      drifts["A to B"](f);
      db!.run("UPDATE multiremi_tasks SET dispatched_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [f.task.id]);
      expect(f.store.claimTask(f.runtime.id)).toBeNull();
      expect(f.store.getTask(f.task.id)?.status).toBe("cancelled");
    });
    it(`keeps a matching ${kind} wake executable and its result in its original topic`, () => {
      const f = setup(kind);
      const claimed = f.store.claimTask(f.runtime.id)!;
      expect(claimed.id).toBe(f.task.id);
      expect(daemonTaskClaimResponse(f.store, claimed).issue).toMatchObject({ id: f.first.id });
      f.store.completeTask(f.task.id, { output: "Current Issue report" });
      expect(f.store.listChatMessages(f.chat.id).at(-1)?.body).toBe("Current Issue report");
    });
  }

  it("refuses a retained hydrated wake after it was cancelled, even if the binding still matches", () => {
    const f = setup("round");
    const old = f.store.getTaskWithAgent(f.task.id)!;
    f.store.cancelTask(f.task.id);
    expect(() => daemonTaskClaimResponse(f.store, old)).toThrow("destination no longer matches");
  });

  it("does not let an old user transport turn cross from A to B", () => {
    const f = setup("user");
    const old = f.store.getTaskWithAgent(f.task.id)!;
    drifts["A to B"](f);
    expect(() => daemonTaskClaimResponse(f.store, old)).toThrow("destination no longer matches");
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
  });

  it("runs a historical detached ordinary user turn cold without Issue context", () => {
    const f = setup("user");
    const old = f.store.getTaskWithAgent(f.task.id)!;
    old.sessionId = "old_issue_lineage";
    drifts["NULL binding Issue"](f);
    const wire = daemonTaskClaimResponse(f.store, old);
    expect(wire.issue).toBeUndefined();
    expect(wire.bound_issue).toBeUndefined();
    expect(wire.session_id).toBeUndefined();
    expect(wire.prompt).toBe("User question");
    expect(f.store.claimTask(f.runtime.id)?.issueId).toBeNull();
  });
});
