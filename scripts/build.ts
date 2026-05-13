#!/usr/bin/env bun
/**
 * Remi Build Pipeline
 *
 * 1. bun build → single bundle
 * 2. Package skills + agents + bin + config
 * 3. Create tar.gz release archive
 *
 * Usage: bun run scripts/build.ts
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BUILD_DIR = join(ROOT, ".build");

const versionMatch = readFileSync(join(ROOT, "src", "version.ts"), "utf-8").match(/VERSION\s*=\s*"([^"]+)"/);
const version = versionMatch?.[1] ?? "0.0.0";

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

console.log(`\nBuilding Remi v${version} (${os}-${arch})\n`);

// Step 1: Clean

if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true });
mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(join(BUILD_DIR, "dist"), { recursive: true });
mkdirSync(join(BUILD_DIR, "bin"), { recursive: true });

// Step 2: Bundle

console.log("Bundling with bun build...");
execSync(
  `bun build src/main.ts --target=bun --outfile=${join(BUILD_DIR, "dist", "remi.bundle.js")} --minify`,
  { cwd: ROOT, stdio: "inherit" },
);

// Step 3: Copy assets

console.log("\nCopying assets...");

writeFileSync(
  join(BUILD_DIR, "bin", "remi"),
  `#!/usr/bin/env bash\n` +
  `REMI_HOME="\${REMI_HOME:-$HOME/.remi}"\n` +
  `exec bun run "$REMI_HOME/dist/remi.bundle.js" "$@"\n`,
  { mode: 0o755 },
);
cpSync(join(ROOT, "bin", "remi-claude-agent-acp"), join(BUILD_DIR, "bin", "remi-claude-agent-acp"));
chmodSync(join(BUILD_DIR, "bin", "remi-claude-agent-acp"), 0o755);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const prodPkg = {
  name: pkg.name,
  version: version,
  type: "module",
  dependencies: pkg.dependencies,
};
writeFileSync(join(BUILD_DIR, "package.json"), JSON.stringify(prodPkg, null, 2));

cpSync(join(ROOT, "src", "cli", "template.toml"), join(BUILD_DIR, "dist", "template.toml"));

const coreSkills = ["image", "skill-creator", "memory-enhance", "agent-browser"];
const skillsSrc = join(process.env.HOME!, ".claude", "skills");
const skillsDst = join(BUILD_DIR, "skills");
mkdirSync(skillsDst, { recursive: true });
for (const skill of coreSkills) {
  const src = join(skillsSrc, skill);
  if (existsSync(src)) {
    cpSync(src, join(skillsDst, skill), { recursive: true });
    console.log(`  skill: ${skill}`);
  } else {
    console.log(`  skill not found: ${src}`);
  }
}

const agentsSrc = join(ROOT, "agents");
const agentsDst = join(BUILD_DIR, "agents");
if (existsSync(agentsSrc)) {
  cpSync(agentsSrc, agentsDst, { recursive: true });
  console.log("  agents/ copied");
}

// Step 4: Create tar.gz

const archiveName = `remi-v${version}-${os}-${arch}.tar.gz`;
const archivePath = join(DIST, archiveName);
mkdirSync(DIST, { recursive: true });

console.log(`\nCreating ${archiveName}...`);
execSync(
  `tar czf "${archivePath}" -C "${BUILD_DIR}" .`,
  { stdio: "inherit" },
);

// Step 5: Clean up

rmSync(BUILD_DIR, { recursive: true });

const size = (statSync(archivePath).size / 1024 / 1024).toFixed(1);
console.log(`\nBuild complete!`);
console.log(`   Archive: ${archivePath}`);
console.log(`   Size: ${size} MB`);
console.log(`   Version: ${version}`);
console.log(`   Platform: ${os}-${arch}`);
console.log("");
