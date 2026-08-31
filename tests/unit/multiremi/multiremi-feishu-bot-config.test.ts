/**
 * Workspace Feishu concierge configuration API (MUL-206).
 *
 * The feature moved the bot's credentials out of a daemon machine's
 * environment and into a workspace row, so the tests that matter are the ones
 * about who may touch that row and what comes back out of it: an App Secret
 * that goes in must never come back, a form that leaves the secret field blank
 * must not wipe it, and a member who is not an admin must learn nothing beyond
 * whether a bot answers at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";
import type { MultiremiStore } from "@multiremi/store.js";

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const OTHER_SECRET = "aA1bB2cC3dD4eE5fF6gG7hH8iI9jJ0kK";
const VERIFICATION_TOKEN = "verification-token-abcdefghijklmno";
const ENCRYPT_KEY = "encrypt-key-abcdefghijklmnopqrstu";

let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  // Pinned rather than inherited: the fallbacks derive a key from
  // `MULTIREMI_TOKEN`, so without this the suite would pass or fail depending
  // on the developer's shell.
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

/** A workspace with one Agent and one concierge-capable Runtime to select. */
function scaffold(): { store: MultiremiStore; app: ReturnType<typeof createMultiremiApp>; agentId: string } {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_bot",
    name: "Bot host",
    provider: "codex",
    workspaceId: "local",
    daemonId: "daemon-bot",
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  return { store, app: createMultiremiApp({ store, authToken: "MASTER" }), agentId: agent.id };
}

function configBody(agentId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent_id: agentId,
    runtime_id: "rt_bot",
    app_id: "cli_a1b2c3d4e5f6g7h8",
    domain: "feishu",
    enabled: true,
    app_secret: APP_SECRET,
    ...overrides,
  });
}

async function save(
  app: ReturnType<typeof createMultiremiApp>,
  agentId: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return app.request("/api/workspaces/local/feishu-bot", {
    method: "PUT",
    headers: MASTER,
    body: configBody(agentId, overrides),
  });
}

