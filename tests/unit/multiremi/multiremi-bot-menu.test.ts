import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };

describe("workspace bot menu API", () => {
  it("persists the menu in workspace settings without replacing unrelated settings", async () => {
    const store = createLocalStore();
    const workspace = store.getWorkspace("local")!;
    store.updateWorkspace("local", { settings: { ...workspace.settings, unrelated: { keep: true } } });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const botMenu = {
      default: [{ name: "Status", behaviors: [{ type: "send_message" }] }],
      users: [{ target: { type: "role", role: "admin" }, items: [] }],
    };

    const response = await app.request("/api/workspaces/local/bot-menu", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ bot_menu: botMenu }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).bot_menu).toEqual(botMenu);
    expect(store.getWorkspace("local")?.settings).toEqual({ unrelated: { keep: true }, botMenu });
  });

  it("rejects configuration changes from a non-admin member", async () => {
    const store = createLocalStore();
    const user = store.getOrCreateUser({ externalId: "member-external", email: "member@example.test", name: "Member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Member", role: "member" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "member", userId: user.id });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/workspaces/local/bot-menu", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ bot_menu: {} }),
    });

    expect(response.status).toBe(403);
  });

  it("resolves member targets only in the publish request sent to a capable daemon", async () => {
    const store = createLocalStore();
    const linked = store.getOrCreateUser({ externalId: "resolved-open-id", email: "linked@example.test", name: "Linked" });
    const selected = store.createWorkspaceMember({ workspaceId: "local", userId: linked.id, name: "Linked", role: "member" });
    store.registerRuntime({
      id: "rt_bot_menu",
      name: "bot menu",
      provider: "codex",
      workspaceId: "local",
      status: "online",
      metadata: { feishu_bot_menu: true },
    });
    store.updateWorkspace("local", {
      settings: {
        botMenu: {
          default: [{ name: "Default", behaviors: [{ type: "send_message" }] }],
          users: [{ target: { type: "member", memberId: selected.id }, items: [{ name: "Private", behaviors: [{ type: "send_message" }] }] }],
        },
      },
    });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const publish = await app.request("/api/workspaces/local/bot-menu/publish", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ dry_run: true }),
    });
    expect(publish.status).toBe(202);
    const publicRequest = await publish.json();
    expect(JSON.stringify(publicRequest)).not.toContain("resolved-open-id");

    const heartbeat = store.heartbeatRuntime("rt_bot_menu", { supportsBotMenu: true });
    expect(heartbeat.pending_bot_menu).toEqual({
      id: publicRequest.id,
      dry_run: true,
      config: {
        default: [{ name: "Default", behaviors: [{ type: "send_message" }] }],
        users: [{ userId: "resolved-open-id", userIdType: "open_id", items: [{ name: "Private", behaviors: [{ type: "send_message" }] }] }],
      },
    });

    store.reportBotMenuPublishResult("rt_bot_menu", publicRequest.id, {
      status: "completed",
      result: { dryRun: true, defaultPublished: true, userMenuCount: 1 },
    });
    const status = await app.request(`/api/workspaces/local/bot-menu/publish/${publicRequest.id}`, { headers: MASTER });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.status).toBe("completed");
    expect(JSON.stringify(statusBody)).not.toContain("resolved-open-id");
    expect(store.getBotMenuPublishRequest("rt_bot_menu", publicRequest.id)?.config).toEqual({});
  });

  it("fails publish when no online daemon advertises the publisher capability", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/workspaces/local/bot-menu/publish", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ dry_run: true }),
    });

    expect(response.status).toBe(503);
  });
});
