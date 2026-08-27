import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { feishuSidecarEndpointsFromEnv } from "@multiremi/feishu-ingest/endpoints.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const SIDECAR_URL = "http://127.0.0.1:8042";
const sidecarEndpoints = feishuSidecarEndpointsFromEnv(`local=${SIDECAR_URL}`);
const ROOT = { Authorization: "Bearer root-secret" };
const ROOT_JSON = { ...ROOT, "Content-Type": "application/json" };

/** Every control-plane response is asserted against this: an internal URL, host or
 *  port must never reach the browser, no matter which branch produced the body. */
function expectNoEndpointLeak(text: string): void {
  expect(text).not.toContain("127.0.0.1");
  expect(text).not.toContain("8042");
  expect(text).not.toContain("http://");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Feishu control plane: endpoint registry", () => {
  it("reports ready endpoints by name only and never exposes the URL", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const requested: string[] = [];
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuEndpointHealth: {
        ttlMs: 0,
        now: () => new Date("2026-08-27T10:00:00.000Z"),
        fetch: (async (input: RequestInfo | URL) => {
          requested.push(String(input));
          return jsonResponse({ status: "ok", version: "1.4.2", capabilities: ["message.search"] });
        }) as unknown as typeof fetch,
      },
    });
    store.createFeishuSource({ workspaceId: "local", endpointName: "local" });

    const response = await app.request("/api/workspaces/local/feishu/endpoints", { headers: ROOT });
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoEndpointLeak(text);
    expect(JSON.parse(text)).toEqual({
      configured: true,
      endpoints: [{
        name: "local",
        status: "ready",
        checkedAt: "2026-08-27T10:00:00.000Z",
        latencyMs: 0,
        version: "1.4.2",
        capabilities: ["message.search"],
        errorCode: null,
        sourceCount: 1,
      }],
    });
    expect(requested[0]).toBe(`${SIDECAR_URL}/healthz`);
  });

  it("degrades to unreachable with a sanitized error code", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuEndpointHealth: {
        ttlMs: 0,
        now: () => new Date("2026-08-27T10:00:00.000Z"),
        fetch: (async () => {
          throw new Error(`connect ECONNREFUSED ${SIDECAR_URL}`);
        }) as unknown as typeof fetch,
      },
    });

    const response = await app.request("/api/workspaces/local/feishu/endpoints", { headers: ROOT });
    const text = await response.text();
    expectNoEndpointLeak(text);
    expect(JSON.parse(text).endpoints[0]).toMatchObject({
      name: "local",
      status: "unreachable",
      errorCode: "connection_refused",
      version: null,
    });
  });

  it("reports not-configured without inventing an endpoint", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: feishuSidecarEndpointsFromEnv(""),
    });

    const response = await app.request("/api/workspaces/local/feishu/endpoints", { headers: ROOT });
    expect(await response.json()).toEqual({ configured: false, endpoints: [] });
  });

  it("re-checks on demand and 404s an unregistered name", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    let calls = 0;
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuEndpointHealth: {
        ttlMs: 600_000,
        now: () => new Date("2026-08-27T10:00:00.000Z"),
        fetch: (async () => {
          calls += 1;
          return jsonResponse({ status: "ok" });
        }) as unknown as typeof fetch,
      },
    });

    await app.request("/api/workspaces/local/feishu/endpoints", { headers: ROOT });
    const forced = await app.request("/api/workspaces/local/feishu/endpoints/local/check", {
      method: "POST",
      headers: ROOT,
    });
    expect(forced.status).toBe(200);
    expect((await forced.json()).endpoint).toMatchObject({ name: "local", status: "ready", sourceCount: 0 });
    // Cached list probe + forced re-probe. The TTL never suppresses an explicit check.
    expect(calls).toBeGreaterThanOrEqual(2);

    const missing = await app.request("/api/workspaces/local/feishu/endpoints/does-not-exist/check", {
      method: "POST",
      headers: ROOT,
    });
    expect(missing.status).toBe(404);
    expectNoEndpointLeak(await missing.text());
  });

  it("denies task tokens on every sidecar configuration surface", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });
    const source = store.createFeishuSource({ workspaceId: "local", endpointName: "local" });
    const headers = await taskHeaders(store);

    const routes: Array<[string, string]> = [
      ["GET", "/api/workspaces/local/feishu/endpoints"],
      ["POST", "/api/workspaces/local/feishu/endpoints/local/check"],
      ["GET", `/api/workspaces/local/feishu/sources/${source.id}/available-chats?q=team`],
      ["DELETE", `/api/workspaces/local/feishu/sources/${source.id}`],
    ];
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers });
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await response.json()).toMatchObject({ code: "human_admin_required" });
    }
    // A task token still cannot create a source, so the sidecar wiring stays human-owned.
    const create = await app.request("/api/workspaces/local/feishu/sources", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint_name: "local" }),
    });
    expect(create.status).toBe(403);
  });
});

