/**
 * Claude Code adapter.
 *
 * MCP config lives in:
 *   - global  → ~/.claude.json  (top-level `mcpServers`, = user scope)
 *   - project → <projectDir>/.mcp.json  (`mcpServers`, = project scope)
 *
 * Claude's native shape is our reference format (command/args/env, or
 * type+url+headers for http/sse), so normalized McpConfig maps 1:1.
 * Every write preserves all other keys in the file.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AppType, EntryMap, McpConfig, Scope, ProviderSettings, ProviderApplyResult } from "../types.js";
import type { ToolAdapter } from "./base.js";
import { readJsonFile, writeFileAtomic, backupFile } from "../util.js";

export class ClaudeAdapter implements ToolAdapter {
  readonly app: AppType = "claude";

  constructor(private readonly home: string = homedir()) {}

  mcpPath(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".claude.json")
      : join(scope.projectDir, ".mcp.json");
  }

  isPresent(scope: Scope): boolean {
    if (scope.kind === "project") return existsSync(scope.projectDir);
    return (
      existsSync(join(this.home, ".claude")) ||
      existsSync(join(this.home, ".claude.json"))
    );
  }

  readMcp(filePath: string): EntryMap {
    const doc = readJsonFile(filePath);
    const servers = (doc.mcpServers as Record<string, McpConfig> | undefined) ?? {};
    const out: EntryMap = {};
    for (const [name, cfg] of Object.entries(servers)) out[name] = cfg;
    return out;
  }

  writeMcp(filePath: string, servers: EntryMap): void {
    const doc = readJsonFile(filePath); // preserve foreign keys
    doc.mcpServers = servers;
    writeFileAtomic(filePath, JSON.stringify(doc, null, 2) + "\n");
  }

  skillsDir(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".claude", "skills")
      : join(scope.projectDir, ".claude", "skills");
  }

  promptPath(scope: Scope): string {
    return scope.kind === "global"
      ? join(this.home, ".claude", "CLAUDE.md")
      : join(scope.projectDir, "CLAUDE.md");
  }

  /**
   * Claude Code reads provider credentials from ~/.claude/settings.json `env`.
   * We merge ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL, leaving
   * all other settings keys and env vars untouched.
   */
  applyProvider(settings: ProviderSettings): ProviderApplyResult {
    const path = join(this.home, ".claude", "settings.json");
    const doc = readJsonFile(path);
    const env = { ...((doc.env as Record<string, string> | undefined) ?? {}) };
    if (settings.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = settings.baseUrl;
    if (settings.apiKey !== undefined) env.ANTHROPIC_AUTH_TOKEN = settings.apiKey;
    if (settings.model) env.ANTHROPIC_MODEL = settings.model;
    doc.env = env;
    backupFile(path);
    writeFileAtomic(path, JSON.stringify(doc, null, 2) + "\n");
    return { files: [path] };
  }
}
