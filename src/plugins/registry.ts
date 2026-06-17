/**
 * Plugin registry + loader.
 *
 * Discovers plugins from two sources and dispatches their lifecycle hooks to
 * the three host surfaces (core boot / web / cli):
 *
 *  1. IN-TREE (config table): plugins that ship inside this repo and compile
 *     into the single-file bundle. Added via the static IN_TREE map below
 *     (static import → bun build can analyze + bundle them). In-tree plugins
 *     are enabled by default (they were compiled in deliberately).
 *
 *  2. EXTERNAL (directory scan): drop-in plugins under ~/.remi/plugins/<id>/,
 *     each with a plugin.json manifest. Loaded at runtime via require() of a
 *     RUNTIME-COMPUTED ABSOLUTE PATH so bun build does NOT inline them — the
 *     release bundle loads them from disk. External plugins are OPT-IN: they
 *     load only when explicitly enabled (manifest `enabled: true`, an entry in
 *     [plugins].enabled, or [plugin.<id>].enabled = true). Merely dropping a
 *     directory is not enough — and each external require() is logged.
 *
 * Plugins never import the Remi runtime; everything they need is injected via
 * the context objects defined in @remi/plugin-sdk.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Plugin,
  PluginManifest,
  PluginCoreContext,
  PluginWebContext,
  CliRegister,
  AuthStoreLike,
  HttpApp,
} from "@remi/plugin-sdk";
import type { RemiConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("plugins");

/**
 * In-tree plugin factories. Adding a generic, open-source in-tree plugin = add
 * ONE line here (static import keeps it bundle-safe). Private/internal plugins
 * should NOT go here — they belong in ~/.remi/plugins/ as external plugins.
 */
const IN_TREE: Record<string, () => Plugin> = {
  // "example": () => { const { ExamplePlugin } = require("./example/plugin.js"); return new ExamplePlugin(); },
};

/**
 * Resolve whether a plugin id should be loaded.
 * - `pluginConfigs[id].enabled === false` is an explicit kill switch (wins).
 * - allowlist ([plugins].enabled) / per-plugin / manifest `enabled: true` are
 *   explicit opt-ins.
 * - With NO explicit signal: in-tree defaults ON, external defaults OFF (opt-in).
 */
function resolveEnabled(
  id: string,
  manifestEnabled: boolean | undefined,
  config: RemiConfig,
  isExternal: boolean,
): boolean {
  const pc = config.pluginConfigs[id];
  if (pc && pc.enabled === false) return false; // explicit kill switch
  if (config.plugins.enabled.includes(id)) return true; // allowlist opt-in
  if (pc && pc.enabled === true) return true; // per-plugin opt-in
  if (manifestEnabled === true) return true; // manifest explicit opt-in
  // No explicit signal: in-tree on, external requires opt-in.
  return !isExternal && manifestEnabled !== false;
}

export class PluginRegistry {
  private _plugins: Plugin[] = [];
  private _loaded = false;

  /** All successfully loaded plugins (in load order). */
  get all(): readonly Plugin[] {
    return this._plugins;
  }

  /**
   * Discover + instantiate all enabled plugins. Synchronous (require-based) so
   * it can run inside the synchronous Remi.boot(). Idempotent per instance.
   */
  load(config: RemiConfig): this {
    if (this._loaded) return this;
    this._loaded = true;
    const seen = new Set<string>();
    this._loadInTree(config, seen);
    this._loadExternal(config, seen);
    if (this._plugins.length > 0) {
      log.info(`Plugins loaded: ${this._plugins.map((p) => p.manifest.id).join(", ")}`);
    }
    return this;
  }

  private _loadInTree(config: RemiConfig, seen: Set<string>): void {
    for (const [id, make] of Object.entries(IN_TREE)) {
      try {
        const plugin = make();
        if (!resolveEnabled(id, plugin.manifest.enabled, config, false)) continue;
        if (seen.has(id)) {
          log.warn(`Duplicate plugin id "${id}" (in-tree), skipped`);
          continue;
        }
        seen.add(id);
        this._plugins.push(plugin);
      } catch (e) {
        log.warn(`In-tree plugin ${id} failed to load:`, e);
      }
    }
  }