describe("workspace Feishu bot config API", () => {
  it("stores the app secret encrypted and never returns it", async () => {
    const { store, app, agentId } = scaffold();

    const saved = await save(app, agentId, {
      verification_token: VERIFICATION_TOKEN,
      encrypt_key: ENCRYPT_KEY,
    });

    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view).toMatchObject({
      configured: true,
      app_id: "cli_a1b2c3d4e5f6g7h8",
      app_secret_configured: true,
      verification_token_configured: true,
      encrypt_key_configured: true,
      revision: 1,
    });
    // A hint exists so an admin can recognise which credential is stored, but
    // it is a prefix, not the credential.
    expect(view.app_secret_hint).toBe(`${APP_SECRET.slice(0, 4)}••••••`);
    expect(JSON.stringify(view)).not.toContain(APP_SECRET);
    expect(JSON.stringify(view)).not.toContain(VERIFICATION_TOKEN);
    expect(JSON.stringify(view)).not.toContain(ENCRYPT_KEY);

    // And the column itself is ciphertext, not just a masked response.
    const row = db!
      .query("SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?")
      .get("local") as Record<string, unknown>;
    expect(String(row.app_secret_encrypted)).toStartWith("v1.");
    expect(JSON.stringify(row)).not.toContain(APP_SECRET);
    expect(JSON.stringify(row)).not.toContain(VERIFICATION_TOKEN);
    expect(JSON.stringify(row)).not.toContain(ENCRYPT_KEY);
    // The server can still read it back for the Runtime that needs it.
    expect(store.revealFeishuBotSecrets("local")).toMatchObject({
      appSecret: APP_SECRET,
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
    });
  });

  it("keeps a stored secret when the form resubmits without it", async () => {
    // The browser cannot render the secret, so an admin changing the domain
    // submits a blank secret field. That must not disarm the bot.
    const { store, app, agentId } = scaffold();
    await save(app, agentId, { verification_token: VERIFICATION_TOKEN });

    const updated = await save(app, agentId, {
      domain: "lark",
      app_secret: "",
      app_secret_op: "keep",
      verification_token: "",
      verification_token_op: "keep",
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      domain: "lark",
      app_secret_configured: true,
      verification_token_configured: true,
      revision: 2,
    });
    expect(store.revealFeishuBotSecrets("local")).toMatchObject({
      appSecret: APP_SECRET,
      verificationToken: VERIFICATION_TOKEN,
    });
  });

  it("defaults an omitted secret field to keep rather than clear", async () => {
    // Same protection for callers that never send an op at all — curl, the CLI,
    // an older frontend build.
    const { store, app, agentId } = scaffold();
    await save(app, agentId);

    const updated = await app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: agentId,
        runtime_id: "rt_bot",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });

    expect(updated.status).toBe(200);
    expect((await updated.json()).app_secret_configured).toBe(true);
    expect(store.revealFeishuBotSecrets("local")?.appSecret).toBe(APP_SECRET);
  });

  it("clears an optional secret on request but refuses to clear the app secret", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId, { verification_token: VERIFICATION_TOKEN, encrypt_key: ENCRYPT_KEY });

    const cleared = await save(app, agentId, {
      app_secret_op: "keep",
      verification_token_op: "clear",
      encrypt_key_op: "clear",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      app_secret_configured: true,
      verification_token_configured: false,
      encrypt_key_configured: false,
    });
    expect(store.revealFeishuBotSecrets("local")).toMatchObject({
      verificationToken: null,
      encryptKey: null,
    });

    // Clearing the app secret would leave a config that cannot authenticate.
    // Deleting or stopping the bot is the supported way to take it down.
    const refused = await save(app, agentId, { app_secret_op: "clear" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("cannot be cleared");
    expect(store.revealFeishuBotSecrets("local")?.appSecret).toBe(APP_SECRET);
  });

  it("replaces the secret and forgets the profile it described", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    store.recordFeishuBotTestResult("local", { botName: "Old bot", botOpenId: "ou_old" });

    const rotated = await save(app, agentId, { app_secret: OTHER_SECRET, app_secret_op: "set" });

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({
      app_secret_hint: `${OTHER_SECRET.slice(0, 4)}••••••`,
      // A new credential may belong to a different app, so the recorded bot
      // identity is no longer evidence of anything.
      bot_name: null,
      bot_open_id: null,
      last_tested_at: null,
    });
    expect(store.revealFeishuBotSecrets("local")?.appSecret).toBe(OTHER_SECRET);
  });

  it("rejects an Agent or Runtime that does not belong to the workspace", async () => {
    const { store, app, agentId } = scaffold();
    const other = store.createWorkspace({ id: "other", name: "Other" });
    const foreignAgent = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: other.id });
    store.registerRuntime({ id: "rt_foreign", name: "Foreign host", provider: "codex", workspaceId: other.id });

    const wrongAgent = await save(app, foreignAgent.id);
    expect(wrongAgent.status).toBe(400);
    expect(await wrongAgent.json()).toMatchObject({ code: "agent_not_in_workspace" });

    const wrongRuntime = await save(app, agentId, { runtime_id: "rt_foreign" });
    expect(wrongRuntime.status).toBe(400);
    expect(await wrongRuntime.json()).toMatchObject({ code: "runtime_not_in_workspace" });

    const archivedAgent = store.createAgent({ name: "Archived", provider: "codex", workspaceId: "local" });
    store.archiveAgent(archivedAgent.id);
    const archived = await save(app, archivedAgent.id);
    expect(archived.status).toBe(400);
    expect(await archived.json()).toMatchObject({ code: "agent_archived" });

    const missingAppId = await save(app, agentId, { app_id: "" });
    expect(missingAppId.status).toBe(400);
    expect(await missingAppId.json()).toMatchObject({ code: "app_id_required" });

    expect(store.getFeishuBotConfig("local")).toBeNull();
  });

  it("stops the bot when its Agent is archived", async () => {
    // An archived Agent cannot answer, so leaving the connector running would
    // mean a bot that reads Feishu messages and silently drops them.
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    expect(store.getFeishuBotConfig("local")?.enabled).toBe(true);

    store.archiveAgent(agentId);

    expect(store.getFeishuBotConfig("local")?.enabled).toBe(false);
    expect(store.feishuBotDirectiveForRuntime("local", "rt_bot")).toMatchObject({ desired_state: "stopped" });
    expect(store.listFeishuBotAudit("local")[0]).toMatchObject({
      action: "disabled",
      actorType: "system",
      details: { reason: "agent_archived" },
    });
  });

  it("stops and restarts through the status routes without touching credentials", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    const savedRevision = store.getFeishuBotConfig("local")!.revision;

    const stopped = await app.request("/api/workspaces/local/feishu-bot/stop", { method: "POST", headers: MASTER, body: "{}" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ enabled: false, desired_state: "stopped", status: "stopped" });

    const deployed = await app.request("/api/workspaces/local/feishu-bot/deploy", { method: "POST", headers: MASTER, body: "{}" });
    expect(deployed.status).toBe(200);
    const status = await deployed.json();
    expect(status).toMatchObject({ enabled: true, desired_state: "running" });
    // Runtime has never reported, so it is still rolling out rather than online.
    expect(status.status).toBe("deploying");
    expect(status.revision).toBeGreaterThan(savedRevision);
    expect(store.revealFeishuBotSecrets("local")?.appSecret).toBe(APP_SECRET);
  });

  it("keeps telling the host Runtime to stop after the config is deleted", async () => {
    // Deleting the row is not enough: the Runtime holding the connector has to
    // be told, and it only learns on its next heartbeat.
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: 1, state: "online" });

    const deleted = await app.request("/api/workspaces/local/feishu-bot", { method: "DELETE", headers: MASTER });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ configured: false, app_secret_configured: false });
    expect(store.getFeishuBotConfig("local")).toBeNull();
    expect(store.feishuBotDirectiveForRuntime("local", "rt_bot")).toMatchObject({ desired_state: "stopped" });

    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: 0, state: "stopped" });
    // Once it confirms, there is nothing left to say.
    expect(store.feishuBotDirectiveForRuntime("local", "rt_bot")).toBeNull();

    const missing = await app.request("/api/workspaces/local/feishu-bot", { method: "DELETE", headers: MASTER });
    expect(missing.status).toBe(404);
  });

  it("tests credentials against the open platform without persisting a probe of another app", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      if (url.includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-abc" });
      }
      return jsonResponse({ code: 0, bot: { app_name: "Probed bot", open_id: "ou_probe" } });
    });

    const probe = await app.request("/api/workspaces/local/feishu-bot/test", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({ app_id: "cli_other", app_secret: OTHER_SECRET, domain: "feishu" }),
    });

    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({
      ok: true,
      bot_name: "Probed bot",
      runtime_supports_config: true,
    });
    expect(seen[0]).toContain("open.feishu.cn");
    // A probe of some other app must not overwrite the profile recorded for the
    // configured one.
    expect(store.getFeishuBotConfig("local")?.botName).toBeNull();
    expect(store.listFeishuBotAudit("local").some((entry) => entry.action === "tested")).toBe(true);
  });

  it("records a failed test against the stored credentials with a redacted message", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    mockFetch(() => jsonResponse({ code: 10003, msg: `invalid app_secret ${APP_SECRET}` }));

    const tested = await app.request("/api/workspaces/local/feishu-bot/test", {
      method: "POST",
      headers: MASTER,
      body: JSON.stringify({}),
    });

    expect(tested.status).toBe(200);
    const result = await tested.json();
    expect(result).toMatchObject({ ok: false, error_code: "invalid_credentials" });
    expect(JSON.stringify(result)).not.toContain(APP_SECRET);
    const config = store.getFeishuBotConfig("local")!;
    expect(config.lastTestErrorCode).toBe("invalid_credentials");
    expect(config.lastTestError).not.toContain(APP_SECRET);
  });

  it("writes an audit trail that names what moved but never what it became", async () => {
    const { app, agentId } = scaffold();
    await save(app, agentId, { verification_token: VERIFICATION_TOKEN });
    await save(app, agentId, { app_secret_op: "keep", domain: "lark" });
    await app.request("/api/workspaces/local/feishu-bot/stop", { method: "POST", headers: MASTER, body: "{}" });
    await app.request("/api/workspaces/local/feishu-bot/deploy", { method: "POST", headers: MASTER, body: "{}" });

    const audit = await app.request("/api/workspaces/local/feishu-bot/audit", { headers: MASTER });
    expect(audit.status).toBe(200);
    const entries = (await audit.json()).entries as Array<{ action: string; details: Record<string, unknown> }>;
    // Newest first, and a deploy after a stop reads as `enabled` rather than
    // `redeployed`: the distinction is what tells an auditor the bot was off.
    expect(entries.map((entry) => entry.action)).toEqual(["enabled", "disabled", "updated", "configured"]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain(VERIFICATION_TOKEN);
    // The op is recorded, which is what an auditor needs: it says a secret was
    // written without saying anything about the value.
    expect(entries.at(-1)?.details).toMatchObject({ app_secret_op: "set", domain: "feishu" });
    expect(entries[2]?.details).toMatchObject({ app_secret_op: "keep", domain: "lark" });
  });
});

