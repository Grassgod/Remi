import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { discoverGatewayModels, gatewayProbeSnapshot, probeGatewayModels } from "@multiremi/relay/discovery.js";
import { extractBaseUrl, validateRelayFragment } from "@multiremi/relay/fragment.js";
import { catalogAllowsModel, fleetModelsResponse, overlayGatewayModels } from "@multiremi/store/runtime-model-catalog.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { hotspotProbe, instrumentHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-pr2-fixture.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const admin = { Authorization: "Bearer MASTER", "content-type": "application/json" };
const model = (id: string): MultiremiRuntimeModel => ({
  id, label: id, provider: "cursor", default: true,
  catalog: { status: "ready" }, thinking: { status: "unsupported", supportedLevels: [] },
});

describe("Cursor gateway configuration", () => {
  it("accepts the official backend by default and validates only Cursor settings", () => {
    for (const fragment of [{}, { default_model: "composer-2.5" }, { base_url: "https://api2.cursor.sh" }]) {
      expect(validateRelayFragment("cursor", JSON.stringify(fragment))).toEqual({ ok: true });
    }
    expect(extractBaseUrl("cursor", "{}")).toBeNull();
    expect(extractBaseUrl("cursor", '{"base_url":"https://api2.cursor.sh"}')).toBe("https://api2.cursor.sh");
    for (const fragment of [
      { api_key: "secret" }, { env: { CURSOR_API_KEY: "secret" } }, { model_providers: {} },
      { base_url: "http://api2.cursor.sh" }, { base_url: "https://127.0.0.1" },
      { base_url: "https://api2.cursor.sh?token=x" }, { base_url: "https://api2.cursor.sh#fragment" },
      { default_model: "" }, { default_model: "model with spaces" }, { default_model: {} },
    ]) expect(validateRelayFragment("cursor", JSON.stringify(fragment)).ok).toBe(false);
  });

  it("stores a Cursor key without a custom endpoint and sends it only to administrator daemons", async () => {
    const store = createLocalStore();
    const owner = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "owner", userId: "local" });
    store.createWorkspaceMember({ id: "mem_cursor_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "member", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const put = (body: unknown) => app.request("/api/workspaces/local/relay-config/cursor", {
      method: "PUT", headers: admin, body: JSON.stringify(body),
    });
    const saved = await put({ fragment: "{}", token_op: "set", auth_token: "CURSOR-SECRET" });
    expect(saved.status).toBe(200);
    const browser = await saved.json();
    expect(browser.cursor).toEqual({ fragment: "{}", hasToken: true, revision: 1 });
    expect(JSON.stringify(browser)).not.toContain("CURSOR-SECRET");
    const reveal = await app.request("/api/workspaces/local/relay-config/cursor/reveal", { method: "POST", headers: admin });
    expect(reveal.headers.get("Cache-Control")).toBe("no-store");
    expect((await reveal.json()).token).toBe("CURSOR-SECRET");
    for (const [token, id, allowed] of [[owner.token, "cursor-owner", true], [member.token, "cursor-member", false]] as const) {
      const response = await app.request("/api/daemon/register", {
        method: "POST", headers: { ...admin, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ daemon_id: id, workspace_id: "local", runtimes: [{ type: "cursor" }] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      if (allowed) expect(body.relay.cursor).toEqual({ fragment: "{}", auth_token: "CURSOR-SECRET", revision: 1 });
      else expect(JSON.stringify(body.relay)).not.toContain("CURSOR-SECRET");
    }
    const kept = await put({ fragment: '{"default_model":"composer-2.5"}', token_op: "keep" });
    expect((await kept.json()).cursor).toMatchObject({ hasToken: true, revision: 2 });
    const cleared = await put({ fragment: "{}", token_op: "clear" });
    expect((await cleared.json()).cursor).toMatchObject({ hasToken: false, revision: 3 });
    expect(store.getRelayConfigForDaemon("local").cursor?.authToken).toBe("");
    const denied = await app.request("/api/workspaces/local/relay-config/cursor/probe", {
      method: "POST", headers: { ...admin, Authorization: `Bearer ${member.token}` },
    });
    expect(denied.status).toBe(403);
    for (const suffix of ["reasoning-levels", "context-window"]) {
      const response = await app.request(`/api/workspaces/local/relay-config/cursor/${suffix}`, {
        method: "PUT", headers: admin, body: JSON.stringify({ model: "composer-2.5", levels: ["high"], one_million: true }),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("Cursor native model discovery", () => {
  it("never sends Cursor credentials to a model HTTP endpoint or overlays an HTTP inventory", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "cursor", {
      fragment: '{"base_url":"https://api2.cursor.sh","default_model":"configured-only"}', tokenOp: "set", authToken: "CURSOR-SECRET",
    });
    let requests = 0;
    await discoverGatewayModels(store, "local", "cursor", async () => { requests++; throw new Error("must not fetch"); });
    expect(requests).toBe(0);
    expect(store.getGatewayModels("local", "cursor")).toBeNull();
    store.saveGatewayModels("local", "cursor", { sourceRevision: revision, models: [{ id: "http-only", label: "HTTP only" }] });
    const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local", models: [model("native-model")] });
    const catalog = overlayGatewayModels(store, "local", fleetModelsResponse([runtime], "local"));
    expect(catalog.find(entry => entry.provider === "cursor")?.models.map(entry => entry.id)).toEqual(["native-model"]);
    expect(catalog.find(entry => entry.provider === "cursor")?.model_catalog_status).toBe("ready");
  });

  it("queues native discovery with HTTP discovery disabled and publishes the refreshed catalog", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local", models: [model("old-model"), model("shared")] });
    const second = store.registerRuntime({
      name: "Private Cursor", provider: "cursor", workspaceId: "local", ownerId: "other-owner", visibility: "private",
      models: [model("second-model"), { ...model("shared"), thinking: {
        status: "supported", defaultLevel: "high", supportedLevels: [{ value: "high", label: "High" }],
      } }],
    });
    const other = store.registerRuntime({ name: "Claude", provider: "claude", workspaceId: "local" });
    const offline = store.registerRuntime({ name: "Offline Cursor", provider: "cursor", workspaceId: "local", models: [model("offline-model")] });
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", offline.id]);
    const foreignWorkspace = store.createWorkspace({ name: "Other workspace", slug: "cursor-other" });
    const foreign = store.registerRuntime({ name: "Foreign Cursor", provider: "cursor", workspaceId: foreignWorkspace.id, models: [model("foreign-model")] });
    const events: string[] = [];
    store.onWorkspaceEvent(event => events.push(event.type));
    const result = await probeGatewayModels(store, "local", "cursor", { httpGet: async () => { throw new Error("must not fetch"); } });
    expect(result).toMatchObject({ engine: "cursor", status: "ready", discovery_requested: true, error: null });
    expect(result.models.map(entry => entry.id).sort()).toEqual(["old-model", "second-model", "shared"]);
    expect(result.models.find(entry => entry.id === "shared")?.thinking).toMatchObject({
      status: "supported", default_level: "high", supported_levels: [{ value: "high", label: "High" }],
    });
    for (const excluded of [other, offline, foreign]) {
      expect(store.claimRuntimeModelListRequest(excluded.id)).toBeNull();
    }
    const request = store.claimRuntimeModelListRequest(runtime.id)!;
    const secondRequest = store.claimRuntimeModelListRequest(second.id)!;
    expect(request).not.toBeNull();
    expect(secondRequest).not.toBeNull();
    expect(result.discovery_requests).toHaveLength(2);
    expect(result.discovery_requests).toContainEqual({ runtime_id: runtime.id, request_id: request.id });
    expect(result.discovery_requests).toContainEqual({ runtime_id: second.id, request_id: secondRequest.id });
    store.reportRuntimeModelListResult(runtime.id, request.id, { status: "completed", models: [model("new-model")] });
    expect(events).toContain("daemon:models_updated");
    expect(gatewayProbeSnapshot(store, "local", "cursor").models.map(entry => entry.id).sort()).toEqual(["new-model", "second-model", "shared"]);
  });

  it("keeps probe database reads bounded when other workspaces add runtimes and models", async () => {
    const database = await openHotspotDatabase();
    const metrics = hotspotProbe();
    const store = new MultiremiStore(instrumentHotspotDatabase(database.db, metrics));
    try {
      store.ensureLocalWorkspace();
      const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local", models: [model("native-model")] });
      const foreignWorkspace = store.createWorkspace({ name: "Foreign fleet", slug: "cursor-foreign-fleet" });
      const measure = async () => {
        metrics.reset();
        const result = await probeGatewayModels(store, "local", "cursor");
        expect(result.models.map(entry => entry.id)).toEqual(["native-model"]);
        expect(result.discovery_requests?.map(request => request.runtime_id)).toEqual([runtime.id]);
        expect(metrics.sql.filter(sql => sql.startsWith("WITH selected AS"))).toHaveLength(1);
        return { statements: metrics.statements, bytes: metrics.bytes };
      };
      const baseline = await measure();
      expect(baseline.statements).toBeGreaterThan(0);
      expect(baseline.bytes).toBeGreaterThan(0);
      for (let index = 0; index < 32; index++) {
        store.registerRuntime({
          name: `Foreign Cursor ${index}`, provider: "cursor", workspaceId: foreignWorkspace.id,
          models: [model(`foreign-model-${index}`)],
        });
      }
      expect(await measure()).toEqual(baseline);
    } finally {
      await database.dispose();
    }
  });

  it("returns request identifiers that expose a failed refresh through the existing Runtime endpoint", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request("/api/workspaces/local/relay-config/cursor/probe", { method: "POST", headers: admin });
    const probe = await response.json();
    expect(probe.discovery_requests).toHaveLength(1);
    const request = store.claimRuntimeModelListRequest(runtime.id)!;
    expect(probe.discovery_requests[0]).toEqual({ runtime_id: runtime.id, request_id: request.id });
    store.reportRuntimeModelListResult(runtime.id, request.id, { status: "failed", supported: false, error: "Cursor authentication required" });
    const result = await app.request(`/api/runtimes/${runtime.id}/models/${request.id}`, { headers: admin });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "failed", error: "Cursor authentication required" });
  });

  it("reports that discovery needs an online Cursor Runtime", async () => {
    const store = createLocalStore();
    store.registerRuntime({ name: "Other engine", provider: "claude", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request("/api/workspaces/local/relay-config/cursor/probe", { method: "POST", headers: admin });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      engine: "cursor", status: "error", discovery_requested: false, discovery_requests: [], models: [],
      error: "No online Cursor Runtime is available for model discovery",
    });
  });

  it("validates explicit models against the native catalog for API selection and Runtime routing", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store });
    let agentIndex = 0;
    const create = (body: object) => app.request("/api/agents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Cursor agent ${++agentIndex}`, provider: "cursor", ...body }),
    });
    expect((await create({ model: "missing" })).status).toBe(400);
    const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local", models: [model("native-model")] });
    const accepted = await create({ model: "native-model", runtime_id: runtime.id });
    expect(accepted.status).toBe(201);
    const rejected = await create({ model: "missing", runtime_id: runtime.id });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("cursor execution catalog");
    expect((await create({ model: "native-model", fallback_model: "missing" })).status).toBe(400);
    const agent = store.createAgent({ name: "Saved Cursor", provider: "cursor", model: "native-model", runtimeId: runtime.id });
    expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(true);
    expect(store.runtimeSupportsAgentModel(runtime, { ...agent, model: "missing" })).toBe(false);
    expect(store.runtimeSupportsAgentModel(runtime, { ...agent, model: "" })).toBe(false);
    const catalog = fleetModelsResponse([runtime], "local")[0];
    expect(catalogAllowsModel(undefined, "native-model", "cursor")).toBe(false);
    expect(catalogAllowsModel({ ...catalog, runtime_catalog_status: "error" }, "native-model")).toBe(false);
    expect(fleetModelsResponse([{ ...runtime, models: [] }], "local")[0]?.model_catalog_status).toBe("unknown");
  });
});
