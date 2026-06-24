import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import { CodexAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/codex.js";
import type { EntryMap } from "../../../../src/daemon/agent-runtime/config-hub/types.js";

let dir: string;
let file: string;
const adapter = new CodexAdapter();

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, "config.toml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CodexAdapter", () => {
  it("round-trips stdio and http (headers↔http_headers)", () => {
    const servers = {
      a: { command: "srv", args: ["--x"], env: { K: "v" } },
      b: { type: "http", url: "http://h", headers: { Authorization: "Bearer t" } },
    } satisfies EntryMap;
    adapter.writeMcp(file, servers);
    expect(adapter.readMcp(file)).toEqual(servers);
  });

  it("emits the standard top-level [mcp_servers] table", () => {
    adapter.writeMcp(file, { a: { command: "srv" } });
    const doc = parseToml(readFileSync(file, "utf8")) as any;
    expect(doc.mcp_servers.a.command).toBe("srv");
  });

  it("preserves foreign tables/keys (not comments)", () => {
    writeFileSync(
      file,
      'model = "gpt-5"\n[projects."/a/b"]\ntrust_level = "trusted"\n[mcp_servers.old]\ncommand = "o"\n',
    );
    adapter.writeMcp(file, { x: { command: "a" } });
    const doc = parseToml(readFileSync(file, "utf8")) as any;
    expect(doc.model).toBe("gpt-5");
    expect(doc.projects["/a/b"].trust_level).toBe("trusted");
    expect(doc.mcp_servers).toEqual({ x: { command: "a" } }); // old replaced
  });

  it("empty set removes the whole [mcp_servers] table, keeps the rest", () => {
    writeFileSync(file, 'model = "gpt-5"\n[mcp_servers.old]\ncommand = "o"\n');
    adapter.writeMcp(file, {});
    const doc = parseToml(readFileSync(file, "utf8")) as any;
    expect(doc.model).toBe("gpt-5");
    expect(doc.mcp_servers).toBeUndefined();
  });

  it("throws on malformed TOML instead of clobbering", () => {
    writeFileSync(file, "this is = = not toml [[[");
    expect(() => adapter.readMcp(file)).toThrow();
  });

  it("prepareScope records project trust in <home>/.codex/config.toml", () => {
    const fakeHome = join(dir, "home");
    const codexDir = join(fakeHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const projectDir = join(dir, "proj");
    mkdirSync(projectDir, { recursive: true });

    const homed = new CodexAdapter(fakeHome);
    homed.prepareScope({ kind: "project", projectDir });
    const doc = parseToml(readFileSync(join(codexDir, "config.toml"), "utf8")) as any;
    expect(doc.projects[projectDir].trust_level).toBe("trusted");
  });
});
