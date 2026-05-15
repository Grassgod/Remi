/**
 * CCSwitchClient — typed wrapper around cc-switch CLI.
 *
 * cc-switch is the read/write layer for multi-tool configuration
 * (Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw).
 * Remi calls it to manage skills, MCP servers, and providers
 * without knowing each tool's config format.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../logger.js";

const log = createLogger("cc-switch");

export type AppType = "claude" | "codex" | "gemini" | "open-code" | "open-claw";

export interface SkillInfo {
  name: string;
  directory: string;
  enabledApps: AppType[];
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  enabledApps: AppType[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  appType: AppType;
  isCurrent: boolean;
}

export class CCSwitchClient {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.CC_SWITCH_CONFIG_DIR ?? join(homedir(), ".remi", "cc-switch");
  }

  isAvailable(): boolean {
    try {
      const result = Bun.spawnSync(["cc-switch", "--version"], {
        env: { ...process.env, CC_SWITCH_CONFIG_DIR: this.configDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  get dbPath(): string {
    return join(this.configDir, "cc-switch.db");
  }

  get dbExists(): boolean {
    return existsSync(this.dbPath);
  }

  // ── Skills ────────────────────────────────────────────────────

  async skillsList(): Promise<string> {
    return this.exec(["skills", "list"]);
  }

  async skillsInstall(nameOrPath: string): Promise<string> {
    return this.exec(["skills", "install", nameOrPath]);
  }

  async skillsUninstall(name: string): Promise<string> {
    return this.exec(["skills", "uninstall", name]);
  }

  async skillsEnable(name: string, app: AppType): Promise<string> {
    return this.exec(["skills", "enable", name, "--app", app]);
  }

  async skillsDisable(name: string, app: AppType): Promise<string> {
    return this.exec(["skills", "disable", name, "--app", app]);
  }

  async skillsSync(): Promise<string> {
    return this.exec(["skills", "sync"]);
  }

  async skillsImportFromApps(...dirs: string[]): Promise<string> {
    return this.exec(["skills", "import-from-apps", ...dirs]);
  }

  async skillsDiscover(query?: string): Promise<string> {
    const args = ["skills", "discover"];
    if (query) args.push(query);
    return this.exec(args);
  }

  // ── MCP Servers ───────────────────────────────────────────────

  async mcpList(): Promise<string> {
    return this.exec(["mcp", "list"]);
  }

  async mcpAdd(
    name: string,
    opts: {
      command?: string;
      args?: string[];
      url?: string;
      transport?: "stdio" | "http" | "sse";
      env?: Record<string, string>;
    },
  ): Promise<string> {
    const cmdArgs = ["mcp", "add"];
    // cc-switch mcp add is interactive; for non-interactive, we'd need to
    // check if it supports --name/--command flags or pipe stdin.
    // For now, pass name as first positional arg.
    cmdArgs.push(name);
    if (opts.command) {
      cmdArgs.push("--command", opts.command);
    }
    if (opts.args) {
      cmdArgs.push("--args", opts.args.join(" "));
    }
    if (opts.url) {
      cmdArgs.push("--url", opts.url);
    }
    if (opts.transport) {
      cmdArgs.push("--transport", opts.transport);
    }
    return this.exec(cmdArgs);
  }

  async mcpDelete(id: string): Promise<string> {
    return this.exec(["mcp", "delete", id]);
  }

  async mcpEnable(id: string, app: AppType): Promise<string> {
    return this.exec(["mcp", "enable", id, "--app", app]);
  }

  async mcpDisable(id: string, app: AppType): Promise<string> {
    return this.exec(["mcp", "disable", id, "--app", app]);
  }

  async mcpSync(): Promise<string> {
    return this.exec(["mcp", "sync"]);
  }

  async mcpImport(app: AppType): Promise<string> {
    return this.exec(["mcp", "import", "--app", app]);
  }

  /**
   * Read MCP servers enabled for a given app directly from cc-switch.db.
   * Returns configs compatible with ACP's McpServerConfig protocol.
   */
  getMcpServersForApp(app: AppType = "claude"): Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }> {
    if (!this.dbExists) return [];
    try {
      const { Database } = require("bun:sqlite");
      const db = new Database(this.dbPath, { readonly: true });
      const col = `enabled_${app === "open-code" ? "opencode" : app === "open-claw" ? "hermes" : app}`;
      const rows = db.query(`SELECT id, name, server_config FROM mcp_servers WHERE ${col} = 1`).all() as Array<{
        id: string;
        name: string;
        server_config: string;
      }>;
      db.close();

      return rows.map((row) => {
        const cfg = JSON.parse(row.server_config);
        return {
          name: row.name,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        };
      });
    } catch (e: any) {
      log.warn(`failed to read MCP servers from cc-switch.db: ${e.message}`);
      return [];
    }
  }

  // ── Providers ─────────────────────────────────────────────────

  async providerList(app?: AppType): Promise<string> {
    const args = ["provider", "list"];
    if (app) args.push("--app", app);
    return this.exec(args);
  }

  async providerCurrent(app?: AppType): Promise<string> {
    const args = ["provider", "current"];
    if (app) args.push("--app", app);
    return this.exec(args);
  }

  async providerSwitch(id: string, app?: AppType): Promise<string> {
    const args = ["provider", "switch", id];
    if (app) args.push("--app", app);
    return this.exec(args);
  }

  // ── Config ────────────────────────────────────────────────────

  async configShow(): Promise<string> {
    return this.exec(["config", "show"]);
  }

  async configCommonSet(snippet: string, app?: AppType): Promise<string> {
    const args = ["config", "common", "set", "--snippet", snippet];
    if (app) args.push("--app", app);
    return this.exec(args);
  }

  async configBackup(): Promise<string> {
    return this.exec(["config", "backup"]);
  }

  // ── Internal ──────────────────────────────────────────────────

  private async exec(args: string[]): Promise<string> {
    const env = { ...process.env, CC_SWITCH_CONFIG_DIR: this.configDir };
    log.debug(`exec: cc-switch ${args.join(" ")}`);

    const proc = Bun.spawn(["cc-switch", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const msg = `cc-switch ${args[0]} failed (exit ${exitCode}): ${stderr || stdout}`;
      log.error(msg);
      throw new Error(msg);
    }

    if (stderr) log.debug(`stderr: ${stderr.trim()}`);
    return stdout.trim();
  }
}

export const ccSwitch = new CCSwitchClient();
