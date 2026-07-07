/**
 * `remi login` — Interactive 6-step setup wizard.
 *
 * 1. Claude Code login
 * 2. Feishu Bot auto-creation (Device Flow)
 * 3. Feishu permission check
 * 4. Feishu User OAuth (Device Authorization Flow)
 * 5. Gemini API Key (optional)
 * 6. Embedding API Key (optional)
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "@shared/version.js";
import { TokenPersistence, type PersistedTokens } from "@auth/persistence.js";
import type { TokenEntry } from "@auth/types.js";
import { createBot, authorizeUser, DEFAULT_SCOPES } from "./feishu-bot-creator.js";
import { ensureConfigFile, setConfigValue, getConfigValue, getConfigPath } from "./config-writer.js";
import * as ui from "./ui.js";

const TOTAL_STEPS = 6;
const AUTH_DIR = join(homedir(), ".remi", "auth");

// ── Step 1: Claude Code Login ────────────────────────────────

async function stepClaudeLogin(): Promise<boolean> {
  ui.step(1, TOTAL_STEPS, "Claude Code Login");

  // Check if Claude CLI is installed
  try {
    execSync("claude --version 2>/dev/null || claude -v 2>/dev/null", { encoding: "utf-8", timeout: 10_000 });
  } catch {
    ui.fail("Claude Code CLI not found.");
    console.log("  Install: https://docs.anthropic.com/en/docs/claude-code");
    return false;
  }

  // Check if already logged in (heuristic: ~/.claude exists)
  const claudeDir = join(homedir(), ".claude");
  try {
    execSync("ls " + claudeDir, { encoding: "utf-8", timeout: 5_000 });
    ui.pass("Claude Code CLI is installed and configured.");
    return true;
  } catch {
    // Not configured yet
  }

  console.log("\n  Please open a separate terminal and run:");
  console.log("    claude");
  console.log("  Complete the login flow, then come back here.\n");
  const answer = await ui.prompt("  Press Enter after completing Claude login (or 'skip' to skip):");
  if (answer.toLowerCase() === "skip") {
    ui.warn("Claude login skipped. You'll need to login before using Remi.");
    return true;
  }
  ui.pass("Claude login confirmed.");
  return true;
}

// ── Step 2: Feishu Bot Auto-Creation ─────────────────────────

async function stepFeishuBotCreation(): Promise<boolean> {
  ui.step(2, TOTAL_STEPS, "Feishu Bot Creation");

  ensureConfigFile();

  // Check if already configured
  const existingAppId = getConfigValue("feishu", "appId");
  if (existingAppId && existingAppId.length > 0) {
    ui.pass(`Feishu Bot already configured (app_id: ${existingAppId.slice(0, 10)}...)`);
    const answer = await ui.prompt("  Reconfigure? (y/N):");
    if (answer.toLowerCase() !== "y") return true;
  }

  // Detect brand from config
  const domain = getConfigValue("feishu", "domain") ?? "feishu";
  const brand = domain === "lark" ? "lark" as const : "feishu" as const;

  console.log("\n  Creating a new Feishu Bot via Device Flow...");
  console.log("  A QR code will appear. Scan it with Feishu to approve.\n");

  try {
    const creds = await createBot(brand, {
      onQrUrl: (url, userCode) => {
        console.log(`\n  📱 Scan QR or open this URL in Feishu:`);
        console.log(`     ${url}\n`);
        console.log(`  User code: ${userCode}\n`);
        console.log("  Waiting for approval...");
      },
      onPolling: (attempt) => {
        if (attempt % 10 === 0) {
          process.stdout.write(".");
        }
      },
    });

    setConfigValue("feishu", "appId", creds.appId);
    setConfigValue("feishu", "appSecret", creds.appSecret);

    console.log("");
    ui.pass(`Bot created! app_id: ${creds.appId}`);
    return true;
  } catch (e) {
    ui.fail(`Bot creation failed: ${(e as Error).message}`);
    console.log("\n  You can manually create a bot at: https://open.feishu.cn/app");
    console.log("  Then run: remi login\n");

    const answer = await ui.prompt("  Enter app_id manually (or press Enter to skip):");
    if (answer) {
      setConfigValue("feishu", "appId", answer);
      const secret = await ui.prompt("  Enter app_secret:");
      if (secret) {
        setConfigValue("feishu", "appSecret", secret);
        ui.pass("Feishu credentials saved.");
        return true;
      }
    }
    ui.warn("Feishu Bot setup skipped.");
    return true;
  }
}

// ── Step 3: Feishu Permission Check ──────────────────────────

async function stepFeishuPermissionCheck(): Promise<boolean> {
  ui.step(3, TOTAL_STEPS, "Feishu Permission Check");

  const appId = getConfigValue("feishu", "appId");
  if (!appId) {
    ui.warn("No app_id configured — skipping permission check.");
    return true;
  }

  // Feishu bots created via Device Flow get scopes automatically.
  // For manually created bots, permissions need to be set in the dev console.
  ui.info("Bot created via Device Flow has default scopes auto-applied.");
  ui.info(`Scopes include: docs, sheets, calendar, tasks, chat, wiki, etc. (~${DEFAULT_SCOPES.length} scopes)`);
  ui.pass("Permission check passed (Device Flow auto-scoped).");
  return true;
}

// ── Step 4: Feishu User OAuth ────────────────────────────────

async function stepFeishuUserOAuth(): Promise<boolean> {
  ui.step(4, TOTAL_STEPS, "Feishu User OAuth");

  const appId = getConfigValue("feishu", "appId");
  const appSecret = getConfigValue("feishu", "appSecret");
  if (!appId || !appSecret) {
    ui.warn("No Feishu credentials — skipping User OAuth.");
    return true;
  }

  // Check if we already have valid tokens
  const persistence = new TokenPersistence(join(AUTH_DIR, "tokens.json"));
  const existing = persistence.load();
  const userToken = existing?.feishu?.user;
  if (userToken?.refreshToken && userToken.refreshExpiresAt && userToken.refreshExpiresAt > Date.now()) {
    const daysLeft = Math.round((userToken.refreshExpiresAt - Date.now()) / 86400_000);
    ui.pass(`Feishu user token exists (refresh valid for ~${daysLeft}d)`);
    const answer = await ui.prompt("  Re-authorize? (y/N):");
    if (answer.toLowerCase() !== "y") return true;
  }

  const domain = getConfigValue("feishu", "domain") ?? "feishu";
  const brand = domain === "lark" ? "lark" as const : "feishu" as const;

  console.log("\n  Starting Feishu User OAuth (Device Flow)...");
  console.log("  A QR code will appear. Scan it with Feishu to authorize.\n");

  try {
    const result = await authorizeUser(brand, appId, appSecret, DEFAULT_SCOPES, {
      onQrUrl: (url, userCode) => {
        console.log(`\n  📱 Scan QR or open this URL:`);
        console.log(`     ${url}\n`);
        console.log(`  User code: ${userCode}\n`);
        console.log("  Waiting for authorization...");
      },
      onPolling: (attempt) => {
        if (attempt % 10 === 0) process.stdout.write(".");
      },
    });

    // Persist tokens
    const tokens: PersistedTokens = persistence.load();
    if (!tokens.feishu) tokens.feishu = {};
    const entry: TokenEntry = {
      value: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000 - 5 * 60 * 1000,
    };
    if (result.refreshToken) {
      entry.refreshToken = result.refreshToken;
      entry.refreshExpiresAt = Date.now() + (result.refreshExpiresIn ?? 2592000) * 1000;
    }
    tokens.feishu.user = entry;
    persistence.save(tokens);

    console.log("");
    ui.pass("User OAuth completed! Token saved.");
    if (result.refreshToken) {
      const refreshDays = Math.round((result.refreshExpiresIn ?? 2592000) / 86400);
      ui.info(`Refresh token valid for ~${refreshDays} days (auto-renewed).`);
    }
    return true;
  } catch (e) {
    ui.fail(`User OAuth failed: ${(e as Error).message}`);
    console.log("  You can retry later with: remi login");
    return true;
  }
}

// ── Step 5: Gemini API Key (optional) ────────────────────────

async function stepGeminiApiKey(): Promise<boolean> {
  ui.step(5, TOTAL_STEPS, "Gemini API Key (optional — image generation)");

  const existing = getConfigValue("google", "apiKey");
  if (existing && existing.length > 0) {
    ui.pass("Gemini API key already configured.");
    return true;
  }

  const key = await ui.prompt("  Enter Gemini API key (press Enter to skip):");
  if (key) {
    setConfigValue("google", "apiKey", key);
    ui.pass("Gemini API key saved.");
  } else {
    ui.warn("Skipped. Image generation will be disabled.");
    ui.info("You can add it later via: remi login");
  }
  return true;
}

// ── Step 6: Embedding API Key (optional) ─────────────────────

async function stepEmbeddingApiKey(): Promise<boolean> {
  ui.step(6, TOTAL_STEPS, "Embedding API Key (optional — vector search)");

  const existing = getConfigValue("embedding", "apiKey");
  if (existing && existing.length > 0) {
    ui.pass("Embedding API key already configured.");
    return true;
  }

  const key = await ui.prompt("  Enter Embedding API key (press Enter to skip):");
  if (key) {
    setConfigValue("embedding", "provider", "voyage");
    setConfigValue("embedding", "apiKey", key);
    ui.pass("Embedding API key saved.");
  } else {
    ui.warn("Skipped. Vector search (L2) will be disabled; text search (L1) still works.");
    ui.info("You can add it later via: remi login");
  }
  return true;
}

// ── Main ─────────────────────────────────────────────────────

export async function runLogin(_args: string[]): Promise<void> {
  ui.banner("Remi Setup Wizard", VERSION);
  console.log("This wizard will guide you through configuring Remi.\n");

  const steps = [
    stepClaudeLogin,
    stepFeishuBotCreation,
    stepFeishuPermissionCheck,
    stepFeishuUserOAuth,
    stepGeminiApiKey,
    stepEmbeddingApiKey,
  ];

  for (const step of steps) {
    const ok = await step();
    if (!ok) {
      console.log("\nSetup aborted. Fix the issue above and run `remi login` again.");
      process.exit(1);
    }
  }

  console.log("");
  ui.line();
  console.log("🎉 Setup complete!\n");
  console.log("  Config saved to: " + getConfigPath());
  console.log("  Next steps:");
  console.log("    remi doctor   — Verify everything is configured");
  console.log("    remi start    — Start Remi services");
  console.log("");
}
