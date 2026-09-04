/**
 * Control-plane delivery of the Feishu concierge assignment (MUL-206).
 *
 * The daemon learns about the bot in two steps: a heartbeat directive that says
 * only "revision N, please be running", and a runtime-scoped fetch that returns
 * the credentials. Splitting them is the whole point — a heartbeat ack is
 * logged and cached in more places than a credential should ever reach.
 *
 * The other half of this file is the handover. One workspace's bot may run in
 * exactly one place; a Runtime switch has to be a baton pass, not a moment when
 * two connectors answer the same Feishu app.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { deriveStatus } from "@multiremi/store/repos/feishu-bot-repo.js";
import {
  FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
  type MultiremiFeishuBotRuntimeStatus,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";

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

interface Scaffold {
  store: MultiremiStore;
  app: ReturnType<typeof createMultiremiApp>;
  agentId: string;
  /** Daemon tokens, keyed by the Runtime they are bound to. */
  tokens: Record<string, string>;
}

/**
 * A configured workspace with two concierge-capable Runtimes, each with its own
 * daemon token, so cross-Runtime access can actually be attempted.
 */
async function scaffold(): Promise<Scaffold> {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  const tokens: Record<string, string> = {};
  for (const suffix of ["a", "b"]) {
    store.registerRuntime({
      id: `rt_${suffix}`,
      name: `Host ${suffix}`,
      provider: "codex",
      workspaceId: "local",
      daemonId: `daemon-${suffix}`,
    });
    store.heartbeatRuntime(`rt_${suffix}`, { supportsFeishuBotConfig: true });
    const token = await store.createAccessToken({
      name: `daemon-${suffix}`,
      type: "daemon",
      workspaceId: "local",
      daemonId: `daemon-${suffix}`,
    });
    tokens[`rt_${suffix}`] = token.token;
  }
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const saved = await app.request("/api/workspaces/local/feishu-bot", {
    method: "PUT",
    headers: MASTER,
    body: JSON.stringify({
      agent_id: agent.id,
      runtime_id: "rt_a",
      app_id: "cli_a1b2c3d4e5f6g7h8",
      domain: "feishu",
      enabled: true,
      app_secret: APP_SECRET,
    }),
  });
  if (saved.status !== 200) throw new Error(`scaffold config failed: ${saved.status}`);
  return { store, app, agentId: agent.id, tokens };
}

function daemonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function heartbeat(scaffolded: Scaffold, runtimeId: string, body: Record<string, unknown> = {}) {
  return scaffolded.app.request("/api/daemon/heartbeat", {
    method: "POST",
    headers: daemonHeaders(scaffolded.tokens[runtimeId]!),
    body: JSON.stringify({
      runtime_id: runtimeId,
      feishu_concierge_protocol: FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
      ...body,
    }),
  });
}

async function report(
  scaffolded: Scaffold,
  runtimeId: string,
  body: Record<string, unknown>,
) {
  return scaffolded.app.request(`/api/daemon/runtimes/${runtimeId}/feishu-bot/status`, {
    method: "POST",
    headers: daemonHeaders(scaffolded.tokens[runtimeId]!),
    body: JSON.stringify(body),
  });
}

