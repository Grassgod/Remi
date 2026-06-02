/**
 * ToolAdapter — per-tool translation of normalized MCP config to/from a
 * tool's native config file. Registered into AdapterRegistry, mirroring the
 * SSO plugin's provider registry so new tools are additive.
 */

import type { AppType, EntryMap, Scope, ProviderSettings, ProviderApplyResult } from "../types.js";

export interface ToolAdapter {
  readonly app: AppType;

  /** Absolute path to the file holding this tool's MCP config for `scope`. */
  mcpPath(scope: Scope): string;

  /** Read managed MCP entries (name → normalized config). Missing file → {}. Malformed → throws. */
  readMcp(filePath: string): EntryMap;

  /**
   * Write the COMPLETE managed MCP set into the file, preserving all foreign
   * content (other keys, comments). Atomic. Empty set clears only our section.
   */
  writeMcp(filePath: string, servers: EntryMap): void;

  /** Whether the tool is present for this scope (skip sync if not, never create global dirs). */
  isPresent(scope: Scope): boolean;

  /**
   * Optional per-scope setup the orchestrator runs before writing.
   * Codex uses it to record project trust in ~/.codex/config.toml, without
   * which a project-scoped config is ignored.
   */
  prepareScope?(scope: Scope): void;

  /** Where this tool reads skills from (for the given scope). Null if unsupported. */
  skillsDir?(scope: Scope): string | null;

  /** Where this tool reads its prompt file (e.g. CLAUDE.md / AGENTS.md). Null if unsupported. */
  promptPath?(scope: Scope): string | null;

  /**
   * Apply a provider preset (base URL / api key / model) to this tool's native
   * auth+config files. Read-merge-atomic-write, preserving foreign content, with
   * a backup. Returns which files were written. Null if the tool has no provider
   * concept here.
   */
  applyProvider?(settings: ProviderSettings, providerId: string): ProviderApplyResult | null;
}

export class AdapterRegistry {
  private readonly map = new Map<AppType, ToolAdapter>();

  register(adapter: ToolAdapter): this {
    this.map.set(adapter.app, adapter);
    return this;
  }

  get(app: AppType): ToolAdapter | undefined {
    return this.map.get(app);
  }

  all(): ToolAdapter[] {
    return [...this.map.values()];
  }
}
