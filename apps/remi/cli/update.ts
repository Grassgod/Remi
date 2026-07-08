/**
 * `remi update` — Self-update from GitHub Releases.
 *
 * 1. Check latest version vs current
 * 2. Download tar.gz for current platform
 * 3. Backup current dist/
 * 4. Extract new code (preserves user data)
 * 5. Run bun install if deps changed
 * 6. Run remi doctor
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@shared/version.js";
import * as ui from "./ui.js";

const REMI_HOME = process.env.REMI_HOME ?? join(homedir(), ".remi");
const GITHUB_REPO = "grasscoder/remi";

interface GithubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

function detectPlatform(): { os: string; arch: string } {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { os, arch };
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as GithubRelease;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export async function runUpdate(_args: string[]): Promise<void> {
  ui.banner("Remi Update", VERSION);

  const { os, arch } = detectPlatform();
  ui.info(`Platform: ${os}-${arch}`);
  ui.info(`Current version: v${VERSION}`);
  console.log("");

  // Step 1: Check latest version
  console.log("Checking for updates...");
  let release: GithubRelease;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    ui.fail(`Failed to check for updates: ${(e as Error).message}`);
    return;
  }

  const latestVersion = release.tag_name.replace(/^v/, "");
  if (compareVersions(latestVersion, VERSION) <= 0) {
    ui.pass(`Already up to date (v${VERSION}).`);
    return;
  }

  console.log(`  New version available: v${latestVersion}\n`);

  // Step 2: Find matching asset
  const assetName = `remi-v${latestVersion}-${os}-${arch}.tar.gz`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    ui.fail(`No release found for ${os}-${arch}. Available:`);
    for (const a of release.assets) {
      console.log(`    ${a.name}`);
    }
    return;
  }

  // Step 3: Download
  console.log(`Downloading ${assetName}...`);
  const tmpPath = join("/tmp", `remi-update-${Date.now()}.tar.gz`);
  try {
    execSync(`curl -fsSL "${asset.browser_download_url}" -o "${tmpPath}"`, { stdio: "inherit" });
  } catch {
    ui.fail("Download failed.");
    return;
  }

  // Step 4: Backup current dist
  const distPath = join(REMI_HOME, "dist");
  const bakPath = join(REMI_HOME, "dist.bak");
  if (existsSync(distPath)) {
    if (existsSync(bakPath)) rmSync(bakPath, { recursive: true });
    cpSync(distPath, bakPath, { recursive: true });
    ui.info("Backed up current dist/ → dist.bak/");
  }

  // Step 5: Extract (tar overwrites dist/, bin/, skills/, agents/, package.json)
  console.log("Installing update...");
  execSync(`tar xzf "${tmpPath}" -C "${REMI_HOME}"`, { stdio: "inherit" });
  rmSync(tmpPath);

  // Step 6: Install deps if changed
  const pkgPath = join(REMI_HOME, "package.json");
  if (existsSync(pkgPath)) {
    console.log("Installing dependencies...");
    try {
      execSync("bun install --production", { cwd: REMI_HOME, stdio: "inherit" });
    } catch {
      ui.warn("bun install had issues, but continuing...");
    }
  }

  // Step 7: Doctor check
  console.log("");
  ui.pass(`Updated to v${latestVersion}!`);
  console.log("\nRunning doctor check...\n");

  try {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor([]);
  } catch {
    // Doctor might fail if the new version changes interfaces
    ui.warn("Doctor check failed — this may be expected after a major update.");
  }

  console.log("Run `remi restart` to apply the update.");
  console.log("");
}
