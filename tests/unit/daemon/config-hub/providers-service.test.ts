import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { openConfigHubDb } from "../../../../src/daemon/agent-runtime/config-hub/db/config-hub-db.js";
import { ProvidersService } from "../../../../src/daemon/agent-runtime/config-hub/providers-service.js";

let dir: string;
let db: Database;
let svc: ProvidersService;

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-providers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  db = openConfigHubDb(join(dir, "cc-switch.db"));
  svc = new ProvidersService(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ProvidersService", () => {
  it("upsert + list + filter by app", () => {
    svc.upsert({ id: "anth", appType: "claude", name: "Anthropic", settingsConfig: { key: "x" } });
    svc.upsert({ id: "openai", appType: "codex", name: "OpenAI", settingsConfig: {} });
    expect(svc.list().length).toBe(2);
    expect(svc.list("claude").map((p) => p.id)).toEqual(["anth"]);
    expect(svc.list("codex").map((p) => p.id)).toEqual(["openai"]);
  });

  it("switchTo flips is_current only within the same app_type", () => {
    svc.upsert({ id: "a", appType: "claude", name: "A", settingsConfig: {} });
    svc.upsert({ id: "b", appType: "claude", name: "B", settingsConfig: {} });
    svc.upsert({ id: "c", appType: "codex", name: "C", settingsConfig: {} });
    svc.switchTo("a", "claude");
    expect(svc.current("claude")?.id).toBe("a");
    svc.switchTo("b", "claude");
    expect(svc.current("claude")?.id).toBe("b");
    // c (codex) is untouched
    svc.switchTo("c", "codex");
    expect(svc.current("claude")?.id).toBe("b");
    expect(svc.current("codex")?.id).toBe("c");
  });

  it("delete removes one row but only for that (id, app_type) pair", () => {
    svc.upsert({ id: "shared", appType: "claude", name: "C", settingsConfig: {} });
    svc.upsert({ id: "shared", appType: "codex", name: "X", settingsConfig: {} });
    svc.delete("shared", "claude");
    expect(svc.list("claude").length).toBe(0);
    expect(svc.list("codex").length).toBe(1);
  });

  it("upsert preserves JSON settings round-trip", () => {
    const cfg = { baseUrl: "https://api.example.com", model: "x", nested: { k: 1 } };
    svc.upsert({ id: "p1", appType: "gemini", name: "P1", settingsConfig: cfg });
    expect(svc.list("gemini")[0].settingsConfig).toEqual(cfg);
  });
});
