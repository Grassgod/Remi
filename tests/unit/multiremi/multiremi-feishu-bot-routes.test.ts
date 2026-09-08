import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import {
  createLocalStore,
  db,
  jsonResponse,
  mockFetch,
  resetMultiremiTestEnv,
} from "./helpers.js";

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold() {
  const store = createLocalStore();
  const defaultAgent = store.createAgent({ name: "Default", provider: "codex", workspaceId: "local" });
  const p2pAgent = store.createAgent({ name: "Direct", provider: "codex", workspaceId: "local" });
  const groupAgent = store.createAgent({ name: "Broad", provider: "codex", workspaceId: "local" });
  const chatAgent = store.createAgent({ name: "Special", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local" });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: defaultAgent.id,
    runtimeId: "rt_bot",
    appId: "cli_routes",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  return {
    store,
    app: createMultiremiApp({ store, authToken: "MASTER" }),
    config,
    defaultAgent,
    p2pAgent,
    groupAgent,
    chatAgent,
  };
}

function routeBody(routes: Array<Record<string, unknown>>): string {
  return JSON.stringify({ routes });
}

describe("Feishu bot Agent route repository", () => {
  it("enforces default scope uniqueness in the database", () => {
    const { p2pAgent, groupAgent } = scaffold();
    const now = new Date().toISOString();
    const insert = (id: string, scope: "p2p_default" | "group_default", agentId: string) => db!.run(
      `INSERT INTO multiremi_feishu_bot_agent_routes (
         id, workspace_id, scope, chat_id, chat_name, agent_id,
         created_at, updated_at, updated_by
       ) VALUES (?, 'local', ?, NULL, NULL, ?, ?, ?, NULL)`,
      [id, scope, agentId, now, now],
    );

    insert("fbr_direct_first", "p2p_default", p2pAgent.id);
    expect(() => insert("fbr_direct_second", "p2p_default", groupAgent.id)).toThrow();
    expect(() => insert("fbr_group_first", "group_default", groupAgent.id)).not.toThrow();
  });

  it("migrates an empty route table and resolves chat, type, then config priority", () => {
    const { store, config, defaultAgent, p2pAgent, groupAgent, chatAgent } = scaffold();
    expect(db?.query(
      "SELECT COUNT(*) AS count FROM multiremi_feishu_bot_agent_routes",
    ).get()).toEqual({ count: 0 });
    expect(store.resolveFeishuBotRouteAgent("local", "p2p", "oc_direct")).toMatchObject({
      agentId: defaultAgent.id,
    });

    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "p2p_default", agentId: p2pAgent.id },
      { scope: "group_default", agentId: groupAgent.id },
      { scope: "chat", chatId: "oc_special", chatName: "Special group", agentId: chatAgent.id },
    ]);

    expect(store.resolveFeishuBotRouteAgent("local", "p2p", "oc_direct")).toMatchObject({
      agentId: p2pAgent.id,
      agentName: "Direct",
    });
    expect(store.resolveFeishuBotRouteAgent("local", "group", "oc_general")).toMatchObject({
      agentId: groupAgent.id,
    });
    expect(store.resolveFeishuBotRouteAgent("local", "group", "oc_special")).toMatchObject({
      agentId: chatAgent.id,
      agentName: "Special",
    });
    expect(store.getFeishuBotConfig("local")?.revision).toBe(config.revision);
  });

  it("falls through archived route Agents without stopping the bot", () => {
    const { store, config, defaultAgent, groupAgent, chatAgent } = scaffold();
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "group_default", agentId: groupAgent.id },
      { scope: "chat", chatId: "oc_special", agentId: chatAgent.id },
    ]);

    store.archiveAgent(chatAgent.id);
    expect(store.getFeishuBotConfig("local")).toMatchObject({ enabled: true, revision: config.revision });
    expect(store.resolveFeishuBotRouteAgent("local", "group", "oc_special")?.agentId).toBe(groupAgent.id);
    expect(store.listFeishuBotAgentRoutes("local").find((route) => route.agentId === chatAgent.id))
      .toMatchObject({ agentArchived: true });
    expect(store.listFeishuBotAudit("local")[0]).toMatchObject({
      action: "updated",
      details: { routes: true, reason: "agent_archived", agent_id: chatAgent.id },
    });

    store.archiveAgent(groupAgent.id);
    expect(store.resolveFeishuBotRouteAgent("local", "group", "oc_special")?.agentId).toBe(defaultAgent.id);
    expect(store.getFeishuBotConfig("local")?.enabled).toBe(true);
  });
});

