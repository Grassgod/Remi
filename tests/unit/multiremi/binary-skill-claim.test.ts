import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { BinarySkillFilesUnsupportedError } from "@multiremi/store/repos/tasks-repo.js";
import { createStore, db, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const png = { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" as const };

function createFixture(provider: "claude" | "codex" | "any" = "claude", inline = false) {
  const store = createStore();
  const runtime = store.registerRuntime({ name: "Skill runtime", provider, maxConcurrency: 3 });
  const agent = store.createAgent({
    name: "Binary Skill agent", provider: provider === "any" ? "codex" : provider,
    skills: inline ? [{ name: "Inline images", content: "# Images", files: [png] }] : [],
  });
  if (!inline) {
    const skill = store.createSkill({ name: "Images", content: "# Images", files: [png] });
    store.setAgentSkills(agent.id, [skill.id!]);
  }
  const task = store.createTask({ agentId: agent.id, prompt: "Use the image", priority: 100 });
  return { store, runtime, agent, task };
}

describe("binary Skill daemon claim compatibility", () => {
  it.each(["claude", "codex", "any"] as const)("rolls back an old %s consumer's binary claim and accepts an upgraded consumer", (provider) => {
    const { store, runtime, task } = createFixture(provider);
    const dispatches: string[] = [];
    store.onTaskEvent(({ type, task }) => { if (type === "task:dispatch") dispatches.push(task.id); });

    expect(() => store.claimTask(runtime.id)).toThrow(BinarySkillFilesUnsupportedError);
    expect(store.getTask(task.id)).toEqual(task);
    expect(dispatches).toEqual([]);

    const claimed = store.claimTask(runtime.id, { supportsBinarySkillFiles: true });
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.agent?.skills[0]?.files?.[0]).toMatchObject(png);
    expect(dispatches).toEqual([task.id]);
  });

  it("also checks legacy inline skills", () => {
    const { store, runtime, task } = createFixture("claude", true);
    expect(() => store.claimTask(runtime.id, { supportsBinarySkillFiles: false })).toThrow(BinarySkillFilesUnsupportedError);
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("skips binary agents so an old consumer can claim a later text-only task", () => {
    const { store, runtime, agent, task } = createFixture();
    const secondBinary = store.createTask({ agentId: agent.id, prompt: "Another image", priority: 90 });
    const textAgent = store.createAgent({ name: "Text agent", provider: "claude" });
    const skill = store.createSkill({ name: "Text", content: "# Text", files: [{ path: "reference.txt", content: "Read me" }] });
    store.setAgentSkills(textAgent.id, [skill.id!]);
    const textTask = store.createTask({ agentId: textAgent.id, prompt: "Read the text" });
    const dispatches: string[] = [];
    store.onTaskEvent(({ type, task }) => { if (type === "task:dispatch") dispatches.push(task.id); });

    expect(store.claimTask(runtime.id)?.id).toBe(textTask.id);
    expect(store.getTask(task.id)).toEqual(task);
    expect(store.getTask(secondBinary.id)).toEqual(secondBinary);
    expect(dispatches).toEqual([textTask.id]);
  });

  it("preserves a stale binary dispatch lease while allowing a later text task", () => {
    const { store, runtime, task } = createFixture();
    store.claimTask(runtime.id, { supportsBinarySkillFiles: true });
    const oldDispatchTime = "2000-01-01T00:00:00.000Z";
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [oldDispatchTime, task.id]);
    const stale = store.getTask(task.id);
    expect(() => store.claimTask(runtime.id)).toThrow(BinarySkillFilesUnsupportedError);
    expect(store.getTask(task.id)).toEqual(stale);

    const textAgent = store.createAgent({ name: "Text agent", provider: "claude" });
    const textTask = store.createTask({ agentId: textAgent.id, prompt: "Use text" });
    expect(store.claimTask(runtime.id)?.id).toBe(textTask.id);
    expect(store.getTask(task.id)).toEqual(stale);
    expect(store.claimTask(runtime.id, { supportsBinarySkillFiles: true })?.id).toBe(task.id);
    expect(store.getTask(task.id)?.dispatchedAt).not.toBe(oldDispatchTime);
  });

  it("returns an explicit HTTP upgrade error for an old consumer without losing the queued task", async () => {
    const { store, runtime, task } = createFixture();
    const app = createMultiremiApp({ store });
    const path = `/api/daemon/runtimes/${runtime.id}/tasks/claim`;
    for (const body of [undefined, "{}", '{"supports_binary_skill_files":false}']) {
      const response = await app.request(path, { method: "POST", body });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "binary_skill_files_unsupported", error: expect.stringContaining("Update the Remi daemon"),
      });
      expect(store.getTask(task.id)).toEqual(task);
    }

    const response = await app.request(path, {
      method: "POST", body: JSON.stringify({ supports_binary_skill_files: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).task.agent.skills[0].files[0]).toEqual(png);
  });

  it("keeps empty-body HTTP claims working for text-only agents", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Old runtime", provider: "claude" });
    const agent = store.createAgent({ name: "Text agent", provider: "claude", skills: [{ name: "Text", content: "# Text" }] });
    const task = store.createTask({ agentId: agent.id, prompt: "Use text" });
    const response = await createMultiremiApp({ store }).request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).task.id).toBe(task.id);
  });

  it("advertises the new client capability and preserves encoding through claim normalization", async () => {
    const { store, runtime, task } = createFixture("codex");
    const app = createMultiremiApp({ store });
    let requestBody: unknown;
    mockFetch((url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return app.request(new URL(url).pathname, init);
    });
    const claimed = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
    expect(requestBody).toEqual({ supports_binary_skill_files: true });
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.agent?.skills[0]?.files[0]).toEqual(png);
  });

  it("rejects malformed claim capabilities without consuming a task", async () => {
    const { store, runtime, task } = createFixture();
    const app = createMultiremiApp({ store });
    for (const body of ['{"supports_binary_skill_files":"true"}', "null", "[true]", "{"]) {
      const response = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(store.getTask(task.id)).toEqual(task);
    }
  });
});
