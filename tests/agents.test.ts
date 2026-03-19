import { describe, it, expect } from "bun:test";
import { AgentRunner } from "../src/agents/runner.js";
import { AGENTS } from "../src/agents/registry.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(join(import.meta.dir, ".."));

describe("AgentRegistry", () => {
  it("has all 4 agents registered", () => {
    expect(Object.keys(AGENTS)).toEqual([
      "memory-extract",
      "memory-audit",
      "memory-rerank",
      "wiki-curate",
    ]);
  });

  it("memory-extract uses haiku", () => {
    expect(AGENTS["memory-extract"].model).toBe("haiku");
    expect(AGENTS["memory-extract"].trigger).toBe("debounce");
    expect(AGENTS["memory-extract"].debounce_ms).toBe(300_000);
  });

  it("memory-audit uses opus with cron", () => {
    expect(AGENTS["memory-audit"].model).toBe("opus");
    expect(AGENTS["memory-audit"].trigger).toBe("cron");
    expect(AGENTS["memory-audit"].cron).toBe("30 3 * * *");
  });

  it("memory-rerank is on-demand", () => {
    expect(AGENTS["memory-rerank"].trigger).toBe("on-demand");
    expect(AGENTS["memory-rerank"].timeoutMs).toBe(30_000);
  });

  it("wiki-curate uses opus with cron", () => {
    expect(AGENTS["wiki-curate"].model).toBe("opus");
    expect(AGENTS["wiki-curate"].cron).toBe("0 3 * * *");
  });
});

describe("AgentDirectories", () => {
  for (const name of Object.keys(AGENTS)) {
    it(`${name} has CLAUDE.md`, () => {
      const claudeMd = join(PROJECT_ROOT, "agents", name, ".claude", "CLAUDE.md");
      expect(existsSync(claudeMd)).toBe(true);
    });

    it(`${name} has settings.local.json`, () => {
      const settings = join(PROJECT_ROOT, "agents", name, ".claude", "settings.local.json");
      expect(existsSync(settings)).toBe(true);
    });
  }
});

describe("AgentRunner", () => {
  it("throws on unknown agent", async () => {
    const runner = new AgentRunner();
    await expect(runner.run("nonexistent", "test")).rejects.toThrow("Unknown agent");
  });
});
