/**
 * RemiData — Config (backed by SQLite via ConfigStore).
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { ConfigStore } from "@shared/db/config-store.js";
import { RemiDataContext } from "./context.js";

export class ConfigData {
  constructor(private readonly ctx: RemiDataContext) {}

  readConfig(): Record<string, any> {
    const config = this.ctx._getConfigStore().load() as Record<string, any>;
    // Redact secrets
    if (config.feishu) {
      const redacted = { ...config.feishu };
      if (redacted.appSecret) redacted.appSecret = "***";
      if (redacted.encryptKey) redacted.encryptKey = "***";
      if (redacted.verificationToken) redacted.verificationToken = "***";
      if (redacted.userAccessToken) redacted.userAccessToken = "***";
      config.feishu = redacted;
    }
    return config;
  }

  updateConfig(patch: Record<string, any>): boolean {
    try {
      const store = this.ctx._getConfigStore();
      for (const [section, value] of Object.entries(patch)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const existing = (store.getSection(section) ?? {}) as Record<string, unknown>;
          store.setSection(section, { ...existing, ...value });
        } else {
          store.setSection(section, value);
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
