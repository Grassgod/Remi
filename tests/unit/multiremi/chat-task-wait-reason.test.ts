import { mutateExecutionFixture, turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat task wait reason", () => {
  it("returns a queued capability reason after reopening and omits it after recovery", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: "Work" }).task;
    const app = createMultiremiApp({ store });
    const reason = "等待模型能力恢复：2 个候选 Runtime 均无法执行 claude-opus-5";
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET wait_reason = ? WHERE id = ?", [reason, task.id]);
    const waiting = await app.request(turnApiPath(store, task.id, "?attempts=true"));
    expect(waiting.status).toBe(200);
    const waitingBody = await waiting.json();
    expect(waitingBody.turn).toMatchObject({ current_attempt_id: task.id, status: "pending" });
    expect(waitingBody.attempts.at(-1)).toMatchObject({ id: task.id, wait_reason: reason });

    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET wait_reason = NULL WHERE id = ?", [task.id]);
    const recovered = await app.request(turnApiPath(store, task.id, "?attempts=true"));
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).attempts.at(-1).wait_reason).toBeNull();
  });
});
