/**
 * @remi/plugin-sdk — contract types + helpers for building Remi plugins.
 *
 * Design principle: plugins NEVER import the Remi runtime. They receive
 * everything they need via injected context objects, and depend on this SDK
 * for TYPES ONLY (erased at compile time). This lets an external plugin
 * compile and ship independently of the Remi single-file bundle, then be
 * dropped into ~/.remi/plugins/ and loaded at runtime.
 *
 * The SDK is intentionally dependency-free (only the bun built-in sqlite type
 * + structural shapes) so external plugins can depend on it cheaply.
 */
import type { Database } from "bun:sqlite";

/** Host surfaces a plugin may contribute to (declarative; for docs/admin UI). */
export type PluginCapability = "core" | "http" | "middleware" | "cli";

/** Plugin manifest — the Claude Code .claude-plugin/plugin.json analog. */
export interface PluginManifest {
  /** Stable plugin id, also the external plugin directory name. e.g. "bytedance-passport". */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  capabilities: PluginCapability[];
  /** Entry file relative to the plugin dir (external plugins). e.g. "dist/index.js". */
  main?: string;
  /**
   * Enable state. EXTERNAL plugins are opt-in: they load only when `enabled: true`
   * here, or the id is in [plugins].enabled, or [plugin.<id>].enabled = true.
   * IN-TREE plugins default enabled unless `enabled: false`. A `[plugin.<id>].enabled
   * = false` in config is an explicit kill switch that overrides this.
   */
  enabled?: boolean;
  /** Compatibility hints — e.g. the SDK semver range this plugin was built against. */
  engines?: { remiSdk?: string };
}

// ── Injected auth contract (structural mirror of src/auth/types.ts) ──────────
export interface TokenEntry {
  value: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}
export interface TokenStatus {
  service: string;
  type: string;
  valid: boolean;
  expiresAt: number;
  refreshable: boolean;
}
/** An auth adapter the host's AuthStore can manage. Matches src/auth/types.ts AuthAdapter. */
export interface AuthAdapterLike {
  readonly service: string;
  getToken(type?: string): Promise<string>;
  checkAndRefresh(): Promise<void>;
  status(): TokenStatus[];
  restoreTokens?(tokens: Record<string, TokenEntry>): void;
  exportTokens?(): Record<string, TokenEntry>;
  onTokenChange?(cb: () => void): void;
}
/** The host's AuthStore, as seen by a plugin (registration only). */
export interface AuthStoreLike {
  registerAdapter(adapter: AuthAdapterLike): void;
}

// ── Injected web contract (structural — avoids a hard hono dependency) ───────
/** Minimal Hono-app shape for plugin HTTP route registration. A real Hono app satisfies this. */
export interface HttpApp {
  use(path: string, ...handlers: unknown[]): unknown;
  get(path: string, ...handlers: unknown[]): unknown;
  post(path: string, ...handlers: unknown[]): unknown;
  put(path: string, ...handlers: unknown[]): unknown;
  delete(path: string, ...handlers: unknown[]): unknown;
  patch(path: string, ...handlers: unknown[]): unknown;
}
export type Middleware = (c: unknown, next: () => Promise<void>) => unknown | Promise<unknown>;

// ── Contexts injected into hooks ─────────────────────────────────────────────
export interface PluginCoreContext {
  authStore: AuthStoreLike;
  /** The full RemiConfig (opaque to plugins — read your own pluginConfig instead). */
  config: unknown;
  /** This plugin's [plugin.<id>] sub-table from remi.toml. */
  pluginConfig: Record<string, unknown>;
}
export interface PluginWebContext {
  db: Database;
  config: unknown;
  pluginConfig: Record<string, unknown>;
}
/** The host's CLI command registrar. Matches src/cli/index.ts register(). */
export type CliRegister = (
  name: string,
  description: string,
  loader: () => Promise<{ run: (args: string[]) => Promise<void> }>,
  hidden?: boolean,
) => void;

/**
 * The plugin contract. ALL capability hooks are optional — a plugin implements
 * only the surfaces it touches. The host registry calls whatever is present.
 *
 * Plugins should be STATELESS across surfaces: the host may instantiate a plugin
 * once per surface (core / web / cli run in separate processes), so do not rely
 * on instance state set in one hook being visible in another.
 */
export interface Plugin {
  readonly manifest: PluginManifest;

  /** CORE/BOOT surface — register an auth adapter with the host AuthStore. */
  registerCore?(ctx: PluginCoreContext): void;

  /** WEB surface — idempotent DB migrations. */
  migrate?(db: Database): void;
  /** WEB surface — idempotent bootstrap after migrate. */
  seed?(): void;
  /** WEB surface — mount HTTP routes. */
  registerHttp?(app: HttpApp, ctx: PluginWebContext): void;
  /** WEB surface — composable HTTP middleware. */
  middleware?(): Middleware;

  /** CLI surface — contribute subcommands via the host register(). */
  registerCli?(register: CliRegister): void;

  /**
   * Self-gate: return false to opt out even when enabled in config
   * (e.g. required credentials missing). Default behavior: applicable.
   */
  isApplicable?(ctx: PluginCoreContext): boolean;
}

/** Identity helper that gives external plugin authors type-checking on their object. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
