/**
 * PM2 service management commands.
 *
 * Thin wrappers around existing pm2.ts functions.
 */

import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { pm2Start, pm2Stop, resolvePm2Command } from "../pm2.js";
import { VERSION } from "../version.js";

export async function runStart(_args: string[]): Promise<void> {
  const config = loadConfig();
  pm2Start(config);
}

export async function runStop(_args: string[]): Promise<void> {
  pm2Stop();
}

export async function runRestart(_args: string[]): Promise<void> {
  console.log("Restarting all services...");
  try {
    execFileSync(resolvePm2Command(), ["restart", "all"], { stdio: "inherit" });
    console.log("All services restarted.");
  } catch {
    // If no processes exist, fall back to full start
    console.log("No running processes found, starting fresh...");
    const config = loadConfig();
    pm2Start(config);
  }
}

export async function runStatus(_args: string[]): Promise<void> {
  console.log(`Remi v${VERSION}\n`);
  try {
    execFileSync(resolvePm2Command(), ["status"], { stdio: "inherit" });
  } catch {
    console.log("PM2 is not running or no services registered.");
    console.log("Run `remi start` to launch services.");
  }
}
