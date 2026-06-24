/**
 * ConfigHubPlugin — internal Remi plugin (SsoPlugin-style: static, in-tree,
 * manually wired in web/server.ts). Owns the cross-tool config DB stack and a
 * registry of per-tool adapters analogous to SSO's provider registry.
 *
 * Lifecycle:
 *   const hub = new ConfigHubPlugin();
 *   hub.migrate(getDb());     // creates Remi-side tables + opens config-hub.db
 *   hub.registerHttp(app);    // mounts /api/v1/config-hub/*
 *
 * To extend with another tool later:
 *   hub.registry.register(new MyToolAdapter());
 */

import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { AdapterRegistry, type ToolAdapter } from "./adapters/base.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { openConfigHubDb, defaultConfigHubDbPath, defaultSkillsSsotDir } from "./db/config-hub-db.js";
import { migrateConfigHub } from "./db/main-tables.js";
import { GlobalMcpDao, SqliteManifestStore, SkillsDao } from "./db/dao.js";
import { ConfigHubService } from "../mcp/persistent.js";
import { SkillsService } from "../skills/persistent.js";
import { PromptsService } from "../prompts/persistent.js";
import { ProvidersService } from "./providers-service.js";
import { registerHttp } from "./http.js";

export interface ConfigHubOptions {
  /** Override path to the config-hub DB (defaults to ~/.remi/config-hub.db). */
  configHubDbPath?: string;
  /** Skip auto-registering claude/codex/gemini adapters. */
  registerBuiltins?: boolean;
}

export class ConfigHubPlugin {
  readonly registry = new AdapterRegistry();
  private _service: ConfigHubService | null = null;
  private _skills: SkillsService | null = null;
  private _prompts: PromptsService | null = null;
  private _providers: ProvidersService | null = null;
  private _ccDb: Database | null = null;

  constructor(private readonly opts: ConfigHubOptions = {}) {
    if (opts.registerBuiltins !== false) {
      this.registry.register(new ClaudeAdapter());
      this.registry.register(new CodexAdapter());
      this.registry.register(new GeminiAdapter());
    }
  }

  /** Register an additional tool adapter (extension point for future tools). */
  registerAdapter(adapter: ToolAdapter): this {
    this.registry.register(adapter);
    return this;
  }

  /**
   * Create / open both DB layers. `mainDb` is Remi's main SQLite (where project
   * overlay + manifest live); the global config-hub.db is opened separately.
   */
  migrate(mainDb: Database): void {
    migrateConfigHub(mainDb);
    this._ccDb = openConfigHubDb(this.opts.configHubDbPath ?? defaultConfigHubDbPath());
    const manifests = new SqliteManifestStore(mainDb);
    this._service = new ConfigHubService(new GlobalMcpDao(this._ccDb), manifests, this.registry);
    this._skills = new SkillsService(new SkillsDao(this._ccDb), this.registry, defaultSkillsSsotDir());
    this._prompts = new PromptsService(this._ccDb, this.registry, manifests);
    this._providers = new ProvidersService(this._ccDb, this.registry);
  }

  get service(): ConfigHubService {
    if (!this._service) throw new Error("ConfigHubPlugin.migrate() must run before use");
    return this._service;
  }

  get skills(): SkillsService {
    if (!this._skills) throw new Error("ConfigHubPlugin.migrate() must run before use");
    return this._skills;
  }

  get prompts(): PromptsService {
    if (!this._prompts) throw new Error("ConfigHubPlugin.migrate() must run before use");
    return this._prompts;
  }

  get providers(): ProvidersService {
    if (!this._providers) throw new Error("ConfigHubPlugin.migrate() must run before use");
    return this._providers;
  }

  registerHttp(app: Hono): void {
    registerHttp(app, this.service, this.skills, this.prompts, this.providers);
  }
}

/** Module-level singleton for parts of Remi that need ad-hoc access (e.g. core.ts). */
let _instance: ConfigHubPlugin | null = null;

export function setConfigHubInstance(p: ConfigHubPlugin): void {
  _instance = p;
}

export function getConfigHub(): ConfigHubPlugin | null {
  return _instance;
}

export { ConfigHubService } from "../mcp/persistent.js";
