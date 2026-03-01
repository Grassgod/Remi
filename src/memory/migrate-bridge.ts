#!/usr/bin/env bun
/**
 * One-time migration: consolidate Claude Code's MEMORY.md into Remi's
 * memory system and set up symlinks for the bridge file.
 *
 * Usage:
 *   bun run src/memory/migrate-bridge.ts
 *   bun run src/memory/migrate-bridge.ts --dry-run   # preview only
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "./store.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MEMORY_ROOT = join(homedir(), ".remi", "memory");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const BRIDGE_FILE = "claude-bridge.md";

// Claude Code encodes paths by replacing "/" with "-" and prefixing with "-"
// e.g. /data00/home/hehuajie -> -data00-home-hehuajie
const SYMLINK_TARGETS = [
  "-data00-home-hehuajie",
  "-home-hehuajie",
];

function log(msg: string): void {
  const prefix = DRY_RUN ? "[DRY-RUN]" : "[MIGRATE]";
  console.log(`${prefix} ${msg}`);
}

function main(): void {
  log("Starting Claude Code → Remi memory bridge migration");
  log(`Memory root: ${MEMORY_ROOT}`);
  log(`Claude projects dir: ${CLAUDE_PROJECTS_DIR}`);

  // 1. Initialize MemoryStore
  const store = new MemoryStore(MEMORY_ROOT);
  const remiMemory = store.readMemory();
  log(`Remi MEMORY.md: ${remiMemory.split("\n").length} lines`);

  // 2. Collect content from Claude Code MEMORY.md files
  const existingLines = new Set(remiMemory.split("\n").map((l) => l.trim()));
  let totalIngested = 0;

  for (const projDir of SYMLINK_TARGETS) {
    const memPath = join(CLAUDE_PROJECTS_DIR, projDir, "memory", "MEMORY.md");
    if (!existsSync(memPath)) {
      log(`  Skip (not found): ${memPath}`);
      continue;
    }

    // Don't process if already a symlink
    try {
      if (lstatSync(memPath).isSymbolicLink()) {
        log(`  Skip (already symlinked): ${memPath}`);
        continue;
      }
    } catch { /* ok */ }

    const content = readFileSync(memPath, "utf-8");
    log(`  Found: ${memPath} (${content.split("\n").length} lines)`);

    // Extract unique bullet points
    const uniqueBullets = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- ") && !existingLines.has(l));

    if (uniqueBullets.length > 0) {
      log(`  Unique content to ingest: ${uniqueBullets.length} lines`);
      for (const line of uniqueBullets) {
        log(`    + ${line}`);
      }

      if (!DRY_RUN) {
        store.appendMemory(
          `\n## Migrated from Claude Code (${projDir})\n${uniqueBullets.join("\n")}`,
        );
      }
      totalIngested += uniqueBullets.length;
    } else {
      log("  No unique content to ingest (all duplicates)");
    }
  }

  log(`Total ingested: ${totalIngested} unique lines`);

  // 3. Generate the bridge file
  log("Generating initial bridge file...");
  if (!DRY_RUN) {
    store.regenerateBridge();
  }

  const bridgePath = join(MEMORY_ROOT, BRIDGE_FILE);
  if (existsSync(bridgePath)) {
    const bridgeContent = readFileSync(bridgePath, "utf-8");
    log(`Bridge file: ${bridgeContent.split("\n").length} lines`);
  }

  // 4. Backup originals and create symlinks
  for (const projDir of SYMLINK_TARGETS) {
    const memDir = join(CLAUDE_PROJECTS_DIR, projDir, "memory");
    const memPath = join(memDir, "MEMORY.md");

    if (!existsSync(memPath)) {
      // Create directory and symlink
      log(`Creating directory + symlink: ${memPath} → ${bridgePath}`);
      if (!DRY_RUN) {
        if (!existsSync(memDir)) {
          mkdirSync(memDir, { recursive: true });
        }
        symlinkSync(bridgePath, memPath);
      }
      continue;
    }

    // Skip if already a symlink
    try {
      if (lstatSync(memPath).isSymbolicLink()) {
        const target = realpathSync(memPath);
        if (target === bridgePath) {
          log(`Already symlinked correctly: ${memPath}`);
          continue;
        }
      }
    } catch { /* ok */ }

    // Backup original
    const backupPath = memPath + ".bak";
    log(`Backup: ${memPath} → ${backupPath}`);
    if (!DRY_RUN) {
      renameSync(memPath, backupPath);
    }

    // Create symlink
    log(`Symlink: ${memPath} → ${bridgePath}`);
    if (!DRY_RUN) {
      symlinkSync(bridgePath, memPath);
    }
  }

  log("");
  log("Migration complete!");
  if (DRY_RUN) {
    log("This was a dry run. Re-run without --dry-run to apply changes.");
  } else {
    log("Verify with: ls -la ~/.claude/projects/-data00-home-hehuajie/memory/MEMORY.md");
  }
}

main();
