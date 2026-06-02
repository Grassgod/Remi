import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiAdapter } from "../../src/plugins/config-hub/adapters/gemini.js";
import type { EntryMap } from "../../src/plugins/config-hub/types.js";

let dir: string;
let file: string;
const adapter = new GeminiAdapter();

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("GeminiAdapter", () => {
  it("round-trips stdio, http (url↔httpUrl) and sse with type inference", () => {
    const servers = {
      a: { type: "stdio", command: "srv", args: ["--x"] },
      b: { type: "http", url: "http://h" },
      c: { type: "sse", url: "http://s" },
    } satisfies EntryMap;
    adapter.writeMcp(file, servers);
    expect(adapter.readMcp(file)).toEqual(servers);
  });

  it("writes httpUrl and no type field for http servers", () => {
    adapter.writeMcp(file, { b: { type: "http", url: "http://h" } });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.mcpServers.b.httpUrl).toBe("http://h");
    expect(doc.mcpServers.b.type).toBeUndefined();
    expect(doc.mcpServers.b.url).toBeUndefined();
  });

  it("preserves foreign keys, replaces only mcpServers", () => {
    writeFileSync(
      file,
      JSON.stringify({ theme: "GitHub", mcpServers: { old: { command: "o" } } }),
    );
    adapter.writeMcp(file, { x: { type: "stdio", command: "a" } });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.theme).toBe("GitHub");
    expect(doc.mcpServers).toEqual({ x: { command: "a" } }); // type stripped on disk
    expect(adapter.readMcp(file)).toEqual({ x: { type: "stdio", command: "a" } });
  });

  it("empty set leaves mcpServers: {}", () => {
    writeFileSync(file, JSON.stringify({ keepMe: 1, mcpServers: { old: { command: "o" } } }));
    adapter.writeMcp(file, {});
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.keepMe).toBe(1);
    expect(doc.mcpServers).toEqual({});
  });
});
