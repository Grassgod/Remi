/**
 * `remi login` — Interactive authentication setup wizard.
 *
 * 1. Claude Code login
 * 2. Feishu User OAuth (Device Authorization Flow)
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "@shared/version.js";
import { TokenPersistence, type PersistedTokens } from "@auth/persistence.js";
import type { TokenEntry } from "@auth/types.js";
import { loadConfig } from "@shared/config.js";
import { authorizeUser, DEFAULT_SCOPES } from "./feishu-bot-creator.js";
import * as ui from "./ui.js";

const TOTAL_STEPS = 2;
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

// ── Step 2: Feishu User OAuth ────────────────────────────────

async function stepFeishuUserOAuth(): Promise<boolean> {
  ui.step(2, TOTAL_STEPS, "Feishu User OAuth");

  const { feishu } = loadConfig();
  const { appId, appSecret } = feishu;
  if (!appId || !appSecret) {
    ui.warn("FEISHU_APP_ID and FEISHU_APP_SECRET are required for User OAuth — skipping.");
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

  const domain = feishu.domain;
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

// ── Main ─────────────────────────────────────────────────────

export async function runLogin(_args: string[]): Promise<void> {
  ui.banner("Remi Setup Wizard", VERSION);
  console.log("This wizard will guide you through configuring Remi.\n");

  const steps = [
    stepClaudeLogin,
    stepFeishuUserOAuth,
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
  console.log("  Next steps:");
  console.log("    Configure connector settings through the service EnvironmentFile");
  console.log("    remi doctor          — Verify everything is configured");
  console.log("    remi daemon start    — Start Remi services");
  console.log("");
}