describe("Feishu bot Agent route API", () => {
  it("replaces routes idempotently, validates Agents, and leaves revision unchanged", async () => {
    const { store, app, config, p2pAgent, groupAgent } = scaffold();
    const body = routeBody([
      { scope: "p2p_default", agent_id: p2pAgent.id },
      { scope: "group_default", agent_id: groupAgent.id },
    ]);
    const first = await app.request("/api/workspaces/local/feishu-bot/routes", {
      method: "PUT",
      headers: MASTER,
      body,
    });
    expect(first.status).toBe(200);
    const firstRoutes = (await first.json()).routes;
    const second = await app.request("/api/workspaces/local/feishu-bot/routes", {
      method: "PUT",
      headers: MASTER,
      body,
    });
    expect(second.status).toBe(200);
    expect((await second.json()).routes).toEqual(firstRoutes);
    expect(store.getFeishuBotConfig("local")?.revision).toBe(config.revision);

    const other = store.createWorkspace({ id: "other", name: "Other" });
    const foreign = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: other.id });
    const rejected = await app.request("/api/workspaces/local/feishu-bot/routes", {
      method: "PUT",
      headers: MASTER,
      body: routeBody([{ scope: "p2p_default", agent_id: foreign.id }]),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "agent_not_in_workspace" });
    expect(store.listFeishuBotAgentRoutes("local")).toHaveLength(2);

    const duplicate = await app.request("/api/workspaces/local/feishu-bot/routes", {
      method: "PUT",
      headers: MASTER,
      body: routeBody([
        { scope: "group_default", agent_id: groupAgent.id },
        { scope: "group_default", agent_id: groupAgent.id },
      ]),
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ code: "duplicate_route" });
    expect(store.listFeishuBotAgentRoutes("local")).toHaveLength(2);

    store.archiveAgent(p2pAgent.id);
    const archived = await app.request("/api/workspaces/local/feishu-bot/routes", {
      method: "PUT",
      headers: MASTER,
      body: routeBody([{ scope: "p2p_default", agent_id: p2pAgent.id }]),
    });
    expect(archived.status).toBe(400);
    expect(await archived.json()).toMatchObject({ code: "agent_archived" });
  });

  it("lists joined groups and refreshes chat route names across pages", async () => {
    const { store, app, chatAgent } = scaffold();
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "chat", chatId: "oc_special", chatName: "Old name", agentId: chatAgent.id },
    ]);
    mockFetch((url) => {
      if (url.includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-test" });
      }
      const pageToken = new URL(url).searchParams.get("page_token");
      return pageToken
        ? jsonResponse({
            code: 0,
            data: { items: [{ chat_id: "oc_second", name: "Second", member_count: "5", chat_mode: "group" }] },
          })
        : jsonResponse({
            code: 0,
            data: {
              items: [{ chat_id: "oc_special", name: "Renamed group", member_count: 12, chat_mode: "group" }],
              has_more: true,
              page_token: "next",
            },
          });
    });

    const chats = await app.request("/api/workspaces/local/feishu-bot/chats", { headers: MASTER });
    expect(chats.status).toBe(200);
    expect((await chats.json()).chats).toEqual([
      { name: "Renamed group", chat_id: "oc_special", member_count: 12, chat_mode: "group" },
      { name: "Second", chat_id: "oc_second", member_count: 5, chat_mode: "group" },
    ]);

    const routes = await app.request("/api/workspaces/local/feishu-bot/routes", { headers: MASTER });
    expect(routes.status).toBe(200);
    expect((await routes.json()).routes[0]).toMatchObject({
      chat_id: "oc_special",
      chat_name: "Renamed group",
      member_count: 12,
      agent_archived: false,
    });
  });

  it("returns stable 4xx codes when chat credentials cannot be used", async () => {
    const emptyStore = createLocalStore();
    const emptyApp = createMultiremiApp({ store: emptyStore, authToken: "MASTER" });
    const missing = await emptyApp.request("/api/workspaces/local/feishu-bot/chats", { headers: MASTER });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "bot_not_configured" });

    resetMultiremiTestEnv();
    const { app } = scaffold();
    mockFetch(() => jsonResponse({ code: 10003, msg: "invalid credentials" }));
    const invalid = await app.request("/api/workspaces/local/feishu-bot/chats", { headers: MASTER });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: "invalid_credentials" });
  });
});
