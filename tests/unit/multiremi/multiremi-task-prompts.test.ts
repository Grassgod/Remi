import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("assembled task prompt audit", () => {
  it("records one immutable, hash-verified prompt per task", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Prompt worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Original request" });
    const prompt = "# Bootstrap Prompt\n\n## Current Request\nOriginal request";
    const sha256 = createHash("sha256").update(prompt).digest("hex");

    expect(() => store.recordTaskPrompt(task.id, { mode: "bootstrap", prompt, sha256: "bad" }))
      .toThrow("sha256 mismatch");

    const recorded = store.recordTaskPrompt(task.id, { mode: "bootstrap", prompt, sha256 });
    expect(recorded).toMatchObject({ taskId: task.id, mode: "bootstrap", prompt, sha256 });
    expect(store.recordTaskPrompt(task.id, { mode: "bootstrap", prompt, sha256 })).toEqual(recorded);

    const changed = `${prompt}\nchanged`;
    expect(() => store.recordTaskPrompt(task.id, {
      mode: "bootstrap",
      prompt: changed,
      sha256: createHash("sha256").update(changed).digest("hex"),
    })).toThrow("immutable");
  });

  it("accepts daemon reporting and exposes the exact artifact to authorized UI clients", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({
      id: "rt_prompt",
      name: "Prompt runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Prompt worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, runtimeId: runtime.id, prompt: "Do it" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const prompt = "# Delta Prompt\n\n## Current Request\nDo it";
    const sha256 = createHash("sha256").update(prompt).digest("hex");
    const reported = await app.request(`/api/daemon/tasks/${task.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "delta", prompt, sha256 }),
    });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toMatchObject({ task_id: task.id, mode: "delta", sha256 });

    const fetched = await app.request(`/api/tasks/${task.id}/prompt`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ task_id: task.id, mode: "delta", prompt, sha256 });
  });

  it("returns 404 before the daemon records a prompt", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const agent = store.createAgent({ name: "Queued worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait" });
    const response = await app.request(`/api/tasks/${task.id}/prompt`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "prompt not recorded" });
  });

  it("sends only sibling results published since the previous prompt on a delta turn", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({
      id: "rt_delta_results",
      name: "Delta results runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Delta worker", provider: "codex" });
    const issue = store.createIssue({ title: "Delta results", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const sibling = store.createIssueSession(issue.id, { title: "Research" });
    const oldResult = store.publishSessionResult(sibling.id, {
      title: "Old result",
      body: "Visible during bootstrap",
    });
    const first = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Bootstrap" });

    const firstClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(firstClaim.status).toBe(200);
    expect((await firstClaim.json()).task.issue_session_results.map((result: any) => result.id)).toEqual([oldResult.id]);

    const firstPrompt = "# Bootstrap Prompt\n\n## Current Request\nBootstrap";
    store.recordTaskPrompt(first.id, {
      mode: "bootstrap",
      prompt: firstPrompt,
      sha256: createHash("sha256").update(firstPrompt).digest("hex"),
    });
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done", sessionId: "acp_delta_results" });

    const newResult = store.publishSessionResult(sibling.id, {
      title: "New result",
      body: "Only this belongs in the delta",
    });
    db!.run("UPDATE multiremi_task_prompts SET assembled_at = ? WHERE task_id = ?", [
      "2026-08-17T10:00:00.000Z",
      first.id,
    ]);
    db!.run("UPDATE multiremi_session_results SET created_at = ? WHERE id = ?", [
      "2026-08-17T09:00:00.000Z",
      oldResult.id,
    ]);
    db!.run("UPDATE multiremi_session_results SET created_at = ? WHERE id = ?", [
      "2026-08-17T11:00:00.000Z",
      newResult.id,
    ]);

    const second = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Continue" });
    const secondClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(secondClaim.status).toBe(200);
    const claimed = (await secondClaim.json()).task;
    expect(claimed.id).toBe(second.id);
    expect(claimed.session_projection.mode).toBe("delta");
    expect(claimed.issue_session_results.map((result: any) => result.id)).toEqual([newResult.id]);
  });
});
