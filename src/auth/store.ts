/**
 * AuthStore — unified token management hub.
 *
 * Adapters register themselves; AuthStore provides a single getToken() entry point.
 * Tokens are persisted to ~/.remi/auth/tokens.json.
 */

import { join } from "node:path";
import type { AuthAdapter, TokenEntry, TokenStatus } from "./types.js";
import { TokenPersistence } from "./persistence.js";
import { createLogger } from "../logger.js";

const log = createLogger("1passport");

export class AuthStore {
  private _adapters = new Map<string, AuthAdapter>();
  private _persistence: TokenPersistence;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(authDir: string) {
    this._persistence = new TokenPersistence(join(authDir, "tokens.json"));
  }

  /** Register an adapter and restore its persisted tokens. */
  registerAdapter(adapter: AuthAdapter): void {
    this._adapters.set(adapter.service, adapter);

    // Restore persisted tokens
    const all = this._persistence.load();
    const saved = all[adapter.service];
    if (saved && adapter.restoreTokens) {
      adapter.restoreTokens(saved);
      log.info(`Restored persisted tokens for ${adapter.service}`);
    }

    // Wire up persistence callback
    if (adapter.onTokenChange) {
      adapter.onTokenChange(() => this._schedulePersist());
    }

    log.info(`Registered adapter: ${adapter.service}`);
  }

  /** Get a valid token. The adapter handles caching and refresh internally. */
  async getToken(service: string, type?: string): Promise<string> {
    const adapter = this._adapters.get(service);
    if (!adapter) {
      throw new Error(`[1passport] No adapter registered for service: ${service}`);
    }
    return adapter.getToken(type);
  }

  /** Proactively check and refresh all tokens (called by Scheduler heartbeat). */
  async checkAndRefreshAll(): Promise<void> {
    // Reload tokens from disk (picks up tokens written externally, e.g. by `auth` CLI)
    this._reloadFromDisk();

    for (const [service, adapter] of this._adapters) {
      try {
        await adapter.checkAndRefresh();
      } catch (e) {
        log.error(`${service} check/refresh failed:`, e);
      }
    }
    this._persistNow();
  }

  /** Get status of all managed tokens. */
  status(): TokenStatus[] {
    const result: TokenStatus[] = [];
    for (const adapter of this._adapters.values()) {
      result.push(...adapter.status());
    }
    return result;
  }

  /** Debounced persist (2s delay). */
  private _schedulePersist(): void {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, 2000);
    if (typeof this._persistTimer.unref === "function") {
      this._persistTimer.unref();
    }
  }

  /** Reload tokens from disk into adapters (picks up external writes). */
  private _reloadFromDisk(): void {
    const all = this._persistence.load();
    for (const [service, adapter] of this._adapters) {
      const saved = all[service];
      if (saved && adapter.restoreTokens) {
        adapter.restoreTokens(saved);
      }
    }
  }

  /** Immediately persist all tokens to disk, merging with existing data. */
  private _persistNow(): void {
    // Merge with existing disk data to avoid overwriting tokens from external tools
    const existing = this._persistence.load();
    for (const [service, adapter] of this._adapters) {
      if (adapter.exportTokens) {
        const exported = adapter.exportTokens();
        existing[service] = { ...existing[service], ...exported };
      }
    }
    try {
      this._persistence.save(existing);
      log.debug("Tokens persisted to disk");
    } catch (e) {
      log.warn("Failed to persist tokens:", e);
    }
  }
}
