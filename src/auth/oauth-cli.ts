/**
 * CLI command: `bun run src/main.ts auth`
 *
 * Performs Feishu OAuth (v2) to obtain a user_access_token + refresh_token,
 * then persists it to ~/.remi/auth/tokens.json.
 * Uses offline_access scope to get refresh_token via v2 API,
 * independent of the platform "允许刷新 user_access_token" toggle.
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.js";
import { TokenPersistence, type PersistedTokens } from "./persistence.js";
import type { TokenEntry } from "./types.js";

const REDIRECT_URI = "http://localhost:9000/auth/callback";
const AUTH_DIR = join(homedir(), ".remi", "auth");

function resolveApiBase(domain?: string): string {
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

async function exchangeCode(
  apiBase: string,
  appId: string,
  appSecret: string,
  code: string,
): Promise<TokenEntry> {
  // v2 OAuth token endpoint — uses client credentials directly (no tenant_token needed)
  const resp = await fetch(`${apiBase}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const result = (await resp.json()) as {
    code?: number;
    error?: string;
    error_description?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };

  // v2 can return Feishu-style {code} or standard OAuth {error}
  if (result.error) {
    throw new Error(`换取 user_access_token 失败: ${result.error_description ?? result.error}`);
  }
  if (result.code && result.code !== 0) {
    throw new Error(`换取 user_access_token 失败: code ${result.code}`);
  }
  if (!result.access_token) {
    throw new Error("换取 user_access_token 失败: 未返回 access_token");
  }

  const entry: TokenEntry = {
    value: result.access_token,
    expiresAt: Date.now() + (result.expires_in ?? 7200) * 1000 - 5 * 60 * 1000,
  };

  if (result.refresh_token) {
    entry.refreshToken = result.refresh_token;
    entry.refreshExpiresAt =
      Date.now() + (result.refresh_token_expires_in ?? 2592000) * 1000;
  }

  return entry;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runAuth(): Promise<void> {
  const config = loadConfig();
  const { appId, appSecret, domain } = config.feishu;

  if (!appId || !appSecret) {
    console.error("❌ 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请检查 remi.toml 或环境变量。");
    process.exit(1);
  }

  const apiBase = resolveApiBase(domain);

  // Step 1: Build auth URL (v2 uses client_id + offline_access for refresh_token)
  const authUrl =
    `${apiBase}/authen/v1/authorize?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&state=remi_auth` +
    `&scope=offline_access`;

  console.log("\n📋 请在浏览器中打开以下链接完成授权：\n");
  console.log(`   ${authUrl}\n`);
  console.log("授权后浏览器会跳转到一个无法访问的页面，这是正常的。");
  console.log("请从浏览器地址栏复制 code 参数的值。\n");
  console.log("例如 URL 为: http://localhost:9000/auth/callback?code=abc123&state=remi_auth");
  console.log("则粘贴: abc123\n");

  // Step 2: Read code from user
  const input = await prompt("请粘贴 code（或完整回调 URL）: ");
  if (!input) {
    console.error("❌ 未输入 code。");
    process.exit(1);
  }

  // Support pasting full URL or just the code
  let code = input;
  try {
    const url = new URL(input);
    code = url.searchParams.get("code") ?? input;
  } catch {
    // Not a URL, treat as raw code
  }

  // Step 3: Exchange code for user token (v2 — no tenant_token needed)
  console.log("\n⏳ 换取 user_access_token...");
  const userEntry = await exchangeCode(apiBase, appId, appSecret, code);
  console.log("✅ user_access_token 获取成功");

  // Step 5: Persist to tokens.json
  const persistence = new TokenPersistence(join(AUTH_DIR, "tokens.json"));
  const existing: PersistedTokens = persistence.load();

  if (!existing.feishu) existing.feishu = {};
  existing.feishu.user = userEntry;

  persistence.save(existing);

  const expiresIn = Math.round((userEntry.expiresAt - Date.now()) / 1000);

  console.log("\n🎉 授权完成！Token 已保存到 ~/.remi/auth/tokens.json\n");
  console.log(`   access_token  有效期: ${expiresIn}s (~${(expiresIn / 3600).toFixed(1)}h)`);

  if (userEntry.refreshToken) {
    const refreshDays = Math.round(((userEntry.refreshExpiresAt ?? 0) - Date.now()) / 86400000);
    console.log(`   refresh_token 有效期: ~${refreshDays} 天`);
    console.log("\n   重启 Remi daemon 后自动生效，后续 token 会自动续期。\n");
  } else {
    console.log("   refresh_token: 未返回（内部飞书可能不支持）");
    console.log("\n   Token 过期后需重新运行: bun run src/main.ts auth\n");
  }
}
