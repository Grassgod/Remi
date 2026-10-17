import { taskOfferResponse } from "../../fixtures/task-offer.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT, foldLegacyWorkspacePrompts, readWorkspacePromptSettings } from "../../../packages/server/src/prompts/workspace-settings.js";
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
    const preview = await response.json();
    expect(preview.instructions).toContain("## Issue\nKey: {{issue_key}}");
    expect(preview.instructions).toContain("## Workspace Instructions\n{{workspace_prompt}}");
    expect(preview.instructions).toContain("## Bound Issue\nThis Feishu topic is bound to {{issue_key}}");
    expect(preview.input).toContain("{{message_body}}");
    expect(preview).toMatchObject({
      sha256: {
        instructions: expect.stringMatching(/^[a-f0-9]{64}$/),
        input: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(preview).not.toHaveProperty("bootstrap");
  });

  it("stores only the workspace's own text, one prompt, and keeps the legacy keys for older images", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    // ADR 0023: Remi's delivery rules are not a default the setting freezes.
    const initial = await app.request("/api/workspaces/local/prompts", { headers: MASTER });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ prompt: "", revision: 0, updatedAt: null, updatedBy: null });

    const updated = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ prompt: "Answer in Chinese.\r\nCreate a PR.", expectedRevision: 0 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ prompt: "Answer in Chinese.\nCreate a PR.", revision: 1 });
    expect(store.getWorkspace("local")!.settings).toMatchObject({
      prompt_appendix: "Answer in Chinese.\nCreate a PR.",
      prompt_bootstrap_appendix: `${DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nAnswer in Chinese.\nCreate a PR.`,
      prompt_delta_appendix: "",
      prompt_revision: 1,
    });

    // A client from before sends the two halves; they become one prompt.
    const legacy = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ bootstrapPrompt: `${DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nBootstrap once.`, deltaPrompt: "Check new comments.", expectedRevision: 1 }),
    });
    expect(await legacy.json()).toMatchObject({ prompt: "Bootstrap once.\n\nCheck new comments.", revision: 2 });
  });

  it("reads settings saved before ADR 0023 as their two prompts merged, without Remi's former default", () => {
    const store = createLocalStore();
    store.updateWorkspace("local", { settings: {
      prompt_bootstrap_appendix: `${DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nWorkspace bootstrap rule`,
      prompt_delta_appendix: "Workspace delta rule",
    } });
    expect(readWorkspacePromptSettings(store.getWorkspace("local")!).prompt).toBe("Workspace bootstrap rule\n\nWorkspace delta rule");
    store.updateWorkspace("local", { settings: { prompt_bootstrap_appendix: DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT } });
    expect(readWorkspacePromptSettings(store.getWorkspace("local")!).prompt).toBe("");
    const folded = foldLegacyWorkspacePrompts({ prompt_bootstrap_appendix: "Own rule", prompt_delta_appendix: "", other: 1 });
    expect(folded).toEqual({ prompt_bootstrap_appendix: "Own rule", prompt_delta_appendix: "", other: 1, prompt_appendix: "Own rule" });
    expect(foldLegacyWorkspacePrompts({ prompt_appendix: "Already one" })).toBeNull();
  });

  it("rejects stale writes and non-admin members", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ prompt: "First", expectedRevision: 0 }),
    });

    const stale = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ prompt: "Stale", expectedRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "workspace_prompt_revision_conflict", currentRevision: 1 });

    store.createWorkspaceMember({ id: "mem_local_reader", workspaceId: "local", userId: "reader", name: "Reader", role: "member" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "reader", userId: "reader" });
    const forbidden = await app.request("/api/workspaces/local/prompts", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Bypass", expectedRevision: 1 }),
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

    const claim = await taskOfferResponse(store, runtime.id);
    expect(claim.status).toBe(200);
    const task = (await claim.json()).task;
    // New daemons read the workspace's own text; older ones the bootstrap prompt with Remi's former default.
    expect(task.workspace_prompt).toBe("Workspace bootstrap rule\n\nWorkspace delta rule");
    expect(task.workspace_bootstrap_prompt).toBe(`${DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nWorkspace bootstrap rule\n\nWorkspace delta rule`);
    expect(task).not.toHaveProperty("workspace_delta_prompt");
  });
});
