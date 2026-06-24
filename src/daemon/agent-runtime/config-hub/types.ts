/**
 * config-hub shared types.
 *
 * Phase 1 covers MCP server management across Claude Code, Codex, Gemini.
 * The engine is tool-agnostic: a normalized `McpConfig` is stored in the DB
 * and each adapter translates it to/from that tool's native config format.
 */

export type AppType = "claude" | "codex" | "gemini";

export const APP_TYPES: readonly AppType[] = ["claude", "codex", "gemini"] as const;

/** Scope of a config entry: machine-global, or local to one Remi project. */
export type Scope = { kind: "global" } | { kind: "project"; projectDir: string };

/**
 * Normalized, tool-agnostic MCP server config (what lands in config-hub.db's
 * `server_config` JSON). Adapters map this to/from native formats.
 */
export interface McpConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Extra tool-neutral fields (timeouts, cwd, …) preserved verbatim. */
  [k: string]: unknown;
}

/** Managed MCP entries keyed by server name. */
export type EntryMap = Record<string, McpConfig>;

/**
 * Last-synced manifest: server name → canonical hash of what the hub last
 * wrote into a given (tool, scope) file. Used as the `base` in 3-way
 * reconciliation so external edits are detected instead of clobbered.
 */
export type Manifest = Record<string, string>;

/**
 * Normalized provider preset (what's stored in config-hub.db `providers.settings_config`).
 * Each adapter maps it onto that tool's native auth/config files.
 */
export interface ProviderSettings {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Codex wire protocol: "chat" (most gateways) or "responses" (OpenAI/Azure). */
  wireApi?: "chat" | "responses";
}

/** What an adapter actually wrote when applying a provider (for UI feedback). */
export interface ProviderApplyResult {
  files: string[];
  notes?: string[];
}

/** Outcome of reconciling one (tool, scope) file. All fields are advisory to the caller. */
export interface ReconcileResult {
  /** The complete managed set the adapter should write into the file. */
  toFile: EntryMap;
  /** Servers to upsert into the DB and mark enabled for this tool (file-wins). */
  imports: EntryMap;
  /** Server names the user removed from the file → set enabled_<tool> = 0. */
  disables: string[];
  /** Server names where both DB and file changed since last sync → left untouched, needs human resolution. */
  conflicts: string[];
  /** Manifest to persist after the file is written. */
  nextManifest: Manifest;
}
