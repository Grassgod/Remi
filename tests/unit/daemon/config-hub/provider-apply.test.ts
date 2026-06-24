import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { parse as parseToml } from "smol-toml";
import { ClaudeAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/claude.js";
import { CodexAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/codex.js";
import { GeminiAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/gemini.js";
import { AdapterRegistry } from "../../../../src/daemon/agent-runtime/config-hub/adapters/base.js";
import { openConfigHubDb } from "../../../../src/daemon/agent-runtime/config-hub/db/config-hub-db.js";
import { ProvidersService } from "../../../../src/daemon/agent-runtime/config-hub/providers-service.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = join(tmpdir(), `cfghub-prov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  home = join(dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ClaudeAdapter.applyProvider", () => {
  it("writes ANTHROPIC_* into settings.json env, preserving other keys", () => {
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", env: { EXISTING: "keep" } }));
    const a = new ClaudeAdapter(home);
    const r = a.applyProvider!({ baseUrl: "https://proxy.example", apiKey: "sk-test", model: "claude-opus-4-8" });
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(doc.theme).toBe("dark");
    expect(doc.env.EXISTING).toBe("keep");
    expect(doc.env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(doc.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(doc.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8");
    expect(r!.files[0]).toContain("settings.json");
  });

  it("creates settings.json if absent", () => {
    const a = new ClaudeAdapter(home);
    a.applyProvider!({ baseUrl: "https://x", apiKey: "k" });
    const doc = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(doc.env.ANTHROPIC_BASE_URL).toBe("https://x");
  });
});

describe("CodexAdapter.applyProvider", () => {
  it("writes config.toml model_providers + auth.json, preserving foreign tables", () => {
    const cfgPath = join(home, ".codex", "config.toml");
    writeFileSync(cfgPath, '[mcp_servers.keep]\ncommand = "x"\n');
    const a = new CodexAdapter(home);
    const r = a.applyProvider!({ baseUrl: "https://gw/v1", apiKey: "sk-cx", model: "gpt-5", wireApi: "chat" }, "mygw");
    const doc = parseToml(readFileSync(cfgPath, "utf8")) as any;
    expect(doc.mcp_servers.keep.command).toBe("x"); // foreign table preserved
    expect(doc.model).toBe("gpt-5");
    expect(doc.model_provider).toBe("mygw");
    expect(doc.model_providers.mygw.base_url).toBe("https://gw/v1");
    expect(doc.model_providers.mygw.env_key).toBe("OPENAI_API_KEY");
    expect(doc.model_providers.mygw.requires_openai_auth).toBe(false);
    const auth = JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8"));
    expect(auth.OPENAI_API_KEY).toBe("sk-cx");
    expect(r!.files.length).toBe(2);
  });

  it("namespaces reserved provider ids (openai → openai-custom)", () => {
    const a = new CodexAdapter(home);
    a.applyProvider!({ baseUrl: "https://x", apiKey: "k" }, "openai");
    const doc = parseToml(readFileSync(join(home, ".codex", "config.toml"), "utf8")) as any;
    expect(doc.model_provider).toBe("openai-custom");
    expect(doc.model_providers["openai-custom"]).toBeDefined();
  });
});

describe("GeminiAdapter.applyProvider", () => {
  it("upserts GEMINI_API_KEY + base url into .env, preserving other lines", () => {
    const envPath = join(home, ".gemini", ".env");
    writeFileSync(envPath, "EXISTING=keep\nGEMINI_API_KEY=old\n");
    const a = new GeminiAdapter(home);
    a.applyProvider!({ baseUrl: "https://g/v1", apiKey: "gk-new" });
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("EXISTING=keep");
    expect(text).toContain("GEMINI_API_KEY=gk-new");
    expect(text).not.toContain("GEMINI_API_KEY=old");
    expect(text).toContain("GOOGLE_GEMINI_BASE_URL=https://g/v1");
  });
});

describe("ProvidersService.switchTo → apply (integration)", () => {
  it("flips is_current and writes the chosen preset to claude settings.json", () => {
    const ccDb = new Database(join(dir, "cc.db"));
    openConfigHubDb(join(dir, "cc.db")).close(); // create tables
    const db2 = new Database(join(dir, "cc.db"));
    const reg = new AdapterRegistry();
    reg.register(new ClaudeAdapter(home));
    const svc = new ProvidersService(db2, reg);

    svc.upsert({ id: "fast", appType: "claude", name: "Fast", settingsConfig: { baseUrl: "https://fast", apiKey: "k1", model: "haiku" } });
    svc.upsert({ id: "smart", appType: "claude", name: "Smart", settingsConfig: { baseUrl: "https://smart", apiKey: "k2", model: "opus" } });

    const applied = svc.switchTo("smart", "claude");
    expect(applied).not.toBeNull();
    expect(svc.current("claude")!.id).toBe("smart");
    const doc = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(doc.env.ANTHROPIC_BASE_URL).toBe("https://smart");
    expect(doc.env.ANTHROPIC_MODEL).toBe("opus");

    // switch again → file reflects the other preset
    svc.switchTo("fast", "claude");
    const doc2 = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(doc2.env.ANTHROPIC_BASE_URL).toBe("https://fast");

    db2.close();
    ccDb.close();
  });
});
