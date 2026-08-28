/**
 * Shared config loader for manual tests — reads Feishu credentials from env.
 */

export function loadConfig(chatIdOverride?: string): {
  appId: string;
  appSecret: string;
  domain: string;
  chatId: string;
  verificationToken: string;
  encryptKey: string;
} {
  const { loadConfig: loadRemiConfig } = require("@shared/config.js");
  const config = loadRemiConfig();

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("Feishu credentials not found — set FEISHU_APP_ID and FEISHU_APP_SECRET");
  }

  return {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain ?? "feishu",
    chatId: chatIdOverride || process.env.FEISHU_TEST_CHAT_ID || "",
    verificationToken: config.feishu.verificationToken ?? "",
    encryptKey: config.feishu.encryptKey ?? "",
  };
}
