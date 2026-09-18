import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

for (const provider of ["codex", "claude"] as const) {
  it(`discovers custom ${provider} models, caches refreshes and executes the selected model`, async () => {
    const root = mkdtempSync(join(tmpdir(), "remi-profile-catalog-"));
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const envKey = provider === "codex" ? "REMI_CODEX_CATALOG_TEST_KEY" : "REMI_CLAUDE_CATALOG_TEST_KEY";
    const oldKey = process.env[envKey];
    process.env[envKey] = "private-catalog-key";
    const oldCodexExecutable = process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE;
    if (provider === "codex") {
      const validator = join(root, "codex-acp");
      writeFileSync(validator, '#!/usr/bin/env node\nprocess.exit(process.argv.slice(2, 5).join(" ") === "cli debug models" ? 0 : 1);\n', { mode: 0o700 });
      process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = validator;
    }
    let probes = 0;
    let failProbe = false;
    let failAcp = false;
    let revokeThinking = false;
    const catalog = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      probes++;
      expect(request.headers.get("authorization")).toBe("Bearer private-catalog-key");
      return failProbe ? new Response("do not expose private-catalog-key", { status: 503 })
        : Response.json({ data: [{ id: "astra" }, { id: "sol" }], ...(provider === "codex" ? { models: [{
          slug: "sol", display_name: "Sol", base_instructions: "Provider instructions", supported_reasoning_levels: [], shell_type: "shell_command",
          visibility: "list", supported_in_api: true, priority: 0, support_verbosity: false,
          truncation_policy: { mode: "tokens", limit: 10_000 }, experimental_supported_tools: [], context_window: 270_000,
        }] } : {}) });
    } });
    const runtime = store.registerRuntime({ id: "rt_catalog", name: "Catalog", provider, daemonId: "catalog-daemon", workspaceId: "local", ownerId: "local", metadata: { codex_profiles: 1, claude_profiles: 1 } });
    const profile = { name: "catalog", base_url: `http://127.0.0.1:${catalog.port}/v1`, model: "astra", env_key: envKey };
    if (provider === "codex") store.setRuntimeCodexProfile(runtime.id, profile);
    else store.setRuntimeClaudeProfile(runtime.id, profile);
    const credential = await store.createAccessToken({ name: "Catalog", type: "daemon", workspaceId: "local", daemonId: "catalog-daemon", userId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "catalog-test-master", hostname: "127.0.0.1", port: 0 });
    let model: unknown;
    let modelMetadata: Record<string, unknown> | undefined;
    let reports = 0;
    const updateModels = store.updateRuntimeModels.bind(store);
    store.updateRuntimeModels = (...args) => { reports++; return updateModels(...args); };
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token, daemonId: "catalog-daemon", runtimeId: runtime.id,
      runtimeName: "Catalog", provider, workspaceId: "local", daemonPort: 0, pollIntervalMs: 20, gcEnabled: false,
      workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "cache"),
      inProcessRuntimeModelDiscoveryEnabled: true, runtimeModelRefreshIntervalMs: 60_000,
      providerFactory: options => ({
        async *sendStream() {
          model = provider === "codex"
            ? parse(readFileSync(join(options.env!.CODEX_HOME!, "config.toml"), "utf8")).model
            : JSON.parse(readFileSync(join(options.env!.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8")).model;
          if (provider === "codex") {
            const config = parse(readFileSync(join(options.env!.CODEX_HOME!, "config.toml"), "utf8"));
            modelMetadata = JSON.parse(readFileSync(String(config.model_catalog_json), "utf8")).models[0];
          }
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Selected model executed" }] } as any;
        },
        getLastResponse: () => ({ text: "Selected model executed", sessionId: "catalog-session", requestId: "catalog-request" }),
        discoverModelCapabilities: async () => {
          if (failAcp) throw new Error("ACP unavailable");
          return [
            { id: "sol", label: "Sol", default: true, ...(revokeThinking ? {} : { effort: { supportedLevels: [{ value: "high", label: "High" }] } }) },
            { id: "official-only", label: "Not in the supplier catalog", default: false },
          ];
        },
      }),
    });
    const run = daemon.start();
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for custom catalog"); await Bun.sleep(20); }
    };
    try {
      await waitFor(() => store.listRuntimeModels(runtime.id).some(model => model.id === "sol"));
      await Bun.sleep(150);
      expect(probes).toBe(1);
      expect(reports).toBe(1);
      expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual(["astra", "sol"]);
      expect(store.listRuntimeModels(runtime.id).find(model => model.id === "sol")?.thinking?.supportedLevels).toEqual([{ value: "high", label: "High" }]);
      const refreshed = store.createRuntimeModelListRequest(runtime.id);
      await waitFor(() => store.getRuntimeModelListRequest(runtime.id, refreshed.id)?.status === "completed");
      expect(store.getRuntimeModelListRequest(runtime.id, refreshed.id)?.models.map(model => model.id)).toEqual(["astra", "sol"]);
      expect(probes).toBe(2);
      const agent = store.createAgent({ name: "Selected custom model", provider, model: "sol" });
      const task = store.sendChatMessage(store.createChatSession({ agentId: agent.id }).id, { body: "Use selected model" }).task;
      await waitFor(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      expect(store.getTask(task.id)?.error).toBeNull();
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(model).toBe("sol");
      if (provider === "codex") expect(modelMetadata).toMatchObject({ slug: "sol", context_window: 270_000 });
      failProbe = true;
      revokeThinking = true;
      const capabilityRefresh = store.createRuntimeModelListRequest(runtime.id);
      await waitFor(() => store.getRuntimeModelListRequest(runtime.id, capabilityRefresh.id)?.status === "completed");
      const retained = store.getRuntimeModelListRequest(runtime.id, capabilityRefresh.id)!.models;
      expect(retained.map(model => model.id)).toEqual(["astra", "sol"]);
      expect(retained.find(model => model.id === "sol")?.thinking).toBeUndefined();
      expect(store.listRuntimeModels(runtime.id).find(model => model.id === "sol")?.thinking).toBeUndefined();
      failAcp = true;
      const refresh = store.createRuntimeModelListRequest(runtime.id);
      await waitFor(() => store.getRuntimeModelListRequest(runtime.id, refresh.id)?.status === "failed");
      expect(store.getRuntimeModelListRequest(runtime.id, refresh.id)?.error).toContain("HTTP 503");
      expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual(["astra", "sol"]);
    } finally {
      daemon.stop();
      await run.catch(() => {});
      server.stop(true);
      catalog.stop(true);
      db.close();
      if (oldKey === undefined) delete process.env[envKey]; else process.env[envKey] = oldKey;
      if (oldCodexExecutable === undefined) delete process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE;
      else process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = oldCodexExecutable;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
