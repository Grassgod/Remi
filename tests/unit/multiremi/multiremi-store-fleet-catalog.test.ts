// The fleet catalog the UI reads: which engines/models an any-provider runtime
// surfaces, how models bucket by runtime engine, and cross-connection claim atomicity.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — fleet engine and model catalog", () => {
  it("rejects unknown providers smuggled through an any-provider runtime", async () => {
    const store = createStore();
    const anyRuntime = store.registerRuntime({ id: "rt_any_gate", name: "any gate", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const smuggled = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gemini smuggle", runtime_id: anyRuntime.id, provider: "gemini" }),
    });
    expect(smuggled.status).toBe(400);
    expect(await smuggled.json()).toEqual({ error: 'unknown provider "gemini"' });

    // Omitting the provider falls back to the default engine.
    const defaulted = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Any default", runtime_id: anyRuntime.id }),
    });
    expect(defaulted.status).toBe(201);
    expect(store.getAgent((await defaulted.json()).id)?.provider).toBe("claude");
  });

  it("surfaces engines through an any-provider runtime in the fleet catalog", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_fleet_any_only", name: "fleet any only", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    const body = await response.json();
    const providers = new Map(body.providers.map((entry: any) => [entry.provider, entry]));
    expect((providers.get("claude") as any)?.online_runtime_count).toBe(1);
    expect((providers.get("codex") as any)?.online_runtime_count).toBe(1);
  });

  it("maps an any-runtime's vendor models onto the right engine buckets", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_any_models",
      name: "any with models",
      provider: "any",
      workspaceId: "local",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", default: true },
      ],
    });
    const app = createMultiremiApp({ store });
    const body = await (await app.request("/api/models")).json();
    const codex = body.providers.find((e: any) => e.provider === "codex");
    const claude = body.providers.find((e: any) => e.provider === "claude");
    expect(codex.models.map((m: any) => m.id)).toEqual(["gpt-5.5"]);
    expect(claude.models.map((m: any) => m.id)).toEqual(["claude-sonnet-4-6"]);
    // No vendor buckets leak into the response.
    expect(body.providers.find((e: any) => e.provider === "openai")).toBeUndefined();
    expect(body.providers.find((e: any) => e.provider === "anthropic")).toBeUndefined();
  });

  it("buckets fleet models by the runtime engine, not the model vendor", async () => {
    const store = createStore();
    // Production shape: codex runtime reports models with vendor provider "openai".
    store.registerRuntime({
      id: "rt_engine_bucket",
      name: "codex box",
      provider: "codex",
      workspaceId: "local",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
        { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: false },
      ],
    });
    const app = createMultiremiApp({ store });
    const body = await (await app.request("/api/models")).json();
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    // Models land in the codex (engine) bucket, not an "openai" bucket.
    expect(codex.online_runtime_count).toBe(1);
    expect(codex.models.map((m: any) => m.id).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(body.providers.find((entry: any) => entry.provider === "openai")).toBeUndefined();
  });

  it("counts only the caller's usable runtimes in the fleet catalog", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    // Alice's private codex runtime + Bob's private codex runtime + a public one.
    store.registerRuntime({ id: "rt_cap_alice", name: "alice codex", provider: "codex", workspaceId: "local", ownerId: "alice", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_bob", name: "bob codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_pub", name: "shared codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "public" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/models", { headers: { Authorization: `Bearer ${aliceToken.token}` } });
    const body = await response.json();
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    // Alice sees her own private + the public one, NOT bob's private one.
    expect(codex.online_runtime_count).toBe(2);
  });

  it("serves the fleet model catalog grouped by provider", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_fleet_claude_a",
      name: "fleet claude a",
      provider: "claude",
      workspaceId: "local",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", provider: "claude", default: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false },
      ],
    });
    store.registerRuntime({
      id: "rt_fleet_claude_b",
      name: "fleet claude b",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false }],
    });
    const offline = store.registerRuntime({
      id: "rt_fleet_codex",
      name: "fleet codex",
      provider: "codex",
      workspaceId: "local",
      models: [{ id: "gpt-5.2", label: "GPT-5.2", provider: "codex", default: true }],
    });
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", offline.id]);

    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    const claude = body.providers.find((entry: any) => entry.provider === "claude");
    expect(claude.online_runtime_count).toBe(2);
    expect(claude.models.map((model: any) => model.id).sort()).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(claude.models.find((model: any) => model.id === "claude-opus-4-8").default).toBe(true);
    // Offline runtimes still surface their provider (capacity 0) but not a catalog.
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    expect(codex.online_runtime_count).toBe(0);
    expect(codex.models).toEqual([]);
  });

  it("claims runtime tasks atomically across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-task-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const runtime = storeA.registerRuntime({ id: "rt_atomic_claim", name: "atomic", provider: "codex", maxConcurrency: 1 });
      const agent = storeA.createAgent({ name: "Atomic Codex", provider: "codex" });
      const otherAgent = storeA.createAgent({ name: "Other Atomic Codex", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "claim exactly once" });
      const otherTask = storeA.createTask({ agentId: otherAgent.id, prompt: "wait for runtime capacity" });

      const first = storeA.claimTask(runtime.id);
      const second = storeB.claimTask(runtime.id);
      const claimedIds = [first?.id, second?.id].filter(Boolean);
      expect(claimedIds).toEqual([task.id]);
      expect(storeA.getTask(task.id)?.status).toBe("dispatched");
      expect(storeA.getTask(task.id)?.runtimeId).toBe(runtime.id);
      expect(storeA.getTask(otherTask.id)?.status).toBe("queued");
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
