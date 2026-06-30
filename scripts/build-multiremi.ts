#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BUILD = join(ROOT, ".multiremi-build");

export type MultiremiReleaseTarget = {
  os: string;
  arch: string;
  bunTarget: string;
};

export const MULTIREMI_RELEASE_TARGETS: MultiremiReleaseTarget[] = [
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
];

export const MULTIREMI_ARCHIVE_ENTRIES = ["remi", "remi-claude-agent-acp"] as const;

export function normalizeMultiremiTagVersion(rawVersion: string): string {
  return rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
}

export function multiremiAssetVersion(rawVersion: string): string {
  return normalizeMultiremiTagVersion(rawVersion).slice(1);
}

export function multiremiArchiveName(rawVersion: string, target: Pick<MultiremiReleaseTarget, "os" | "arch">): string {
  return `remi-${multiremiAssetVersion(rawVersion)}-${target.os}-${target.arch}.tar.gz`;
}

export function createMultiremiArchive(targetDir: string, archive: string, stdio: "inherit" | "pipe" = "inherit"): void {
  execFileSync("tar", ["czf", archive, "-C", targetDir, ...MULTIREMI_ARCHIVE_ENTRIES], { stdio });
}

export function buildMultiremiReleaseArchives(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  const rawVersion = process.env.MULTIREMI_VERSION || process.env.GITHUB_REF_NAME || pkg.version || "0.0.0";
  const tagVersion = normalizeMultiremiTagVersion(rawVersion);

  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(DIST, { recursive: true });

  for (const target of MULTIREMI_RELEASE_TARGETS) {
    const targetDir = join(BUILD, `${target.os}-${target.arch}`);
    const bin = join(targetDir, "remi");
    mkdirSync(targetDir, { recursive: true });

    console.log(`Building remi agent ${tagVersion} for ${target.os}-${target.arch}`);
    execFileSync(
      "bun",
      [
        "build",
        "src/main.ts",
        "--compile",
        "--minify",
        "--target",
        target.bunTarget,
        "--define",
        `MULTIREMI_VERSION=${JSON.stringify(tagVersion)}`,
        "--outfile",
        bin,
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
    chmodSync(bin, 0o755);

    const claudeWrapper = join(targetDir, "remi-claude-agent-acp");
    cpSync(join(ROOT, "bin", "remi-claude-agent-acp"), claudeWrapper);
    chmodSync(claudeWrapper, 0o755);

    const archive = join(DIST, multiremiArchiveName(tagVersion, target));
    createMultiremiArchive(targetDir, archive);
    console.log(`Wrote ${archive}`);
  }

  rmSync(BUILD, { recursive: true, force: true });
}

if (import.meta.main) {
  buildMultiremiReleaseArchives();
}
