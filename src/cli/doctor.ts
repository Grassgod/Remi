/**
 * `remi doctor` — Health check for Remi installation.
 *
 * Checks three dimensions:
 * 1. Runtime: Bun, PM2, Claude CLI installed and version OK
 * 2. Config: remi.toml exists with required fields
 * 3. Auth: Claude logged in, Feishu tokens valid, optional API keys
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../shared/version.js";
import * as ui from "./ui.js";

interface CheckResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

function check(fn: () => CheckResult): CheckResult {
  try {
    return fn();
  } catch (e) {
    return { status: "fail", message: (e as Error).message };
  }
}

function execVersion(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
}

// ── Runtime Checks ───────────────────────────────────────────

function checkBun(): CheckResult {
  try {
    const version = execVersion("bun --version");
    return { status: "pass", message: `Bun ${version}` };
  } catch {
    return { status: "fail", message: "Bun not found — install from https://bun.sh" };
  }
}

function checkPM2(): CheckResult {
  try {
    const version = execVersion("pm2 --version");
    return { status: "pass", message: `PM2 ${version}` };
  } catch {
    return { status: "fail", message: "PM2 not found — install with: bun add -g pm2" };
  }
}

function checkClaudeCLI(): CheckResult {
  try {
    const version = execVersion("claude --version 2>/dev/null || claude -v 2>/dev/null");
    return { status: "pass", message: `Claude CLI ${version}` };
  } catch {
    return { status: "fail", message: "Claude CLI not found — install from https://docs.anthropic.com/en/docs/claude-code" };
  }
}

// ── Config Checks ────────────────────────────────────────────

function checkConfigFile(): CheckResult {
  const configPath = join(homedir(), ".remi", "remi.toml");
  if (!existsSync(configPath)) {
    return { status: "fail", message: "remi.toml not found at ~/.remi/remi.toml" };
  }
  return { status: "pass", message: "remi.toml found" };
}

function checkFeishuConfig(): CheckResult {
  const configPath = join(homedir(), ".remi", "remi.toml");
  if (!existsSync(configPath)) {
    return { status: "fail", message: "Cannot check — remi.toml missing" };
  }
  const raw = readFileSync(configPath, "utf-8");

  const appIdMatch = raw.match(/app_id\s*=\s*"([^"]*)"/);
  const appSecretMatch = raw.match(/app_secret\s*=\s*"([^"]*)"/);

  const hasAppId = appIdMatch && appIdMatch[1].length > 0;
  const hasAppSecret = appSecretMatch && appSecretMatch[1].length > 0;

  if (!hasAppId || !hasAppSecret) {
    const missing = [];
    if (!hasAppId) missing.push("app_id");
    if (!hasAppSecret) missing.push("app_secret");
    return { status: "fail", message: `Feishu config incomplete — missing: ${missing.join(", ")}` };
  }
  return { status: "pass", message: "Feishu app_id + app_secret configured" };
}

// ── Auth Checks ──────────────────────────────────────────────

function checkClaudeAuth(): CheckResult {
  try {
    // `claude --version` succeeding implies the CLI is installed;
    // a more reliable check would be `claude api ...` but that's heavy.
    // For now, check if there's a claude config directory.
    const claudeDir = join(homedir(), ".claude");
    if (existsSync(claudeDir)) {
      return { status: "pass", message: "Claude CLI configured" };
    }
    return { status: "warn", message: "Claude CLI may not be logged in — run: claude" };
  } catch {
    return { status: "warn", message: "Could not verify Claude auth status" };
  }
}

function checkFeishuTokens(): CheckResult {
  const tokenPath = join(homedir(), ".remi", "auth", "tokens.json");
  if (!existsSync(tokenPath)) {
    return { status: "warn", message: "No Feishu tokens found — run: remi login" };
  }
  try {
    const data = JSON.parse(readFileSync(tokenPath, "utf-8"));
    const tenantToken = data["feishu/tenant"];
    const userToken = data["feishu/user"];

    const results: string[] = [];
    if (tenantToken?.accessToken) {
      const expiresAt = tenantToken.expiresAt;
      if (expiresAt && expiresAt > Date.now()) {
        const hoursLeft = ((expiresAt - Date.now()) / 3600_000).toFixed(1);
        results.push(`tenant (${hoursLeft}h left)`);
      } else {
        results.push("tenant (expired)");
      }
    }
    if (userToken?.accessToken) {
      const refreshExpiresAt = userToken.refreshExpiresAt;
      if (refreshExpiresAt && refreshExpiresAt > Date.now()) {
        const daysLeft = ((refreshExpiresAt - Date.now()) / 86400_000).toFixed(0);
        results.push(`user (refresh ${daysLeft}d left)`);
      } else {
        results.push("user (refresh expired)");
      }
    }

    if (results.length === 0) {
      return { status: "warn", message: "Feishu tokens exist but may be empty" };
    }
    return { status: "pass", message: `Feishu tokens: ${results.join(", ")}` };
  } catch {
    return { status: "warn", message: "Could not parse Feishu tokens" };
  }
}

function checkGeminiKey(): CheckResult {
  const configPath = join(homedir(), ".remi", "remi.toml");
  if (!existsSync(configPath)) {
    return { status: "warn", message: "Gemini API key not configured (image generation disabled)" };
  }
  const raw = readFileSync(configPath, "utf-8");
  const match = raw.match(/\[google\][\s\S]*?api_key\s*=\s*"([^"]+)"/);
  if (match && match[1].length > 0) {
    return { status: "pass", message: "Gemini API key configured" };
  }
  return { status: "warn", message: "Gemini API key not configured (image generation disabled)" };
}

function checkEmbeddingKey(): CheckResult {
  const configPath = join(homedir(), ".remi", "remi.toml");
  if (!existsSync(configPath)) {
    return { status: "warn", message: "Embedding API key not configured (vector search disabled)" };
  }
  const raw = readFileSync(configPath, "utf-8");
  const match = raw.match(/\[embedding\][\s\S]*?api_key\s*=\s*"([^"]+)"/);
  if (match && match[1].length > 0) {
    return { status: "pass", message: "Embedding API key configured" };
  }
  return { status: "warn", message: "Embedding API key not configured (vector search disabled)" };
}

// ── PM2 Service Checks ───────────────────────────────────────

function checkPM2Services(): CheckResult {
  try {
    const output = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 10_000 });
    const apps = JSON.parse(output) as Array<{ name: string; pm2_env?: { status?: string }; pid?: number }>;
    if (apps.length === 0) {
      return { status: "warn", message: "No PM2 services running" };
    }
    const summary = apps.map((a) => {
      const status = a.pm2_env?.status ?? "unknown";
      return `${a.name}(${status})`;
    }).join(", ");
    return { status: "pass", message: `PM2 services: ${summary}` };
  } catch {
    return { status: "warn", message: "PM2 not running or no services" };
  }
}

// ── Storage Checks ───────────────────────────────────────────

function checkStorage(): CheckResult {
  const remiDir = join(homedir(), ".remi");
  if (!existsSync(remiDir)) {
    return { status: "fail", message: "~/.remi/ directory does not exist" };
  }
  // Try write test
  const testFile = join(remiDir, ".doctor-test");
  try {
    const { writeFileSync: wf, unlinkSync } = require("node:fs");
    wf(testFile, "ok");
    unlinkSync(testFile);
    return { status: "pass", message: "~/.remi/ writable" };
  } catch {
    return { status: "fail", message: "~/.remi/ is not writable" };
  }
}

// ── Main ─────────────────────────────────────────────────────

export async function runDoctor(_args: string[]): Promise<void> {
  ui.banner("Remi Doctor", VERSION);

  let warnings = 0;
  let errors = 0;

  function render(result: CheckResult): void {
    if (result.status === "pass") ui.pass(result.message);
    else if (result.status === "warn") { ui.warn(result.message); warnings++; }
    else { ui.fail(result.message); errors++; }
  }

  // Runtime
  ui.header("Runtime");
  render(check(checkBun));
  render(check(checkPM2));
  render(check(checkClaudeCLI));

  // Config
  ui.header("Config");
  render(check(checkConfigFile));
  render(check(checkFeishuConfig));

  // Auth
  ui.header("Auth");
  render(check(checkClaudeAuth));
  render(check(checkFeishuTokens));
  render(check(checkGeminiKey));
  render(check(checkEmbeddingKey));

  // Services
  ui.header("Services");
  render(check(checkPM2Services));

  // Storage
  ui.header("Storage");
  render(check(checkStorage));

  // Summary
  console.log("");
  ui.line();
  if (errors > 0) {
    console.log(`Result: ${errors} error(s), ${warnings} warning(s)`);
    console.log("Fix errors above before running remi start.");
  } else if (warnings > 0) {
    console.log(`Result: ${warnings} warning(s), 0 errors`);
    console.log("💡 Run \`remi login\` to configure optional features.");
  } else {
    console.log("Result: All checks passed ✅");
  }
  console.log("");
}
