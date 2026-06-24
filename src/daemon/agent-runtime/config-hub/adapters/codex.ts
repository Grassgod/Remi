/**
 * Codex CLI adapter.
 *
 * MCP config lives in config.toml under the top-level `[mcp_servers]` table:
 *   - global  → ~/.codex/config.toml
 *   - project → <projectDir>/.codex/config.toml  (only loaded for TRUSTED projects)
 *
 * Project trust is recorded in ~/.codex/config.toml as
 *   [projects."<abs path>"] trust_level = "trusted"
 * which `prepareScope` writes so a project-scoped config is actually loaded.
 *
 * Never touches ~/.codex/auth.json. Field mapping: http/sse `headers` ↔
 * Codex's `http_headers`. NOTE (Phase 1): config.toml is re-serialized via
 * smol-toml, which preserves all data/tables but NOT comments/formatting.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AppType, EntryMap, McpConfig, Scope, ProviderSettings, ProviderApplyResult } from "../types.js";
import type { ToolAdapter } from "./base.js";
import { writeFileAtomic, readJsonFile, backupFile } from "../util.js";

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  return parseToml(raw) as Record<string, unknown>; // throws on malformed → abort
}

/** normalized McpConfig → Codex TOML entry (headers → http_headers). */
function toEntry(cfg: McpConfig): Record<string, unknown> {
  const { headers, ...rest } = cfg;
  const e: Record<string, unknown> = { ...rest };
  if (headers) e.http_headers = headers;
  return e;
}

/** Codex TOML entry → normalized McpConfig (http_headers → headers). */
function fromEntry(row: Record<string, unknown>): McpConfig {
  const { http_headers, ...rest } = row;
  const c: McpConfig = { ...rest };
  if (http_headers) c.headers = http_headers as Record<string, string>;
  return c;
}

export class CodexAdapter implements ToolAdapter {
  readonly app: AppType = "codex";

  constructor(private readonly home: string = homedir()) {}

  private get homeConfig(): string {
    return join(this.home, ".codex", "config.toml");
  }

  mcpPath(scope: Scope): string {
    return scope.kind === "global"
      ? this.homeConfig
      : join(scope.projectDir, ".codex", "config.toml");
  }

  isPresent(scope: Scope): boolean {
    if (scope.kind === "project") return existsSync(scope.projectDir);
    return existsSync(join(this.home, ".codex"));
  }

  readMcp(filePath: string): EntryMap {
    const doc = readToml(filePath);
    const table = (doc.mcp_servers as Record<string, Record<string, unknown>> | undefined) ?? {};
    const out: EntryMap = {};
    for (const [name, row] of Object.entries(table)) out[name] = fromEntry(row);
    return out;
  }

  writeMcp(filePath: string, servers: EntryMap): void {
    const doc = readToml(filePath); // preserve foreign tables/keys (not comments)
    if (Object.keys(servers).length === 0) {
      delete doc.mcp_servers; // remove the empty table entirely
    } else {
      const table: Record<string, unknown> = {};
      for (const [name, cfg] of Object.entries(servers)) table[name] = toEntry(cfg);
      doc.mcp_servers = table;
    }
    writeFileAtomic(filePath, stringifyToml(doc));
  }

  skillsDir(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".codex", "skills")
      : join(scope.projectDir, ".codex", "skills");
  }

  promptPath(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".codex", "AGENTS.md")
      : join(scope.projectDir, "AGENTS.md");
  }

  /**
   * Apply a provider preset to Codex:
   *  - config.toml: top-level `model` + `model_provider`, and a
   *    `[model_providers.<id>]` table (base_url, env_key, wire_api,
   *    requires_openai_auth=false for gateways). Preserves other tables.
   *  - auth.json: the API key under OPENAI_API_KEY (Codex's credential store),
   *    which we point env_key at. Never logged.
   * Built-in IDs (openai/ollama/lmstudio) are reserved, so we suffix custom ones.
   */
  applyProvider(settings: ProviderSettings, providerId: string): ProviderApplyResult {
    const files: string[] = [];
    const notes: string[] = [];
    // Codex reserves these provider IDs; namespace ours to avoid collision.
    const reserved = new Set(["openai", "ollama", "lmstudio"]);
    const id = reserved.has(providerId) ? `${providerId}-custom` : providerId;
    const envKey = "OPENAI_API_KEY";

    // ── config.toml routing ──
    const cfgPath = this.homeConfig;
    const doc = readToml(cfgPath);
    if (settings.model) doc.model = settings.model;
    doc.model_provider = id;
    const providers = (doc.model_providers as Record<string, unknown> | undefined) ?? {};
    const entry: Record<string, unknown> = { ...((providers[id] as Record<string, unknown>) ?? {}) };
    entry.name = providerId;
    if (settings.baseUrl) entry.base_url = settings.baseUrl;
    entry.env_key = envKey;
    entry.wire_api = settings.wireApi ?? "chat";
    entry.requires_openai_auth = false;
    providers[id] = entry;
    doc.model_providers = providers;
    backupFile(cfgPath);
    writeFileAtomic(cfgPath, stringifyToml(doc));
    files.push(cfgPath);

    // ── auth.json secret ──
    if (settings.apiKey !== undefined) {
      const authPath = join(this.home, ".codex", "auth.json");
      const auth = readJsonFile(authPath);
      auth[envKey] = settings.apiKey;
      backupFile(authPath);
      writeFileAtomic(authPath, JSON.stringify(auth, null, 2) + "\n");
      files.push(authPath);
      notes.push(`key written to auth.json as ${envKey}; if your gateway needs it as a process env var, also export ${envKey}.`);
    }
    return { files, notes };
  }

  /** Record project trust in ~/.codex/config.toml (else project config is ignored). */
  prepareScope(scope: Scope): void {
    if (scope.kind !== "project") return;
    if (!existsSync(join(this.home, ".codex"))) return; // codex not installed → skip
    const abs = resolve(scope.projectDir);
    const doc = readToml(this.homeConfig);
    const projects = (doc.projects as Record<string, unknown> | undefined) ?? {};
    const entry = (projects[abs] as Record<string, unknown> | undefined) ?? {};
    if (entry.trust_level === "trusted") return; // already trusted, no churn
    projects[abs] = { ...entry, trust_level: "trusted" };
    doc.projects = projects;
    writeFileAtomic(this.homeConfig, stringifyToml(doc));
  }
}
