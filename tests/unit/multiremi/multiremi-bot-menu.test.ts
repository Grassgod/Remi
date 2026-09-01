import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import type { MultiremiStore } from "@multiremi/store.js";

let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  // Pinned rather than inherited: the concierge fixtures below store an App
  // Secret, and the encryption fallbacks derive a key from `MULTIREMI_TOKEN`.
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

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

  it("publishes through the Runtime hosting the concierge, not the newest capable one", async () => {
    // Any capable Runtime can talk to Feishu, but only the concierge's host
    // holds this workspace's app credentials. Publishing from another machine
    // would push this workspace's menu onto whatever bot that machine runs.
    const { store, app } = menuScaffold();
    registerPublisher(store, "rt_concierge", 20_000);
    registerPublisher(store, "rt_other", 1_000);
    configureConcierge(store, "rt_concierge");

    const publish = await app.request("/api/workspaces/local/bot-menu/publish", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ dry_run: true }),
    });

    expect(publish.status).toBe(202);
    const request = await publish.json();
    expect(store.getBotMenuPublishRequest("rt_concierge", request.id)).not.toBeNull();
    expect(store.getBotMenuPublishRequest("rt_other", request.id)).toBeNull();
  });

  it("refuses to publish elsewhere when the concierge Runtime is offline", async () => {
    const { store, app } = menuScaffold();
    // The concierge's host is gone; another capable Runtime is up. Falling back
    // to it would publish onto the wrong bot, so publish fails instead.
    store.registerRuntime({
      id: "rt_concierge",
      name: "concierge host",
      provider: "codex",
      workspaceId: "local",
      status: "offline",
      metadata: { feishu_bot_menu: true },
    });
    registerPublisher(store, "rt_other", 1_000);
    configureConcierge(store, "rt_concierge");

    const publish = await app.request("/api/workspaces/local/bot-menu/publish", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ dry_run: true }),
    });

    expect(publish.status).toBe(503);
    expect((await publish.json()).error).toContain("Feishu concierge");
  });

  it("keeps the newest-capable-Runtime pick for a workspace still on the env-driven bot", async () => {
    // No config row means the legacy MUL-190 path, where the daemon's own
    // environment supplies the credentials — there is no host to prefer.
    const { store, app } = menuScaffold();
    registerPublisher(store, "rt_old", 20_000);
    registerPublisher(store, "rt_new", 1_000);

    const publish = await app.request("/api/workspaces/local/bot-menu/publish", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ dry_run: true }),
    });

    expect(publish.status).toBe(202);
    const request = await publish.json();
    expect(store.getBotMenuPublishRequest("rt_new", request.id)).not.toBeNull();
    expect(store.getBotMenuPublishRequest("rt_old", request.id)).toBeNull();
  });
});

function menuScaffold(): { store: MultiremiStore; app: ReturnType<typeof createMultiremiApp> } {
  const store = createLocalStore();
  store.updateWorkspace("local", {
    settings: { botMenu: { default: [{ name: "Default", behaviors: [{ type: "send_message" }] }], users: [] } },
  });
  return { store, app: createMultiremiApp({ store, authToken: "MASTER" }) };
}

/**
 * An online Runtime advertising the menu-publisher capability, whose last
 * heartbeat landed `ageMs` ago.
 *
 * The timestamp is written straight to the row: registration always stamps
 * "now", and these tests turn on which Runtime looks newest, so two
 * registrations in the same millisecond would make the ordering a coin flip.
 * It has to stay inside the liveness window, though — a runtime whose
 * heartbeat has gone stale reads as offline and drops out of the picker.
 */
function registerPublisher(store: MultiremiStore, id: string, ageMs: number): void {
  store.registerRuntime({
    id,
    name: id,
    provider: "codex",
    workspaceId: "local",
    status: "online",
    metadata: { feishu_bot_menu: true },
  });
  const heartbeatAt = new Date(Date.now() - ageMs).toISOString();
  db?.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", [heartbeatAt, id]);
}

function configureConcierge(store: MultiremiStore, runtimeId: string): void {
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId,
    appId: "cli_a1b2c3d4e5f6g7h8",
    domain: "feishu",
    enabled: true,
    appSecretOp: "set",
    appSecret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA",
    verificationTokenOp: "keep",
    encryptKeyOp: "keep",
  });
}