describe("Feishu bot control-plane delivery", () => {
  it("puts a revision in the heartbeat and the credentials nowhere near it", async () => {
    const test = await scaffold();

    const ack = await heartbeat(test, "rt_a");

    expect(ack.status).toBe(200);
    const body = await ack.json();
    expect(body.feishu_bot).toEqual({ revision: 1, desired_state: "running", config_available: true });
    // The whole ack, not just the directive: a credential must not ride along
    // in `workspace_settings` or any other field either.
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
  });

  it("withholds the directive from a daemon that cannot host the bot", async () => {
    // Silence means the build is older, or the process is already running the
    // bot from its own environment. Either way it must stop being offered the
    // connector, including after a heartbeat that once claimed the capability.
    const test = await scaffold();

    const legacy = await test.app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ runtime_id: "rt_a" }),
    });

    expect(legacy.status).toBe(200);
    expect(await legacy.json()).not.toHaveProperty("feishu_bot");
    expect(test.store.getRuntime("rt_a")?.metadata.feishu_concierge_config_v1).toBe(false);
    // And the Runtime stops being an offerable choice on the settings page.
    const candidates = await test.app.request("/api/workspaces/local/feishu-bot/candidates", { headers: MASTER });
    const listed = (await candidates.json()).runtimes as Array<{ id: string; supports_config: boolean }>;
    expect(listed.find((entry) => entry.id === "rt_a")?.supports_config).toBe(false);
  });

  it("serves the credentials with the Agent the channel needs", async () => {
    const test = await scaffold();

    const response = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });

    expect(response.status).toBe(200);
    // Never cached: this is the one response in the system that carries the
    // workspace's Feishu credentials.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toMatchObject({
      workspace_id: "local",
      runtime_id: "rt_a",
      agent_id: test.agentId,
      revision: 1,
      desired_state: "running",
      app_id: "cli_a1b2c3d4e5f6g7h8",
      app_secret: APP_SECRET,
      domain: "feishu",
    });
    // The Agent travels with the credentials so a start is consistent as of one
    // revision rather than mixing in whatever the last heartbeat carried.
    expect(payload.bot_agent).toMatchObject({ id: test.agentId, name: "Concierge" });
    expect(payload).not.toHaveProperty("bot_projects");
  });

  it("refuses a daemon token bound to a different Runtime", async () => {
    // Same workspace, wrong machine. Runtime B has no business holding the
    // credentials assigned to Runtime A.
    const test = await scaffold();

    const impersonated = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(impersonated.status).toBe(403);
    expect(await impersonated.text()).not.toContain(APP_SECRET);

    // And asking about itself gets nothing, because it is not the host.
    const ownScope = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(ownScope.status).toBe(404);
  });

  it("refuses a non-daemon caller even when that caller is an admin", async () => {
    const test = await scaffold();

    const asAdmin = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", { headers: MASTER });

    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.json()).toMatchObject({ code: "daemon_token_required" });
  });

  it("bridges messages and session inspection only for the selected Runtime", async () => {
    const test = await scaffold();
    const submitted = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/messages", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({
        revision: 1,
        external_session_key: "oc_chat_1",
        external_message_id: "om_1",
        sender_open_id: "ou_member",
        text: "hello",
      }),
    });
    expect(submitted.status).toBe(202);
    const lineage = await submitted.json();
    expect(lineage).toMatchObject({ status: "queued", duplicate: false, steered: false });

    const inspected = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/session/inspect", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ revision: 1, external_session_key: "oc_chat_1" }),
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      chat_session_id: lineage.chatSessionId,
      task: { task_id: lineage.taskId, status: "queued" },
    });

    const crossRuntime = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/session/inspect", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_b!),
      body: JSON.stringify({ revision: 1, external_session_key: "oc_chat_1" }),
    });
    expect(crossRuntime.status).toBe(403);
  });

  it("leases one proactive reply in heartbeat and acknowledges it by claim token", async () => {
    const test = await scaffold();
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1,
      externalSessionKey: "oc_outbound:thread:omt_outbound",
      externalMessageId: "om_outbound_root",
      replyToMessageId: "om_outbound_root",
      chatId: "oc_outbound",
      threadId: "omt_outbound",
      text: "seed destination",
    });
    const binding = db!.query(
      "SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?",
    ).get(submitted.chatSessionId) as { id: string };
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at
       ) VALUES (?, 'local', ?, NULL, 'oc_outbound', 'omt_outbound',
         'om_outbound_root', 'Round completed.', 'pending', ?, ?, ?)`,
      ["fbo_http", binding.id, now, now, now],
    );
    await report(test, "rt_a", { applied_revision: 1, state: "online" });

    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id = 'cli_stale' WHERE id = ?", [binding.id]);
    const wrongBot = await heartbeat(test, "rt_a");
    expect(await wrongBot.json()).not.toHaveProperty("pending_feishu_outbound");
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id = 'cli_a1b2c3d4e5f6g7h8' WHERE id = ?", [binding.id]);

    const v1 = await heartbeat(test, "rt_a", {
      feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION,
    });
    const v1Body = await v1.json();
    expect(v1Body.feishu_bot).toMatchObject({ desired_state: "running", config_available: true });
    expect(v1Body).not.toHaveProperty("pending_feishu_outbound");

    const ack = await heartbeat(test, "rt_a");
    const body = await ack.json();
    expect(body.pending_feishu_outbound).toMatchObject({
      id: "fbo_http",
      chat_id: "oc_outbound",
      thread_id: "omt_outbound",
      reply_to_message_id: "om_outbound_root",
      body: "Round completed.",
      idempotency_key: "fbo_http",
    });

    const result = await test.app.request(
      "/api/daemon/runtimes/rt_a/feishu-bot/outbound/fbo_http/result",
      {
        method: "POST",
        headers: daemonHeaders(test.tokens.rt_a!),
        body: JSON.stringify({
          claim_token: body.pending_feishu_outbound.claim_token,
          status: "sent",
          external_message_id: "om_outbound_sent",
        }),
      },
    );
    expect(result.status).toBe(200);
    expect((await (await heartbeat(test, "rt_a")).json())).not.toHaveProperty("pending_feishu_outbound");
  });

  it("names a deleted Agent instead of failing the start generically", async () => {
    const test = await scaffold();
    // Archiving disables the config, so only an outright delete reaches here.
    db!.run("DELETE FROM multiremi_agents WHERE id = ?", [test.agentId]);

    const response = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "agent_unavailable" });
  });

  it("records a reported failure with the error the admin will read", async () => {
    const test = await scaffold();

    const reported = await report(test, "rt_a", {
      applied_revision: 1,
      state: "failed",
      error_code: "invalid_credentials",
      error_message: `Feishu rejected ${APP_SECRET}`,
    });

    expect(reported.status).toBe(200);
    expect((await reported.json()).directive).toMatchObject({ desired_state: "running" });
    const status = await (await test.app.request("/api/workspaces/local/feishu-bot/status", { headers: MASTER })).json();
    expect(status).toMatchObject({ status: "failed", error_code: "invalid_credentials", applied_revision: 1 });
    // The daemon redacts, and the control plane redacts again on the way in:
    // this string is rendered to admins verbatim.
    expect(status.error_message).not.toContain(APP_SECRET);
  });

  it("rejects a runtime state it does not recognise", async () => {
    const test = await scaffold();

    const bogus = await report(test, "rt_a", { applied_revision: 1, state: "haunted" });

    expect(bogus.status).toBe(400);
    expect(test.store.listFeishuBotRuntimeStatuses("local")).toEqual([]);
  });
});

describe("Feishu bot Runtime handover", () => {
  it("never lets two Runtimes hold the bot at once", async () => {
    const test = await scaffold();
    // Runtime A is live and answering.
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    expect((await (await heartbeat(test, "rt_a")).json()).feishu_bot).toMatchObject({ desired_state: "running" });

    // The admin repoints the bot at Runtime B.
    const moved = await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });
    expect(moved.status).toBe(200);

    // B is told to wait: A still claims the connector.
    const held = await heartbeat(test, "rt_b");
    expect((await held.json()).feishu_bot).toMatchObject({ desired_state: "stopped", config_available: false });
    // And it cannot fetch the credentials to start on its own initiative.
    const early = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(early.status).toBe(404);

    // A is told to let go, and says it has.
    const stopA = await heartbeat(test, "rt_a");
    expect((await stopA.json()).feishu_bot).toMatchObject({ desired_state: "stopped" });
    await report(test, "rt_a", { applied_revision: 2, state: "stopped" });

    // Only now is B cleared to run.
    const cleared = await heartbeat(test, "rt_b");
    expect((await cleared.json()).feishu_bot).toMatchObject({ desired_state: "running", config_available: true });
    const payload = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(payload.status).toBe(200);
    expect((await payload.json()).app_secret).toBe(APP_SECRET);
  });

  it("shows the overlap as degraded rather than online while it lasts", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });

    const status = await (await test.app.request("/api/workspaces/local/feishu-bot/status", { headers: MASTER })).json();

    expect(status).toMatchObject({ status: "degraded", stale_runtime_ids: ["rt_a"], desired_state: "stopped" });
  });

  it("stops waiting on a Runtime whose report has gone stale", async () => {
    // A machine unplugged mid-connector would otherwise block its replacement
    // forever, which turns one dead host into an outage with no way out.
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    db!.run(
      "UPDATE multiremi_feishu_bot_runtime_states SET reported_at = ? WHERE runtime_id = ?",
      [new Date(Date.now() - 10 * 60_000).toISOString(), "rt_a"],
    );
    await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });

    const cleared = await heartbeat(test, "rt_b");
    expect((await cleared.json()).feishu_bot).toMatchObject({ desired_state: "running", config_available: true });
  });

  it("tells the host to stop as soon as the bot is disabled", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });

    await test.app.request("/api/workspaces/local/feishu-bot/stop", {
      method: "POST",
      headers: MASTER,
      body: "{}",
    });

    const ack = await heartbeat(test, "rt_a");
    expect((await ack.json()).feishu_bot).toMatchObject({ desired_state: "stopped", config_available: false });
    // Credentials go with the intent: a stopped bot has no reason to hold them.
    const fetched = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });
    expect(fetched.status).toBe(404);
  });
});

describe("Feishu bot status derivation", () => {
  const reported = (
    overrides: Partial<MultiremiFeishuBotRuntimeStatus> = {},
  ): MultiremiFeishuBotRuntimeStatus => ({
    workspaceId: "local",
    runtimeId: "rt_a",
    appliedRevision: 3,
    state: "online",
    botName: "Concierge",
    botOpenId: null,
    errorCode: null,
    errorMessage: null,
    reportedAt: new Date().toISOString(),
    ...overrides,
  });
  const base = { enabled: true, revision: 3, runtimeOnline: true, staleRuntimeCount: 0 };

  it("reads the config's intent before anything a Runtime reports", () => {
    // A disabled bot is `stopped` even if a Runtime still claims it is online:
    // the admin's intent is the answer to "what is this bot doing".
    expect(deriveStatus({ ...base, enabled: false, reported: reported() })).toBe("stopped");
  });

  it("reports an overlap ahead of everything else", () => {
    // Two hosts is the one condition that silently produces duplicate replies,
    // so it outranks even an offline Runtime in what the admin is shown.
    expect(deriveStatus({ ...base, staleRuntimeCount: 1, reported: reported() })).toBe("degraded");
    expect(deriveStatus({ ...base, runtimeOnline: false, staleRuntimeCount: 1, reported: null })).toBe("degraded");
  });

  it("distinguishes a Runtime that is gone from a bot that has not started", () => {
    expect(deriveStatus({ ...base, runtimeOnline: false, reported: null })).toBe("runtime_offline");
    expect(deriveStatus({ ...base, reported: null })).toBe("deploying");
  });

  it("does not show a stale failure as the current state", () => {
    // The Runtime is alive but still on revision 2; its failure described the
    // config the admin has already replaced.
    expect(deriveStatus({
      ...base,
      reported: reported({ appliedRevision: 2, state: "failed", errorCode: "invalid_credentials" }),
    })).toBe("deploying");
  });

  it("passes through what the Runtime reports for the current revision", () => {
    expect(deriveStatus({ ...base, reported: reported({ state: "starting" }) })).toBe("connecting");
    expect(deriveStatus({ ...base, reported: reported({ state: "online" }) })).toBe("online");
    expect(deriveStatus({ ...base, reported: reported({ state: "failed" }) })).toBe("failed");
    expect(deriveStatus({ ...base, reported: reported({ state: "stopped" }) })).toBe("deploying");
  });
});
