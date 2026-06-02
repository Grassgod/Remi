/**
 * Gemini CLI adapter.
 *
 * MCP config lives in settings.json under `mcpServers`:
 *   - global  → ~/.gemini/settings.json
 *   - project → <projectDir>/.gemini/settings.json
 *
 * Gemini itself merges global+workspace layers, so we just write each layer.
 * Field quirks vs the reference (Claude) shape: no `type` field (inferred),
 * HTTP transport uses `httpUrl` instead of `url`. Foreign keys preserved.
 * NOTE (Phase 1): timeout-field merging (startup/tool → single `timeout`) is
 * not yet implemented; such fields pass through verbatim.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AppType, EntryMap, McpConfig, Scope, ProviderSettings, ProviderApplyResult } from "../types.js";
import type { ToolAdapter } from "./base.js";
import { readJsonFile, writeFileAtomic, backupFile } from "../util.js";

/** Upsert KEY=value into dotenv text, preserving other lines and order. */
function upsertEnvLine(text: string, key: string, value: string): string {
  const lines = text.length ? text.split("\n") : [];
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (out.length && out[out.length - 1].trim() !== "") out.push(`${key}=${value}`);
    else if (out.length) out[out.length - 1] = `${key}=${value}`;
    else out.push(`${key}=${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** normalized McpConfig → Gemini entry (drop type; http url → httpUrl). */
function toEntry(cfg: McpConfig): Record<string, unknown> {
  const e: Record<string, unknown> = { ...cfg };
  delete e.type;
  if (cfg.type === "http" && cfg.url !== undefined) {
    e.httpUrl = cfg.url;
    delete e.url;
  }
  return e;
}

/** Gemini entry → normalized McpConfig (infer type; httpUrl → url). */
function fromEntry(row: Record<string, unknown>): McpConfig {
  const c: McpConfig = { ...row };
  if (row.httpUrl !== undefined) {
    c.type = "http";
    c.url = row.httpUrl as string;
    delete c.httpUrl;
  } else if (row.url !== undefined) {
    c.type = "sse";
  } else if (row.command !== undefined) {
    c.type = "stdio";
  }
  return c;
}

export class GeminiAdapter implements ToolAdapter {
  readonly app: AppType = "gemini";

  constructor(private readonly home: string = homedir()) {}

  mcpPath(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".gemini", "settings.json")
      : join(scope.projectDir, ".gemini", "settings.json");
  }

  isPresent(scope: Scope): boolean {
    if (scope.kind === "project") return existsSync(scope.projectDir);
    return existsSync(join(this.home, ".gemini"));
  }

  readMcp(filePath: string): EntryMap {
    const doc = readJsonFile(filePath);
    const servers = (doc.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {};
    const out: EntryMap = {};
    for (const [name, row] of Object.entries(servers)) out[name] = fromEntry(row);
    return out;
  }

  writeMcp(filePath: string, servers: EntryMap): void {
    const doc = readJsonFile(filePath); // preserve foreign keys
    const out: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(servers)) out[name] = toEntry(cfg);
    doc.mcpServers = out;
    writeFileAtomic(filePath, JSON.stringify(doc, null, 2) + "\n");
  }

  skillsDir(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".gemini", "skills")
      : join(scope.projectDir, ".gemini", "skills");
  }

  promptPath(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".gemini", "GEMINI.md")
      : join(scope.projectDir, "GEMINI.md");
  }

  /**
   * Gemini CLI auto-loads ~/.gemini/.env. We upsert GEMINI_API_KEY and
   * GOOGLE_GEMINI_BASE_URL (the most widely-honored base-url var; note the name
   * has varied across versions), preserving any other lines in the file.
   */
  applyProvider(settings: ProviderSettings): ProviderApplyResult {
    const path = join(this.home, ".gemini", ".env");
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (settings.apiKey !== undefined) text = upsertEnvLine(text, "GEMINI_API_KEY", settings.apiKey);
    if (settings.baseUrl !== undefined) text = upsertEnvLine(text, "GOOGLE_GEMINI_BASE_URL", settings.baseUrl);
    backupFile(path);
    writeFileAtomic(path, text);
    return {
      files: [path],
      notes: ["base-url var name varies by gemini-cli version; if unrecognized, try GEMINI_BASE_URL."],
    };
  }
}
