#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

const SERVER_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(SERVER_ROOT, "../..");
const DIST = join(REPO_ROOT, "dist");
const BUILD = join(SERVER_ROOT, ".remi-cli-build");

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
const rawVersion = process.env.REMI_VERSION || process.env.GITHUB_REF_NAME || pkg.version || "0.0.0";
const tagVersion = rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
const assetVersion = tagVersion.slice(1);

const targets = [
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
];

if (existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

for (const target of targets) {
  const targetDir = join(BUILD, `${target.os}-${target.arch}`);
  const bin = join(targetDir, "remi");
  mkdirSync(targetDir, { recursive: true });

  console.log(`Building remi ${tagVersion} for ${target.os}-${target.arch}`);
  execFileSync(
    "bun",
    [
      "build",
      "src/remi-cli.ts",
      "--compile",
      "--minify",
      "--target",
      target.bunTarget,
      "--define",
      `REMI_VERSION=${JSON.stringify(tagVersion)}`,
      "--outfile",
      bin,
    ],
    { cwd: SERVER_ROOT, stdio: "inherit" },
  );
  chmodSync(bin, 0o755);

  const archive = join(DIST, `remi-cli-${assetVersion}-${target.os}-${target.arch}.tar.gz`);
  execFileSync("tar", ["czf", archive, "-C", targetDir, "remi"], { stdio: "inherit" });
  console.log(`Wrote ${archive}`);
}

rmSync(BUILD, { recursive: true, force: true });
