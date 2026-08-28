#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const requireFromBuild = createRequire(import.meta.url);

export function multiremiSqliteVecEntry(target: Pick<MultiremiReleaseTarget, "os">): string {
  return target.os === "darwin" ? "vec0.dylib" : "vec0.so";
}

export function multiremiArchiveEntries(target: Pick<MultiremiReleaseTarget, "os">): string[] {
  return [...MULTIREMI_ARCHIVE_ENTRIES, multiremiSqliteVecEntry(target)];
}

export function normalizeMultiremiTagVersion(rawVersion: string): string {
  return rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
}

export function multiremiAssetVersion(rawVersion: string): string {
  return normalizeMultiremiTagVersion(rawVersion).slice(1);
}

export function multiremiArchiveName(rawVersion: string, target: Pick<MultiremiReleaseTarget, "os" | "arch">): string {
  return `remi-${multiremiAssetVersion(rawVersion)}-${target.os}-${target.arch}.tar.gz`;
}

export function createMultiremiArchive(
  targetDir: string,
  archive: string,
  target: Pick<MultiremiReleaseTarget, "os">,
  stdio: "inherit" | "pipe" = "inherit",
): void {
  execFileSync("tar", ["czf", archive, "-C", targetDir, ...multiremiArchiveEntries(target)], { stdio });
}

export function copyMultiremiSqliteVecExtension(
  target: Pick<MultiremiReleaseTarget, "os" | "arch">,
  targetDir: string,
  resolveModule: (specifier: string) => string = requireFromBuild.resolve,
): string {
  const packageName = `sqlite-vec-${target.os}-${target.arch}`;
  const entry = multiremiSqliteVecEntry(target);
  let source: string;
  try {
    source = resolveModule(`${packageName}/${entry}`);
  } catch (error) {
    throw new Error(
      `missing sqlite-vec native extension for ${target.os}-${target.arch}; `
      + `install dependencies with --os=* --cpu=* (${error instanceof Error ? error.message : error})`,
    );
  }
  if (!existsSync(source)) throw new Error(`sqlite-vec native extension does not exist: ${source}`);
  const destination = join(targetDir, entry);
  cpSync(source, destination);
  return destination;
}

export function assertMultiremiBinaryVersion(bin: string, rawVersion: string): void {
  const expected = multiremiAssetVersion(rawVersion);
  const actual = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== expected) {
    throw new Error(`compiled remi version mismatch: expected ${expected}, got ${actual}`);
  }
}

export function assertMultiremiBinarySqliteVec(bin: string): void {
  const testHome = mkdtempSync(join(tmpdir(), "multiremi-sqlite-vec-"));
  try {
    execFileSync(bin, ["doctor"], {
      env: { ...process.env, HOME: testHome },
      stdio: "pipe",
    });
    const db = new Database(join(testHome, ".remi", "remi.db"), { readonly: true });
    try {
      const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_items'").get();
      if (!row) throw new Error("vec_items was not created");
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error(`compiled remi sqlite-vec check failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
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
    copyMultiremiSqliteVecExtension(target, targetDir);

    console.log(`Building remi agent ${tagVersion} for ${target.os}-${target.arch}`);
    execFileSync(
      "bun",
      [
        "build",
        "apps/remi/main.ts",
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
    if (target.os === process.platform && target.arch === process.arch) {
      assertMultiremiBinaryVersion(bin, tagVersion);
      assertMultiremiBinarySqliteVec(bin);
    }

    const claudeWrapper = join(targetDir, "remi-claude-agent-acp");
    cpSync(join(ROOT, "bin", "remi-claude-agent-acp"), claudeWrapper);
    chmodSync(claudeWrapper, 0o755);

    const archive = join(DIST, multiremiArchiveName(tagVersion, target));
    createMultiremiArchive(targetDir, archive, target);
    console.log(`Wrote ${archive}`);
  }

  rmSync(BUILD, { recursive: true, force: true });
}

if (import.meta.main) {
  buildMultiremiReleaseArchives();
}