describe("Feishu control plane: candidate chat lookup", () => {
  it("resolves group chats through the registered endpoint and marks the allowlist", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const requests: Array<{ url: string; body: unknown }> = [];
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuChatDirectory: {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return jsonResponse({
            ok: true,
            data: {
              targets: [
                { scope: "group", target_id: "oc_known01", name: "Release room", member_count: 12, external: false },
                { scope: "group", target_id: "oc_new0001", name: "Support\u0007room", member_count: 4, external: true },
                { scope: "group", target_id: "oc_known01", name: "Duplicate" },
                { scope: "group", target_id: "ou_person1", name: "Not a chat" },
              ],
            },
          });
        }) as unknown as typeof fetch,
      },
    });
    const source = store.createFeishuSource({
      workspaceId: "local",
      endpointName: "local",
      allowlist: [{ chatId: "oc_known01", addedAt: "2026-08-25T10:00:00.000Z" }],
    });

    const response = await app.request(
      `/api/workspaces/local/feishu/sources/${source.id}/available-chats?q=release`,
      { headers: ROOT },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoEndpointLeak(text);
    expect(JSON.parse(text)).toEqual({
      chats: [
        {
          chatId: "oc_known01",
          name: "Release room",
          type: "group",
          memberCount: 12,
          external: false,
          description: null,
          inAllowlist: true,
        },
        {
          chatId: "oc_new0001",
          name: "Support room",
          type: "group",
          memberCount: 4,
          external: true,
          description: null,
          inAllowlist: false,
        },
      ],
      total: 2,
      limit: 20,
    });
    expect(requests).toEqual([{
      url: `${SIDECAR_URL}/api/agent/feishu`,
      body: { version: "v1", action: "target.search", input: { scope: "group", query: "release" } },
    }]);
  });

  it("maps a person to their existing 1:1 chat only", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuChatDirectory: {
        fetch: (async () => jsonResponse({
          ok: true,
          data: {
            targets: [
              { scope: "person", target_id: "ou_person1", name: "Hua", p2p_chat_id: "oc_p2p00001" },
              { scope: "person", target_id: "ou_person2", name: "Never chatted" },
            ],
          },
        })) as unknown as typeof fetch,
      },
    });
    const source = store.createFeishuSource({ workspaceId: "local", endpointName: "local" });

    const response = await app.request(
      `/api/workspaces/local/feishu/sources/${source.id}/available-chats?q=hua&scope=person`,
      { headers: ROOT },
    );
    expect((await response.json()).chats).toEqual([{
      chatId: "oc_p2p00001",
      name: "Hua",
      type: "p2p",
      memberCount: null,
      external: false,
      description: null,
      inAllowlist: false,
    }]);
  });

  it("validates the query before it reaches the sidecar", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    let called = false;
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuChatDirectory: {
        fetch: (async () => {
          called = true;
          return jsonResponse({ ok: true, data: { targets: [] } });
        }) as unknown as typeof fetch,
      },
    });
    const source = store.createFeishuSource({ workspaceId: "local", endpointName: "local" });
    const base = `/api/workspaces/local/feishu/sources/${source.id}/available-chats`;

    const cases: Array<[string, string]> = [
      [`${base}`, "query_required"],
      [`${base}?q=%20%20`, "query_required"],
      [`${base}?q=${"a".repeat(51)}`, "query_too_long"],
      [`${base}?q=team&scope=everything`, "scope_invalid"],
    ];
    for (const [path, code] of cases) {
      const response = await app.request(path, { headers: ROOT });
      expect([path, response.status]).toEqual([path, 400]);
      expect(await response.json()).toEqual({ error: "Feishu chat lookup failed", code });
    }
    expect(called).toBe(false);
  });

  it("surfaces sidecar failures as sanitized codes without leaking the URL", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const failures: Array<() => Promise<Response>> = [
      async () => { throw new Error(`connect ECONNREFUSED ${SIDECAR_URL}`); },
      async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
      async () => jsonResponse({ error: "boom" }, 502),
      async () => jsonResponse({ ok: false, error: { code: "unauthorized" } }),
    ];
    const expected = [
      [502, "sidecar_unreachable"],
      [504, "timeout"],
      [502, "sidecar_http_502"],
      [502, "sidecar_unauthorized"],
    ] as const;
    let index = 0;
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuChatDirectory: { fetch: (async () => failures[index]!()) as unknown as typeof fetch },
    });
    const source = store.createFeishuSource({ workspaceId: "local", endpointName: "local" });

    for (; index < failures.length; index += 1) {
      const response = await app.request(
        `/api/workspaces/local/feishu/sources/${source.id}/available-chats?q=team`,
        { headers: ROOT },
      );
      const text = await response.text();
      expectNoEndpointLeak(text);
      expect([response.status, JSON.parse(text).code]).toEqual([...expected[index]!]);
    }
  });

  it("treats a not_found target as an empty picker result", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: sidecarEndpoints,
      feishuChatDirectory: {
        fetch: (async () => jsonResponse({ ok: false, error: { code: "not_found" } })) as unknown as typeof fetch,
      },
    });
    const source = store.createFeishuSource({ workspaceId: "local", endpointName: "local" });

    const response = await app.request(
      `/api/workspaces/local/feishu/sources/${source.id}/available-chats?q=nobody`,
      { headers: ROOT },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ chats: [], total: 0 });
  });
});

