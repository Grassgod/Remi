#!/usr/bin/env bun
/**
 * Remi Build Pipeline
 *
 * 1. bun build → single bundle
 * 2. javascript-obfuscator → obfuscated bundle
 * 3. Package skills + agents + bin + config
 * 4. Create tar.gz release archive
 *
 * Usage: bun run scripts/build.ts [--skip-obfuscate]
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BUILD_DIR = join(ROOT, ".build");
const VERSION = JSON.parse(readFileSync(join(ROOT, "src", "version.ts"), "utf-8").match(/VERSION\s*=\s*"([^"]+)"/)?.[0] ? "{}" : "{}") || {};

// Read version from source
const versionMatch = readFileSync(join(ROOT, "src", "version.ts"), "utf-8").match(/VERSION\s*=\s*"([^"]+)"/);
const version = versionMatch?.[1] ?? "0.0.0";

const skipObfuscate = process.argv.includes("--skip-obfuscate");
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

console.log(`\n🔨 Building Remi v${version} (${os}-${arch})\n`);

// ── Step 1: Clean ────────────────────────────────────────────

if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true });
mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(join(BUILD_DIR, "dist"), { recursive: true });
mkdirSync(join(BUILD_DIR, "bin"), { recursive: true });

// ── Step 2: Bundle ───────────────────────────────────────────

console.log("📦 Bundling with bun build...");
execSync(
  `bun build src/main.ts --target=bun --outfile=${join(BUILD_DIR, "dist", "remi.bundle.js")} --minify`,
  { cwd: ROOT, stdio: "inherit" },
);

// ── Step 3: Obfuscate ────────────────────────────────────────

if (!skipObfuscate) {
  console.log("\n🔐 Obfuscating...");

  // Check if javascript-obfuscator is available
  try {
    execSync("npx javascript-obfuscator --version", { cwd: ROOT, stdio: "pipe" });
  } catch {
    console.log("  Installing javascript-obfuscator...");
    execSync("bun add -d javascript-obfuscator", { cwd: ROOT, stdio: "inherit" });
  }

  const bundlePath = join(BUILD_DIR, "dist", "remi.bundle.js");
  const obfPath = join(BUILD_DIR, "dist", "remi.obf.js");

  execSync(
    `npx javascript-obfuscator "${bundlePath}" --output "${obfPath}" ` +
    `--compact true ` +
    `--control-flow-flattening true ` +
    `--control-flow-flattening-threshold 0.5 ` +
    `--dead-code-injection false ` +
    `--string-array true ` +
    `--string-array-encoding rc4 ` +
    `--string-array-threshold 0.5 ` +
    `--self-defending false ` +     // Must be false for Bun runtime
    `--unicode-escape-sequence false`,
    { cwd: ROOT, stdio: "inherit" },
  );

  // Replace bundle with obfuscated version
  rmSync(bundlePath);
  cpSync(obfPath, bundlePath);
  rmSync(obfPath);
  console.log("  ✅ Obfuscation complete.");
} else {
  console.log("\n⏭️  Skipping obfuscation (--skip-obfuscate)");
}

// ── Step 4: Copy assets ──────────────────────────────────────

console.log("\n📁 Copying assets...");

// bin/remi entry script
writeFileSync(
  join(BUILD_DIR, "bin", "remi"),
  `#!/usr/bin/env bash\n` +
  `REMI_HOME="\${REMI_HOME:-$HOME/.remi}"\n` +
  `exec bun run "$REMI_HOME/dist/remi.bundle.js" "$@"\n`,
  { mode: 0o755 },
);

// package.json (production deps only)
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const prodPkg = {
  name: pkg.name,
  version: version,
  type: "module",
  dependencies: pkg.dependencies,
};
writeFileSync(join(BUILD_DIR, "package.json"), JSON.stringify(prodPkg, null, 2));

// Config template
cpSync(join(ROOT, "src", "cli", "template.toml"), join(BUILD_DIR, "dist", "template.toml"));

// Core skills (4 user-facing)
const coreSkills = ["image", "skill-creator", "memory-enhance", "agent-browser"];
const skillsSrc = join(process.env.HOME!, ".claude", "skills");
const skillsDst = join(BUILD_DIR, "skills");
mkdirSync(skillsDst, { recursive: true });
for (const skill of coreSkills) {
  const src = join(skillsSrc, skill);
  if (existsSync(src)) {
    cpSync(src, join(skillsDst, skill), { recursive: true });
    console.log(`  ✅ skill: ${skill}`);
  } else {
    console.log(`  ⚠️  skill not found: ${src}`);
  }
}

// Core agents (4 background)
const agentsSrc = join(ROOT, "agents");
const agentsDst = join(BUILD_DIR, "agents");
if (existsSync(agentsSrc)) {
  cpSync(agentsSrc, agentsDst, { recursive: true });
  console.log("  ✅ agents/ copied");
}

// ── Step 5: Create tar.gz ────────────────────────────────────

const archiveName = `remi-v${version}-${os}-${arch}.tar.gz`;
const archivePath = join(DIST, archiveName);
mkdirSync(DIST, { recursive: true });

console.log(`\n📦 Creating ${archiveName}...`);
execSync(
  `tar czf "${archivePath}" -C "${BUILD_DIR}" .`,
  { stdio: "inherit" },
);

// ── Step 6: Clean up ─────────────────────────────────────────

rmSync(BUILD_DIR, { recursive: true });

// Print summary
const { statSync } = require("node:fs");
const size = (statSync(archivePath).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Build complete!`);
console.log(`   Archive: ${archivePath}`);
console.log(`   Size: ${size} MB`);
console.log(`   Version: ${version}`);
console.log(`   Platform: ${os}-${arch}`);
console.log("");
