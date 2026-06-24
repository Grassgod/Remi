import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/claude.js";
import type { EntryMap } from "../../../../src/daemon/agent-runtime/config-hub/types.js";

let dir: string;
let file: string;
const adapter = new ClaudeAdapter();

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, ".mcp.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ClaudeAdapter", () => {
  it("round-trips written servers", () => {
    const servers = { x: { command: "a", args: ["--p"] }, y: { type: "http", url: "http://h" } } satisfies EntryMap;
    adapter.writeMcp(file, servers);
    expect(adapter.readMcp(file)).toEqual(servers);
  });

  it("missing file reads as empty", () => {
    expect(adapter.readMcp(join(dir, "nope.json"))).toEqual({});
  });

  it("preserves foreign keys and replaces only mcpServers", () => {
    writeFileSync(
      file,
      JSON.stringify({ numStartups: 5, theme: "dark", mcpServers: { old: { command: "o" } } }),
    );
    adapter.writeMcp(file, { x: { command: "a" } });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.numStartups).toBe(5);
    expect(doc.theme).toBe("dark");
    expect(doc.mcpServers).toEqual({ x: { command: "a" } });
  });

  it("empty set clears only the mcpServers section", () => {
    writeFileSync(file, JSON.stringify({ keepMe: true, mcpServers: { old: { command: "o" } } }));
    adapter.writeMcp(file, {});
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.keepMe).toBe(true);
    expect(doc.mcpServers).toEqual({});
  });

  it("throws on malformed JSON instead of clobbering", () => {
    writeFileSync(file, "{ this is : not json");
    expect(() => adapter.readMcp(file)).toThrow();
    expect(() => adapter.writeMcp(file, { x: { command: "a" } })).toThrow();
  });
});