describe("workspace Feishu bot config permissions", () => {
  it("tells an ordinary member only whether a bot is available", async () => {
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    store.recordFeishuBotTestResult("local", { botName: "Reception" });
    const user = store.getOrCreateUser({ externalId: "member-ext", email: "member@example.test", name: "Member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Member", role: "member" });
    const token = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "member", userId: user.id });
    const memberHeaders = { Authorization: `Bearer ${token.token}`, "content-type": "application/json" };

    const view = await app.request("/api/workspaces/local/feishu-bot", { headers: memberHeaders });
    expect(view.status).toBe(200);
    // Availability only: no app id, no Runtime, no error text, no hint.
    expect(await view.json()).toEqual({ configured: true, available: false, bot_name: "Reception" });

    for (const [path, init] of [
      ["/api/workspaces/local/feishu-bot/status", { headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot/candidates", { headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot/audit", { headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot", { method: "PUT", headers: memberHeaders, body: configBody(agentId) }],
      ["/api/workspaces/local/feishu-bot", { method: "DELETE", headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot/deploy", { method: "POST", headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot/stop", { method: "POST", headers: memberHeaders }],
      ["/api/workspaces/local/feishu-bot/test", { method: "POST", headers: memberHeaders, body: "{}" }],
    ] as const) {
      const response = await app.request(path, init as RequestInit);
      expect([path, response.status]).toEqual([path, 403]);
    }
  });

  it("denies the whole subtree to a task token, reads included", async () => {
    // Task credentials run untrusted issue content. Reaching this surface would
    // let that content repoint which Agent answers Feishu, so even a GET is out.
    const { store, app, agentId } = scaffold();
    await save(app, agentId);
    const issue = store.createIssue({ title: "Feishu bot auth", workspaceId: "local" });
    const task = store.createTask({
      agentId,
      issueId: issue.id,
      workspaceId: "local",
      prompt: "Try to read the concierge config",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${taskToken.token}`, "content-type": "application/json" };

    for (const [path, init] of [
      ["/api/workspaces/local/feishu-bot", { headers }],
      ["/api/workspaces/local/feishu-bot/status", { headers }],
      ["/api/workspaces/local/feishu-bot", { method: "PUT", headers, body: configBody(agentId) }],
      ["/api/workspaces/local/feishu-bot/deploy", { method: "POST", headers }],
    ] as const) {
      const response = await app.request(path, init as RequestInit);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ code: "task_token_hard_denied" });
    }
  });

  it("refuses configuration writes from a daemon token", async () => {
    const { store, app, agentId } = scaffold();
    const daemonToken = await store.createAccessToken({
      name: "Bot daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-bot",
    });
    const headers = { Authorization: `Bearer ${daemonToken.token}`, "content-type": "application/json" };

    const write = await app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers,
      body: configBody(agentId),
    });
    expect(write.status).toBe(403);
    expect(store.getFeishuBotConfig("local")).toBeNull();

    // The admin read surface is closed to it as well: a daemon gets its config
    // from its own runtime-scoped route, never from the workspace one.
    const read = await app.request("/api/workspaces/local/feishu-bot/status", { headers });
    expect(read.status).toBe(403);
  });
});