describe("Feishu control plane: message list and source lifecycle", () => {
  it("filters, searches literal wildcards, and paginates consistently", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });
    const source = store.createFeishuSource({
      workspaceId: "local",
      endpointName: "local",
      allowlist: [
        { chatId: "oc_alpha01", addedAt: "2026-08-25T10:00:00.000Z" },
        { chatId: "oc_beta001", addedAt: "2026-08-25T10:00:00.000Z" },
      ],
    });
    store.ingestFeishuBatch(source.id, [
      message("om_1", "oc_alpha01", "2026-08-25T10:01:00.000Z", "50% off today"),
      message("om_2", "oc_alpha01", "2026-08-25T10:02:00.000Z", "50 percent off"),
      message("om_3", "oc_beta001", "2026-08-25T10:03:00.000Z", "deploy_now please"),
      message("om_4", "oc_beta001", "2026-08-25T10:04:00.000Z", "deployXnow please"),
    ]);
    store.resolveFeishuMessage("om_4", { workspaceId: "local", outcome: "ignored", reason: "noise" });

    const search = async (query: string) => {
      const response = await app.request(`/api/workspaces/local/feishu/messages?${query}`, { headers: ROOT });
      expect(response.status).toBe(200);
      return await response.json();
    };

    // `%` and `_` are literal search text, not LIKE wildcards.
    expect((await search("q=50%25")).messages.map((m: { messageId: string }) => m.messageId)).toEqual(["om_1"]);
    expect((await search("q=deploy_now")).messages.map((m: { messageId: string }) => m.messageId)).toEqual(["om_3"]);
    expect((await search("unprocessed=true")).total).toBe(3);
    expect((await search("processed=true")).messages.map((m: { messageId: string }) => m.messageId)).toEqual(["om_4"]);
    expect((await search("chat=oc_beta001")).total).toBe(2);
    expect((await search("since=2026-08-25T10:03:00.000Z")).total).toBe(2);
    expect((await search("until=2026-08-25T10:02:00.000Z")).total).toBe(2);

    const firstPage = await search("limit=2&offset=0");
    const secondPage = await search("limit=2&offset=2");
    expect(firstPage).toMatchObject({ total: 4, limit: 2, offset: 0, hasMore: true });
    expect(secondPage).toMatchObject({ total: 4, limit: 2, offset: 2, hasMore: false });
    const ids = [...firstPage.messages, ...secondPage.messages].map((m: { messageId: string }) => m.messageId);
    expect(new Set(ids).size).toBe(4);

    const conflict = await app.request(
      "/api/workspaces/local/feishu/messages?processed=true&unprocessed=true",
      { headers: ROOT },
    );
    expect(conflict.status).toBe(400);

    const chats = await app.request("/api/workspaces/local/feishu/chats", { headers: ROOT });
    // Most recently active chat first, so the picker surfaces live conversations.
    expect((await chats.json()).chats).toEqual([
      expect.objectContaining({ chatId: "oc_beta001", messageCount: 2, inAllowlist: true }),
      expect.objectContaining({ chatId: "oc_alpha01", messageCount: 2, inAllowlist: true }),
    ]);
  });

  it("deletes a source with its messages and outcomes in one transaction", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });
    const kept = store.createFeishuSource({
      workspaceId: "local",
      name: "kept",
      endpointName: "local",
      allowlist: [{ chatId: "oc_keep001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const doomed = store.createFeishuSource({
      workspaceId: "local",
      name: "doomed",
      endpointName: "backup",
      allowlist: [{ chatId: "oc_doom001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    store.ingestFeishuBatch(kept.id, [message("om_keep", "oc_keep001", "2026-08-25T10:01:00.000Z", "keep")]);
    store.ingestFeishuBatch(doomed.id, [message("om_doom", "oc_doom001", "2026-08-25T10:01:00.000Z", "drop")]);
    store.resolveFeishuMessage("om_doom", { workspaceId: "local", outcome: "ignored", reason: "noise" });

    const response = await app.request(`/api/workspaces/local/feishu/sources/${doomed.id}`, {
      method: "DELETE",
      headers: ROOT_JSON,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });

    expect(store.getFeishuSource(doomed.id)).toBeNull();
    expect(store.getFeishuMessage("om_doom")).toBeNull();
    expect(store.getFeishuMessage("om_keep")).not.toBeNull();
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_message_outcomes").get()).toEqual({ count: 0 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_sync_cursors WHERE source_id = ?")
      .get(doomed.id)).toEqual({ count: 0 });

    const repeated = await app.request(`/api/workspaces/local/feishu/sources/${doomed.id}`, {
      method: "DELETE",
      headers: ROOT_JSON,
    });
    expect(repeated.status).toBe(404);
  });
});

async function taskHeaders(store: MultiremiStore): Promise<Record<string, string>> {
  const agent = store.createAgent({ name: "Feishu worker", provider: "codex" });
  const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
  const credential = await store.createTaskAccessToken(task, "local");
  return { Authorization: `Bearer ${credential.token}` };
}

function message(
  messageId: string,
  chatId: string,
  createdAt: string,
  text: string,
): IngestedFeishuMessageInput {
  return {
    messageId,
    chatId,
    sender: { id: "ou_sender" },
    content: { message_id: messageId, chat_id: chatId, text, create_time: createdAt },
    searchableText: text,
    contentFingerprint: `fingerprint:${messageId}:${text}`,
    createdAt,
  };
}
