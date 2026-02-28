/**
 * CLI command: `bun run src/main.ts auth`
 *
 * Performs Feishu OAuth to obtain a user_access_token (+ refresh_token if available),
 * then persists it to ~/.remi/auth/tokens.json.
 * If refresh_token is returned, the daemon's FeishuAuthAdapter auto-refreshes.
 * Otherwise, re-run this command when the token expires (~2h).
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

async function getTenantToken(apiBase: string, appId: string, appSecret: string): Promise<string> {
  const resp = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg}`);
  }
  return data.tenant_access_token;
}

async function exchangeCode(
  apiBase: string,
  tenantToken: string,
  code: string,
): Promise<TokenEntry> {
  // Use legacy v1 endpoint (returns u- prefix tokens compatible with existing code)
  const resp = await fetch(`${apiBase}/authen/v1/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });

  const result = (await resp.json()) as {
    code: number;
    msg?: string;
    data?: {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      refresh_expires_in?: number;
    };
  };

  if (result.code !== 0 || !result.data) {
    throw new Error(`换取 user_access_token 失败: ${result.msg ?? `code ${result.code}`}`);
  }

  const entry: TokenEntry = {
    value: result.data.access_token,
    expiresAt: Date.now() + result.data.expires_in * 1000 - 5 * 60 * 1000,
  };

  if (result.data.refresh_token) {
    entry.refreshToken = result.data.refresh_token;
    entry.refreshExpiresAt = Date.now() + (result.data.refresh_expires_in ?? 2592000) * 1000;
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

  // Step 1: Build auth URL
  const authUrl =
    `${apiBase}/authen/v1/authorize?app_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=offline_access` +
    `&state=remi_auth`;

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

  // Step 3: Get tenant token
  console.log("\n⏳ 获取 tenant_access_token...");
  const tenantToken = await getTenantToken(apiBase, appId, appSecret);
  console.log("✅ tenant_access_token 获取成功");

  // Step 4: Exchange code for user token
  console.log("⏳ 换取 user_access_token...");
  const userEntry = await exchangeCode(apiBase, tenantToken, code);
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
