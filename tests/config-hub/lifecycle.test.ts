/**
 * End-to-end MCP lifecycle through the real ClaudeAdapter + sync orchestrator,
 * using an in-memory DB (EntryMap) + manifest store. Proves the full vertical:
 * create → model-edit (import) → disable → delete, plus idempotency and
 * foreign-content survival.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../../src/daemon/agent-runtime/config-hub/adapters/claude.js";
import { syncMcp, scopeKey, type ManifestStore } from "../../src/daemon/agent-runtime/config-hub/sync.js";
import type { AppType, EntryMap, Manifest, Scope } from "../../src/daemon/agent-runtime/config-hub/types.js";

class MemManifests implements ManifestStore {
  private m = new Map<string, Manifest>();
  get(app: AppType, key: string): Manifest {
    return this.m.get(`${app}:${key}`) ?? {};
  }
  set(app: AppType, key: string, manifest: Manifest): void {
    this.m.set(`${app}:${key}`, manifest);
  }
}

let dir: string;
let projectDir: string;
let mcpFile: string;
let scope: Scope;
const adapter = new ClaudeAdapter();
let manifests: MemManifests;
let db: EntryMap; // the "DB" enabled set for claude in this scope

/** Apply a sync's DB mutations back into our in-memory db. */
function applyMutations(out: { imports: EntryMap; disables: string[] }) {
  for (const [name, cfg] of Object.entries(out.imports)) db[name] = cfg;
  for (const name of out.disables) delete db[name];
}

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-life-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(dir, "proj");
  mkdirSync(projectDir, { recursive: true });
  mcpFile = join(projectDir, ".mcp.json");
  scope = { kind: "project", projectDir };
  manifests = new MemManifests();
  db = {};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers;

describe("MCP lifecycle (claude, project scope)", () => {
  it("create → file gets the server", () => {
    db = { srv: { command: "a" } };
    syncMcp(adapter, scope, db, manifests);
    expect(read()).toEqual({ srv: { command: "a" } });
  });

  it("idempotent: second sync produces identical file", () => {
    db = { srv: { command: "a" } };
    syncMcp(adapter, scope, db, manifests);
    const first = readFileSync(mcpFile, "utf8");
    syncMcp(adapter, scope, db, manifests);
    expect(readFileSync(mcpFile, "utf8")).toBe(first);
  });

  it("model edits the file in-place → next sync imports it back to DB", () => {
    db = { srv: { command: "a" } };
    syncMcp(adapter, scope, db, manifests);
    // simulate the tool/model rewriting the server config in the file
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { srv: { command: "EDITED" } } }));
    const out = syncMcp(adapter, scope, db, manifests);
    expect(out.imports).toEqual({ srv: { command: "EDITED" } });
    applyMutations(out);
    expect(db.srv).toEqual({ command: "EDITED" }); // DB caught up, no clobber
  });

  it("disable (DB drops it after having written it) → removed from file", () => {
    db = { srv: { command: "a" } };
    syncMcp(adapter, scope, db, manifests); // base now records srv
    db = {}; // disabled in DB
    syncMcp(adapter, scope, db, manifests);
    expect(read()).toEqual({});
  });

  it("user adds a server directly → imported, never clobbered", () => {
    db = { hub: { command: "h" } };
    syncMcp(adapter, scope, db, manifests);
    // user hand-adds 'mine' alongside hub's server
    writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { hub: { command: "h" }, mine: { command: "m" } } }),
    );
    const out = syncMcp(adapter, scope, db, manifests);
    expect(out.imports).toEqual({ mine: { command: "m" } });
    applyMutations(out);
    expect(read()).toEqual({ hub: { command: "h" }, mine: { command: "m" } }); // both survive
  });

  it("foreign keys in .mcp.json survive every sync", () => {
    writeFileSync(mcpFile, JSON.stringify({ $schema: "x", mcpServers: {} }));
    db = { srv: { command: "a" } };
    syncMcp(adapter, scope, db, manifests);
    expect(JSON.parse(readFileSync(mcpFile, "utf8")).$schema).toBe("x");
  });

  it("not present → skipped, no file created", () => {
    const absentScope: Scope = { kind: "project", projectDir: join(dir, "does-not-exist") };
    const out = syncMcp(adapter, absentScope, { srv: { command: "a" } }, manifests);
    expect(out.synced).toBe(false);
    expect(existsSync(join(dir, "does-not-exist", ".mcp.json"))).toBe(false);
  });

  it("scopeKey distinguishes global vs project", () => {
    expect(scopeKey({ kind: "global" })).toBe("global");
    expect(scopeKey(scope)).toContain("project:");
  });
});
