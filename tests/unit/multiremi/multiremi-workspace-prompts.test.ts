import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT } from "../../../packages/server/src/prompts/workspace-settings.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };

describe("workspace prompt settings", () => {
  it("returns a read-only platform template preview to workspace members", async () => {
    const store = createLocalStore();
    store.createWorkspaceMember({ id: "mem_template_reader", workspaceId: "local", userId: "reader", name: "Reader", role: "member" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "reader", userId: "reader" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/workspaces/local/prompt-template", {
      headers: { Authorization: `Bearer ${token.token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bootstrap: expect.stringContaining("{{workspace_bootstrap_prompt}}"),
      delta: expect.stringContaining("{{workspace_delta_prompt}}"),
      sha256: {
        bootstrap: expect.stringMatching(/^[a-f0-9]{64}$/),
        delta: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("returns the delivery contract by default and round-trips both prompt modes", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const initial = await app.request("/api/workspaces/local/prompts", { headers: MASTER });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      bootstrapPrompt: DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT,
      deltaPrompt: "",
      revision: 0,
    });

    const updated = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        bootstrapPrompt: "Bootstrap once.\r\nCreate a PR.",
        deltaPrompt: "Check new comments.",
        expectedRevision: 0,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      bootstrapPrompt: "Bootstrap once.\nCreate a PR.",
      deltaPrompt: "Check new comments.",
      revision: 1,
    });

    const workspace = store.getWorkspace("local")!;
    expect(workspace.settings).toMatchObject({
      prompt_bootstrap_appendix: "Bootstrap once.\nCreate a PR.",
      prompt_delta_appendix: "Check new comments.",
      prompt_revision: 1,
    });
  });

  it("rejects stale writes and non-admin members", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ bootstrapPrompt: "First", deltaPrompt: "", expectedRevision: 0 }),
    });

    const stale = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ bootstrapPrompt: "Stale", deltaPrompt: "", expectedRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "workspace_prompt_revision_conflict", currentRevision: 1 });

    store.createWorkspaceMember({ id: "mem_local_reader", workspaceId: "local", userId: "reader", name: "Reader", role: "member" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "reader", userId: "reader" });
    const forbidden = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ bootstrapPrompt: "Bypass", deltaPrompt: "", expectedRevision: 1 }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("ships the latest workspace prompts in a task claim", async () => {
    const store = createLocalStore();
    store.updateWorkspace("local", {
      settings: {
        prompt_bootstrap_appendix: "Workspace bootstrap rule",
        prompt_delta_appendix: "Workspace delta rule",
      },
    });
    const runtime = store.registerRuntime({ id: "rt_prompt", name: "prompt", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Prompt Agent", provider: "codex", runtimeId: runtime.id });
    store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "Do it" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task).toMatchObject({
      workspace_bootstrap_prompt: "Workspace bootstrap rule",
      workspace_delta_prompt: "Workspace delta rule",
    });
  });
});
