import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { dispatch } from "../../../apps/remi/cli/index.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const headers = { "Content-Type": "application/json" };
const path = "/api/workspaces/local/relay-config/claude/context-window";

function setup() {
  const store = createLocalStore();
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
    tokenOp: "set", authToken: "test-key",
  });
  store.saveGatewayModels("local", "claude", { sourceRevision: revision, models: [{ id: "claude-opus-5", label: "Opus 5" }] });
  return { store, revision, app: createMultiremiApp({ store }) };
}

describe("gateway context declarations", () => {
  it("defaults off, round-trips provenance, and survives replacement of the discovery snapshot", async () => {
    const { store, revision, app } = setup();
    expect(store.listGatewayModelContext("local", "claude")).toEqual([]);
    const saved = store.saveGatewayModelContext("local", "claude", { modelId: " claude-opus-5 ", updatedBy: "local" });
    expect(saved).toMatchObject({ modelId: "claude-opus-5", contextWindow: "1m", updatedBy: "local" });
    expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true);
    store.saveGatewayModelReasoning("local", "claude", { modelId: "claude-opus-5", levels: ["high"] });
    store.saveGatewayModels("local", "claude", { sourceRevision: revision, models: [] });
    expect(store.getGatewayModelContext("local", "claude", "claude-opus-5")).toEqual(saved);
    const listing = await (await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels")).json();
    expect(listing.models).toHaveLength(1);
    expect(listing.models[0]).toMatchObject({
      model_id: "claude-opus-5", manual: { levels: ["high"] },
      context_window: { one_million: true, updated_by: "local", updated_at: saved.updatedAt },
    });
    expect(store.getGatewayModelContext("other-workspace", "claude", "claude-opus-5")).toBeNull();
    expect(store.listGatewayModelContext("local", "codex")).toEqual([]);
    expect(store.deleteGatewayModelContext("local", "claude", "claude-opus-5")).toBe(true);
    expect(store.deleteGatewayModelContext("local", "claude", "claude-opus-5")).toBe(false);
    expect(store.getGatewayModelReasoning("local", "claude", "claude-opus-5")?.levels).toEqual(["high"]);
  });

  it("PUT enables, lists a context-only model, and clears it without creating reasoning metadata", async () => {
    const { store, app } = setup();
    const put = (one_million: boolean) => app.request(path, {
      method: "PUT", headers, body: JSON.stringify({ model: "old-model", one_million }),
    });
    expect((await put(true)).status).toBe(200);
    const listing = await (await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels")).json();
    expect(listing.models.find((m: any) => m.model_id === "old-model")).toMatchObject({
      context_window: { one_million: true }, manual: null,
    });
    expect(store.getGatewayModelReasoning("local", "claude", "old-model")).toBeNull();
    const cleared = await put(false);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).deleted).toBe(true);
    expect(store.getGatewayModelContext("local", "claude", "old-model")).toBeNull();
  });

  it.each([
    {}, { model: "" , one_million: true }, { model: 7, one_million: true },
    { model: "m" }, { model: "m", one_million: "true" }, { model: "m", one_million: 1 },
  ])("rejects invalid input: %j", async body => {
    const { store, app } = setup();
    expect((await app.request(path, { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(400);
    expect(store.listGatewayModelContext("local", "claude")).toEqual([]);
  });

  it("rejects other engines and malformed JSON", async () => {
    const { app } = setup();
    for (const engine of ["codex", "invalid"]) {
      expect((await app.request(path.replace("claude", engine), {
        method: "PUT", headers, body: JSON.stringify({ model: "m", one_million: true }),
      })).status).toBe(400);
    }
    expect((await app.request(path, { method: "PUT", headers, body: "{" })).status).toBe(400);
  });

  it("requires workspace admin and never writes a refused declaration", async () => {
    const { store } = setup();
    store.createWorkspaceMember({ id: "member-bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.test", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    expect((await app.request(path, {
      method: "PUT", headers: { ...headers, Authorization: `Bearer ${member.token}` },
      body: JSON.stringify({ model: "m", one_million: true }),
    })).status).toBe(403);
    expect(store.listGatewayModelContext("local", "claude")).toEqual([]);
  });

  it("delivers current declarations on register, heartbeat and repository refresh", async () => {
    const { store } = setup();
    store.saveGatewayModelContext("local", "claude", { modelId: "claude-opus-5" });
    const credential = await store.createAccessToken({ workspaceId: "local", type: "daemon", name: "daemon", userId: "local", daemonId: "context-daemon" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const daemonHeaders = { ...headers, Authorization: `Bearer ${credential.token}` };
    const registered = await app.request("/api/daemon/register", {
      method: "POST", headers: daemonHeaders,
      body: JSON.stringify({ daemon_id: "context-daemon", workspace_id: "local", runtimes: [{ type: "claude" }] }),
    });
    expect(registered.status).toBe(200);
    const registration = await registered.json();
    expect(registration.relay.claude.one_million_models).toEqual(["claude-opus-5"]);
    const beat = () => app.request("/api/daemon/heartbeat", {
      method: "POST", headers: daemonHeaders, body: JSON.stringify({ runtime_id: registration.runtimes[0].id }),
    });
    expect((await (await beat()).json()).relay.claude.one_million_models).toEqual(["claude-opus-5"]);
    const repos = await app.request("/api/daemon/workspaces/local/repos", { headers: daemonHeaders });
    expect(repos.status).toBe(200);
    expect((await repos.json()).relay.claude.one_million_models).toEqual(["claude-opus-5"]);
    store.deleteGatewayModelContext("local", "claude", "claude-opus-5");
    expect((await (await beat()).json()).relay.claude.one_million_models).toEqual([]);
  });

  it("exposes working CLI enable/clear flags and rejects ambiguous requests", async () => {
    const { store, app } = setup();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const previousUrl = process.env.MULTIREMI_SERVER_URL;
    process.env.MULTIREMI_SERVER_URL = `http://127.0.0.1:${server.port}`;
    const log = console.log;
    console.log = () => {};
    const args = ["workspace", "relay", "context-window", "update", "local", "claude", "--model", "claude-opus-5"];
    try {
      await dispatch([...args, "--one-million", "--json"]);
      expect(store.getGatewayModelContext("local", "claude", "claude-opus-5")).not.toBeNull();
      await expect(dispatch(args)).rejects.toThrow("choose exactly one");
      await expect(dispatch([...args, "--one-million", "--clear"])).rejects.toThrow("choose exactly one");
      await dispatch([...args, "--clear", "--json"]);
      expect(store.getGatewayModelContext("local", "claude", "claude-opus-5")).toBeNull();
    } finally {
      console.log = log;
      if (previousUrl === undefined) delete process.env.MULTIREMI_SERVER_URL;
      else process.env.MULTIREMI_SERVER_URL = previousUrl;
      server.stop(true);
    }
  });
});
