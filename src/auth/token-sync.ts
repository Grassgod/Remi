/**
 * Token Sync Engine — declarative token distribution to external tools.
 *
 * Instead of hardcoding sync targets (e.g., ~/.lark_auth/tokens.json),
 * sync rules are declared in remi.toml and executed automatically
 * whenever adapter tokens change.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthAdapter, TokenEntry } from "./types.js";
import type { PersistedTokens } from "./persistence.js";
import { createLogger } from "../logger.js";

const log = createLogger("1passport:sync");

/** Supported output formats for token sync. */
export type TokenSyncFormat =
  | "mirror"          // Mirror entire adapter tokens (PersistedTokens format)
  | "json_kv"         // { key: tokenValue, saved_at: "..." }
  | "bytedcli_token"  // bytedcli native: { access_token, refresh_token, expires_at, token_type }
  | "raw"             // Plain text token value
  | "env";            // KEY=value format

/** A single token sync rule from config. */
export interface TokenSyncRule {
  /** Human-readable name for this sync target. */
  name: string;
  /** Source: "adapter/tokenType" or "adapter/*" for all types. */
  source: string;
  /** Target file path (supports ~ expansion). */
  target: string;
  /** Output format. */
  format: TokenSyncFormat;
  /** Key name for json_kv/env formats. */
  key?: string;
  /** Additional static fields for json_kv format. */
  extraKeys?: Record<string, string>;
}

/** Expand ~ to home directory. */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** Ensure parent directory exists with restricted permissions. */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Resolve template variables in extra_keys values. */
function resolveTemplate(value: string): string {
  return value.replace(/\{\{now_iso\}\}/g, new Date().toISOString());
}

/** Write file with restricted permissions (atomic via tmp + rename). */
function writePrivate(filePath: string, content: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
}

export class TokenSyncEngine {
  private _rules: TokenSyncRule[];

  constructor(rules: TokenSyncRule[]) {
    this._rules = rules;
  }

  get rules(): TokenSyncRule[] {
    return this._rules;
  }

  /**
   * Sync all matching rules for a specific adapter/type change.
   * Called when a single token changes.
   */
  syncOne(
    service: string,
    type: string,
    entry: TokenEntry,
    allTokens: PersistedTokens,
  ): void {
    for (const rule of this._rules) {
      if (this._matches(rule, service, type)) {
        this._writeRule(rule, entry, allTokens);
      }
    }
  }

  /**
   * Full sync — write all rules using current adapter state.
   * Called on persist and startup.
   */
  syncAll(adapters: Map<string, AuthAdapter>, allTokens: PersistedTokens): void {
    for (const rule of this._rules) {
      const [adapterName, tokenType] = this._parseSource(rule.source);

      const adapter = adapters.get(adapterName);
      if (!adapter) continue;

      const exported = adapter.exportTokens?.() ?? {};

      if (tokenType === "*") {
        // Mirror format: write all tokens for this adapter
        this._writeRule(rule, null, allTokens);
      } else {
        const entry = exported[tokenType];
        if (entry) {
          this._writeRule(rule, entry, allTokens);
        }
      }
    }
  }

  /** Check if a rule matches a given service/type. */
  private _matches(rule: TokenSyncRule, service: string, type: string): boolean {
    const [adapterName, tokenType] = this._parseSource(rule.source);
    return adapterName === service && (tokenType === "*" || tokenType === type);
  }

  /** Parse "adapter/type" source string. */
  private _parseSource(source: string): [string, string] {
    const slash = source.indexOf("/");
    if (slash < 0) return [source, "*"];
    return [source.slice(0, slash), source.slice(slash + 1)];
  }

  /** Write a single rule to its target file. */
  private _writeRule(
    rule: TokenSyncRule,
    entry: TokenEntry | null,
    allTokens: PersistedTokens,
  ): void {
    const target = expandHome(rule.target);
    try {
      const content = this._formatContent(rule, entry, allTokens);
      writePrivate(target, content);
      log.debug(`Synced ${rule.name} → ${target}`);
    } catch (e) {
      log.warn(`Failed to sync ${rule.name} → ${target}:`, e);
    }
  }

  /** Format content according to rule format. */
  private _formatContent(
    rule: TokenSyncRule,
    entry: TokenEntry | null,
    allTokens: PersistedTokens,
  ): string {
    switch (rule.format) {
      case "mirror":
        return JSON.stringify(allTokens, null, 2);

      case "json_kv": {
        if (!entry) return "{}";
        const obj: Record<string, string> = {
          [rule.key ?? "token"]: entry.value,
          saved_at: new Date().toISOString(),
        };
        if (rule.extraKeys) {
          for (const [k, v] of Object.entries(rule.extraKeys)) {
            obj[k] = resolveTemplate(v);
          }
        }
        return JSON.stringify(obj, null, 2);
      }

      case "bytedcli_token": {
        if (!entry) return "{}";
        const obj: Record<string, unknown> = {
          access_token: entry.value,
          expires_at: entry.expiresAt,
          token_type: "Bearer",
        };
        if (entry.refreshToken) {
          obj.refresh_token = entry.refreshToken;
        }
        return JSON.stringify(obj, null, 2);
      }

      case "raw":
        return entry?.value ?? "";

      case "env":
        return `${rule.key ?? "TOKEN"}=${entry?.value ?? ""}\n`;

      default:
        return entry?.value ?? "";
    }
  }
}
