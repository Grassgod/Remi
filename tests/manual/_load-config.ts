/**
 * Shared config loader for manual tests — reads Feishu credentials from ConfigStore.
 */

export function loadConfig(chatIdOverride?: string): {
  appId: string;
  appSecret: string;
  domain: string;
  chatId: string;
  verificationToken: string;
  encryptKey: string;
} {
  const { ConfigStore } = require("@shared/db/config-store.js");
  const { getDb } = require("@shared/db/index.js");
  const store = new ConfigStore(getDb());
  const config = store.load();

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("Feishu credentials not found — run: remi login");
  }

  return {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain ?? "feishu",
    chatId: chatIdOverride || config.feishu.triggerUserIds?.[0] || "",
    verificationToken: config.feishu.verificationToken ?? "",
    encryptKey: config.feishu.encryptKey ?? "",
  };
}
