import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

it("delivers encrypted Runtime profile keys to task execution while preserving the base home", async () => {
  const root = mkdtempSync(join(tmpdir(), "remi-profile-daemon-"));
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  const originalHome = process.env.CODEX_HOME;
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.CODEX_HOME = join(root, "empty-base-home");
  const daemonToken = await store.createAccessToken({ name: "Profile daemon", type: "daemon", workspaceId: "local", daemonId: "profile-daemon", userId: "local" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "profile-test-master", hostname: "127.0.0.1", port: 0 });
  const observations: { url: unknown; model: unknown; key: string | undefined; home: string }[] = [];
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`, token: daemonToken.token, daemonId: "profile-daemon", runtimeName: "Profile daemon", provider: "codex", workspaceId: "local",
    daemonPort: 0, pollIntervalMs: 20, gcEnabled: false, workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "cache"),
    providerFactory: options => ({
      async *sendStream() {
        const home = options.env!.CODEX_HOME!;
        const text = readFileSync(join(home, "config.toml"), "utf8");
        const config = parse(text) as any;
        observations.push({ url: config.model_providers.remi_custom.base_url, model: config.model, key: options.env?.OPENAI_API_KEY, home });
        expect(text).not.toContain("private-key-");
        expect(config.model_provider).toBe("remi_custom");
        expect(options.env?.MODEL_PROVIDER).toBe("remi_custom");
        expect(options.env?.CODEX_CONFIG).toBe("");
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Profile execution completed" }] } as any;
      },
      getLastResponse: () => ({ text: "Profile execution completed", sessionId: `profile-session-${observations.length}`, requestId: `profile-request-${observations.length}` }),
    }),
  });
  const run = daemon.start();
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for profile execution"); await Bun.sleep(20); }
  };
  try {
    await waitFor(() => store.listRuntimes().length > 0);
    const runtime = store.listRuntimes()[0]!;
    expect(runtime.metadata.codex_profiles).toBe(1);
    const agent = store.createAgent({ name: "Custom model", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    for (const version of [1, 2]) {
      const config = { profile: { name: "private", base_url: `http://127.0.0.1:${8100 + version}/v1`, model: `unlisted-${version}`, env_key: "", auth_mode: "api_key" }, api_key: `private-key-${version}` };
      const saved = await fetch(`http://127.0.0.1:${server.port}/api/runtimes/${runtime.id}/codex-profile`, { method: "PUT", headers: { Authorization: "Bearer profile-test-master", "Content-Type": "application/json" }, body: JSON.stringify(config) });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain(config.api_key);
      const task = store.sendChatMessage(chat.id, { body: `Run ${version}` }).task;
      await waitFor(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      expect(store.getTask(task.id)?.error).toBeNull();
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(observations[version - 1]).toMatchObject({ model: config.profile.model, url: config.profile.base_url, key: config.api_key });
    }
    expect(observations[0]!.home).not.toBe(observations[1]!.home);
    expect(await Bun.file(join(process.env.CODEX_HOME!, "config.toml")).exists()).toBe(false);
  } finally {
    daemon.stop();
    await run.catch(() => {});
    await server.stop(true);
    db.close();
    if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY; else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