  private _loadExternal(config: RemiConfig, seen: Set<string>): void {
    if (!config.plugins.allowExternal) return;
    const dir = config.plugins.dir;
    if (!existsSync(dir)) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log.warn(`Cannot scan plugin dir ${dir}:`, e);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(dir, entry.name);
      const manifestPath = join(pluginDir, "plugin.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
        if (!manifest.id || !manifest.main) {
          log.warn(`External plugin ${entry.name}: manifest missing id/main, skipped`);
          continue;
        }
        if (seen.has(manifest.id) || manifest.id in IN_TREE) {
          log.warn(`External plugin ${manifest.id} collides with an existing plugin id, skipped`);
          continue;
        }
        if (!resolveEnabled(manifest.id, manifest.enabled, config, true)) {
          log.info(`External plugin ${manifest.id} not enabled, skipped`);
          continue;
        }
        // Runtime-computed absolute path → bun build does NOT inline this; the
        // release bundle loads the external file from disk. Audit the execution.
        const entryPath = resolve(pluginDir, manifest.main);
        log.warn(`Executing external plugin code: ${manifest.id} → ${entryPath}`);
        const mod = require(entryPath);
        const plugin: Plugin | undefined =
          mod?.default ?? mod?.plugin ?? (mod?.manifest ? mod : undefined);
        if (!plugin || !plugin.manifest) {
          log.warn(`External plugin ${manifest.id}: entry has no default/plugin export, skipped`);
          continue;
        }
        seen.add(manifest.id);
        this._plugins.push(plugin);
        log.info(`Loaded external plugin: ${manifest.id}@${manifest.version} (${pluginDir})`);
      } catch (e) {
        log.warn(`External plugin ${entry.name} failed to load:`, e);
      }
    }
  }

  private _configFor(plugin: Plugin, config: RemiConfig): Record<string, unknown> {
    return config.pluginConfigs[plugin.manifest.id] ?? {};
  }

  // ── Host-surface dispatchers ───────────────────────────────────────────────

  /** CORE/BOOT surface — register auth adapters. */
  dispatchCore(base: { authStore: AuthStoreLike; config: RemiConfig }): void {
    for (const p of this._plugins) {
      if (!p.registerCore) continue;
      try {
        const ctx: PluginCoreContext = {
          authStore: base.authStore,
          config: base.config,
          pluginConfig: this._configFor(p, base.config),
        };
        if (p.isApplicable && !p.isApplicable(ctx)) {
          log.info(`Plugin ${p.manifest.id} core hook skipped (not applicable)`);
          continue;
        }
        p.registerCore(ctx);
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} registerCore failed:`, e);
      }
    }
  }

  /**
   * WEB surface — two passes so ALL plugin middleware mounts before ANY plugin
   * route (Hono applies middleware only to routes registered after it).
   */
  dispatchWeb(app: HttpApp, base: { db: PluginWebContext["db"]; config: RemiConfig }): void {
    // Pass 1: migrations, seed, and middleware.
    for (const p of this._plugins) {
      try {
        p.migrate?.(base.db);
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} migrate failed:`, e);
      }
      try {
        p.seed?.();
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} seed failed:`, e);
      }
      try {
        if (p.middleware) app.use("/api/*", p.middleware());
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} middleware failed:`, e);
      }
    }
    // Pass 2: routes (after every plugin's middleware is mounted).
    for (const p of this._plugins) {
      if (!p.registerHttp) continue;
      try {
        const ctx: PluginWebContext = {
          db: base.db,
          config: base.config,
          pluginConfig: this._configFor(p, base.config),
        };
        p.registerHttp(app, ctx);
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} registerHttp failed:`, e);
      }
    }
  }

  /** CLI surface — contribute subcommands via the host register(). */
  dispatchCli(register: CliRegister): void {
    for (const p of this._plugins) {
      if (!p.registerCli) continue;
      try {
        p.registerCli(register);
      } catch (e) {
        log.warn(`Plugin ${p.manifest.id} registerCli failed:`, e);
      }
    }
  }
}
