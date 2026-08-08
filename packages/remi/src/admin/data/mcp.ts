/**
 * RemiData — MCP scopes.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProjectStore } from "../../project/store.js";
import { RemiDataContext } from "./context.js";

export class McpData {
  constructor(private readonly ctx: RemiDataContext) {}

  listMcpServers(): Array<{ name: string; command: string; args: string[] }> {
    const mcpPath = join(homedir(), ".mcp.json");
    if (!existsSync(mcpPath)) return [];
    try {
      const config = JSON.parse(readFileSync(mcpPath, "utf-8"));
      return Object.entries(config.mcpServers ?? {}).map(([name, cfg]: [string, any]) => ({
        name,
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        // Intentionally omit env to avoid leaking secrets
      }));
    } catch { return []; }
  }

  listMcpScopes(): Array<{
    id: string;
    label: string;
    path: string;
    mcpJsonPath: string;
    serverCount: number;
    hasConfig: boolean;
  }> {
    const scopes: Array<{
      id: string; label: string; path: string;
      mcpJsonPath: string; serverCount: number; hasConfig: boolean;
    }> = [];

    // Global scope
    const globalMcpPath = join(homedir(), ".mcp.json");
    const globalExists = existsSync(globalMcpPath);
    let globalCount = 0;
    if (globalExists) {
      try {
        const cfg = JSON.parse(readFileSync(globalMcpPath, "utf-8"));
        globalCount = Object.keys(cfg.mcpServers ?? {}).length;
      } catch {}
    }
    scopes.push({
      id: "__global__",
      label: "Global (~)",
      path: homedir(),
      mcpJsonPath: globalMcpPath,
      serverCount: globalCount,
      hasConfig: globalExists,
    });

    // Project scopes
    const { ProjectStore } = require("../../project/store.js");
    const pStore = new ProjectStore();
    const dbProjects: Record<string, string> = {};
    for (const p of pStore.list()) { if (p.cwd) dbProjects[p.id] = p.cwd; }
    for (const [alias, projPath] of Object.entries(dbProjects)) {
      const mcpJsonPath = join(projPath, ".mcp.json");
      const exists = existsSync(mcpJsonPath);
      let count = 0;
      if (exists) {
        try {
          const cfg = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
          count = Object.keys(cfg.mcpServers ?? {}).length;
        } catch {}
      }
      scopes.push({
        id: alias,
        label: alias,
        path: projPath,
        mcpJsonPath,
        serverCount: count,
        hasConfig: exists,
      });
    }

    return scopes;
  }

  getMcpScopeDetail(scopeId: string): {
    raw: string;
    servers: Array<{
      name: string;
      command: string;
      args: string[];
      envKeys: string[];
    }>;
  } | null {
    const scopes = this.listMcpScopes();
    const scope = scopes.find(s => s.id === scopeId);
    if (!scope) return null;

    if (!existsSync(scope.mcpJsonPath)) {
      return { raw: '{\n  "mcpServers": {}\n}', servers: [] };
    }

    const raw = readFileSync(scope.mcpJsonPath, "utf-8");
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return { raw, servers: [] }; }

    const servers = Object.entries(parsed.mcpServers ?? {}).map(([name, cfg]: [string, any]) => ({
      name,
      command: cfg.command ?? "",
      args: cfg.args ?? [],
      envKeys: Object.keys(cfg.env ?? {}),
    }));

    return { raw, servers };
  }

  writeMcpScope(scopeId: string, content: string): { ok: boolean; error?: string } {
    const scopes = this.listMcpScopes();
    const scope = scopes.find(s => s.id === scopeId);
    if (!scope) return { ok: false, error: "scope not found" };

    let parsed: any;
    try { parsed = JSON.parse(content); } catch {
      return { ok: false, error: "invalid JSON" };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, error: "root must be an object" };
    }

    // Auto-wrap if user pastes bare servers (no mcpServers key)
    if (!parsed.mcpServers && !Array.isArray(parsed)) {
      const values = Object.values(parsed);
      if (values.length > 0 && values.every((v: any) => v && typeof v.command === "string")) {
        parsed = { mcpServers: parsed };
      }
    }

    if (existsSync(scope.mcpJsonPath)) {
      this.ctx._backup(scope.mcpJsonPath);
    }

    writeFileSync(scope.mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { ok: true };
  }

  deleteMcpServer(scopeId: string, serverName: string): { ok: boolean; error?: string } {
    const scopes = this.listMcpScopes();
    const scope = scopes.find(s => s.id === scopeId);
    if (!scope) return { ok: false, error: "scope not found" };
    if (!existsSync(scope.mcpJsonPath)) return { ok: false, error: "no config file" };

    let parsed: any;
    try { parsed = JSON.parse(readFileSync(scope.mcpJsonPath, "utf-8")); } catch {
      return { ok: false, error: "invalid JSON in file" };
    }

    if (!parsed.mcpServers?.[serverName]) {
      return { ok: false, error: "server not found" };
    }

    this.ctx._backup(scope.mcpJsonPath);
    delete parsed.mcpServers[serverName];
    writeFileSync(scope.mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { ok: true };
  }

  mergeMcpServers(scopeId: string, input: string): { ok: boolean; added: string[]; error?: string } {
    const scopes = this.listMcpScopes();
    const scope = scopes.find(s => s.id === scopeId);
    if (!scope) return { ok: false, added: [], error: "scope not found" };

    let incoming: any;
    try { incoming = JSON.parse(input); } catch {
      return { ok: false, added: [], error: "invalid JSON" };
    }

    // Normalize: extract mcpServers if wrapped
    const servers: Record<string, any> = incoming.mcpServers ?? incoming;

    // Validate that entries look like server configs
    for (const [, cfg] of Object.entries(servers)) {
      if (!cfg || typeof (cfg as any).command !== "string") {
        return { ok: false, added: [], error: "each server must have a 'command' field" };
      }
    }

    // Load existing
    let existing: any = { mcpServers: {} };
    if (existsSync(scope.mcpJsonPath)) {
      try { existing = JSON.parse(readFileSync(scope.mcpJsonPath, "utf-8")); } catch {}
      if (!existing.mcpServers) existing.mcpServers = {};
      this.ctx._backup(scope.mcpJsonPath);
    }

    const added: string[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      existing.mcpServers[name] = cfg;
      added.push(name);
    }

    writeFileSync(scope.mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    return { ok: true, added };
  }
}
