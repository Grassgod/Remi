/**
 * SymlinkManager — Manages symlink mappings between provider directories and ~/.remi/
 *
 * Ensures all knowledge-related data produced by providers (Claude Code, etc.)
 * is transparently redirected to ~/.remi/ via filesystem symlinks.
 *
 * Design:
 *   - ensureOne(source, target) to declare + enforce a single mapping
 *   - ensureAllProjects() on daemon boot (full scan)
 *   - ensureForCwd(cwd) on new project encounter (single check)
 *   - Set<string> cache to skip already-verified paths
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("symlink");

// ── Constants ──────────────────────────────────────────────────

import { homedir } from "node:os";

const HOME = homedir();
const CLAUDE_HOME = join(HOME, ".claude");
const REMI_HOME = join(HOME, ".remi");

const CLAUDE_PROJECTS = join(CLAUDE_HOME, "projects");
const REMI_PROJECTS = join(REMI_HOME, "projects");
const REMI_MEMORY = join(REMI_HOME, "memory");

// Home directory hashes — these get special treatment (memory → ~/.remi/memory/)
// Hash is the home path with "/" replaced by "-"
const HOME_HASH = HOME.replace(/\//g, "-");
const HOME_HASHES = new Set([
  HOME_HASH,
  // Legacy server paths
  "-data00-home-hehuajie",
  "-home-hehuajie",
]);

// ── Types ──────────────────────────────────────────────────────

interface EnsureResult {
  action: string;
  source: string;
  target: string;
}

type LinkStatus = "ok" | "broken" | "not_linked" | "missing_target";

interface MappingStatus {
  source: string;
  target: string;
  type: "dir" | "file";
  status: LinkStatus;
}

// ── SymlinkManager ─────────────────────────────────────────────

export class SymlinkManager {
  private verified = new Set<string>();

  /**
   * Convert a filesystem path to CC's hash format.
   * Claude Code replaces `/` with `-` to flatten paths into directory names.
   */
  pathToHash(path: string): string {
    return path.replace(/\//g, "-");
  }

  /**
   * Register and ensure a single symlink mapping.
   *
   * Logic:
   *   1. target doesn't exist → create it
   *   2. source doesn't exist → create target + symlink
   *   3. source is correct symlink → skip (add to cache)
   *   4. source is wrong symlink → delete + recreate
   *   5. source is real dir/file → migrate contents to target → delete → symlink
   */
  ensureOne(source: string, target: string, type: "dir" | "file"): EnsureResult {
    // Ensure target exists
    if (type === "dir") {
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true });
      }
    } else {
      const targetDir = dirname(target);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      if (!existsSync(target)) {
        Bun.write(target, "");
      }
    }

    // Case 2: source doesn't exist → create symlink
    if (!existsSync(source) && !this._isSymlink(source)) {
      const sourceDir = dirname(source);
      if (!existsSync(sourceDir)) {
        mkdirSync(sourceDir, { recursive: true });
      }
      symlinkSync(target, source);
      this.verified.add(source);
      log.debug(`created ${source} → ${target}`);
      return { action: "created", source, target };
    }

    // Case 3/4: source is a symlink
    if (this._isSymlink(source)) {
      const currentTarget = readlinkSync(source);
      if (currentTarget === target) {
        this.verified.add(source);
        return { action: "ok", source, target };
      }
      // Wrong target — fix
      unlinkSync(source);
      symlinkSync(target, source);
      this.verified.add(source);
      log.info(`fixed ${source} → ${target} (was → ${currentTarget})`);
      return { action: "fixed", source, target };
    }

    // Case 5: source is a real dir/file → migrate
    if (type === "dir") {
      this._migrateDir(source, target);
    } else {
      this._migrateFile(source, target);
    }

    this.verified.add(source);
    return { action: "migrated", source, target };
  }

  /**
   * Scan ~/.claude/projects/ and ensure all project dirs are symlinked to ~/.remi/projects/.
   */
  ensureAllProjects(): EnsureResult[] {
    const results: EnsureResult[] = [];

    if (!existsSync(CLAUDE_PROJECTS)) {
      mkdirSync(CLAUDE_PROJECTS, { recursive: true });
      return results;
    }

    for (const name of readdirSync(CLAUDE_PROJECTS)) {
      const source = join(CLAUDE_PROJECTS, name);

      if (this.verified.has(source)) continue;

      // Only process directories and symlinks
      try {
        const stat = lstatSync(source);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      const target = join(REMI_PROJECTS, name);
      const result = this.ensureOne(source, target, "dir");
      results.push(result);
    }

    // Special: home hash memory/ → ~/.remi/memory/ (personal memory)
    this._ensureHomeMemoryLinks();

    log.info(
      `ensureAllProjects: ${results.length} processed (${results.filter((r) => r.action !== "ok").length} changed)`,
    );

    return results;
  }

  /**
   * Ensure home-hash memory dirs point to ~/.remi/memory/ (personal memory).
   * Home cwd is not a "project" — its memory is the individual knowledge base.
   */
  private _ensureHomeMemoryLinks(): void {
    for (const hash of HOME_HASHES) {
      const memDir = join(REMI_PROJECTS, hash, "memory");
      if (!existsSync(join(REMI_PROJECTS, hash))) continue;

      // Already a symlink → check it points to ~/.remi/memory/
      if (this._isSymlink(memDir)) {
        const target = readlinkSync(memDir);
        if (target === "../../memory" || target === REMI_MEMORY) continue;
      }

      // Real dir → migrate from_*.md to ~/.remi/memory/, then replace
      if (existsSync(memDir) && !this._isSymlink(memDir)) {
        try {
          for (const f of readdirSync(memDir)) {
            if (f.startsWith("from_")) {
              const src = join(memDir, f);
              const dst = join(REMI_MEMORY, f);
              if (!existsSync(dst)) cpSync(src, dst);
            }
          }
          rmSync(memDir, { recursive: true, force: true });
        } catch (e) {
          log.warn(`failed to migrate home memory ${hash}: ${e}`);
          continue;
        }
      }

      // Create symlink
      try {
        mkdirSync(join(REMI_PROJECTS, hash), { recursive: true });
        symlinkSync("../../memory", memDir);
        log.info(`home memory linked: ${hash}/memory/ → ~/.remi/memory/`);
      } catch (e) {
        log.warn(`failed to link home memory ${hash}: ${e}`);
      }
    }
  }

  /**
   * Ensure symlink for a specific cwd (called before CC invocation).
   */
  ensureForCwd(cwd: string): void {
    const hash = this.pathToHash(cwd);
    const source = join(CLAUDE_PROJECTS, hash);

    if (this.verified.has(source)) return;

    const target = join(REMI_PROJECTS, hash);
    this.ensureOne(source, target, "dir");
  }

  /**
   * Ensure global symlinks:
   *   - ~/.claude/CLAUDE.md → ~/.remi/soul.md
   *   - ~/.claude/skills/  → ~/.remi/skills/ (if remi skills dir exists)
   */
  ensureGlobals(): void {
    // soul.md
    this.ensureOne(
      join(CLAUDE_HOME, "CLAUDE.md"),
      join(REMI_HOME, "soul.md"),
      "file",
    );

    // skills/
    const remiSkills = join(REMI_HOME, "skills");
    if (existsSync(remiSkills)) {
      this.ensureOne(
        join(CLAUDE_HOME, "skills"),
        remiSkills,
        "dir",
      );
    }
  }

  /**
   * Ensure wiki symlinks for registered projects (from remi.toml [projects]).
   *
   * For each project:
   *   1. CC project dir → remi project dir
   *   2. {project}/.claude/CLAUDE.md → {remi_project}/wiki/wiki.md
   */
  ensureWikiLinks(projects: Record<string, string>): void {
    for (const [_alias, projectPath] of Object.entries(projects)) {
      const hash = this.pathToHash(projectPath);

      // CC project dir → remi project dir
      this.ensureOne(
        join(CLAUDE_PROJECTS, hash),
        join(REMI_PROJECTS, hash),
        "dir",
      );

      // Wiki: {project}/.claude/CLAUDE.md → {remi}/projects/{hash}/wiki/wiki.md
      this.ensureOne(
        join(projectPath, ".claude", "CLAUDE.md"),
        join(REMI_PROJECTS, hash, "wiki", "wiki.md"),
        "file",
      );
    }
  }

  /**
   * Get status of all managed symlinks (for dashboard API).
   */
  getStatus(): {
    mappings: MappingStatus[];
    stats: { total: number; ok: number; broken: number; notLinked: number };
  } {
    const mappings: MappingStatus[] = [];

    // Collect all known mappings by scanning remi projects
    const pairs = this._collectKnownMappings();

    for (const { source, target, type } of pairs) {
      const status = this._checkStatus(source, target);
      mappings.push({ source, target, type, status });
    }

    const stats = {
      total: mappings.length,
      ok: mappings.filter((m) => m.status === "ok").length,
      broken: mappings.filter((m) => m.status === "broken").length,
      notLinked: mappings.filter((m) => m.status === "not_linked" || m.status === "missing_target").length,
    };

    return { mappings, stats };
  }

  /**
   * Fix all broken/missing symlinks.
   */
  fixAll(): { fixed: number; errors: string[] } {
    let fixed = 0;
    const errors: string[] = [];

    const { mappings } = this.getStatus();

    for (const m of mappings) {
      if (m.status === "ok") continue;

      try {
        const result = this.ensureOne(m.source, m.target, m.type);
        if (result.action !== "ok") {
          fixed++;
        }
      } catch (e) {
        const msg = `failed to fix ${m.source}: ${e}`;
        errors.push(msg);
        log.error(msg);
      }
    }

    log.info(`fixAll: ${fixed} fixed, ${errors.length} errors`);
    return { fixed, errors };
  }

  // ── Private helpers ──────────────────────────────────────────

  /** Migrate a real directory's contents to target, then replace with symlink. */
  private _migrateDir(source: string, target: string): void {
    try {
      for (const item of readdirSync(source)) {
        const srcItem = join(source, item);
        const tgtItem = join(target, item);

        // Skip if target already has this item
        if (existsSync(tgtItem)) continue;
        // Skip symlinks inside the source dir
        if (this._isSymlink(srcItem)) continue;

        try {
          cpSync(srcItem, tgtItem, { recursive: true });
        } catch (e) {
          log.warn(`failed to copy ${srcItem}: ${e}`);
        }
      }

      rmSync(source, { recursive: true, force: true });
      symlinkSync(target, source);
      log.info(`migrated dir ${source} → ${target}`);
    } catch (e) {
      log.error(`migration failed for ${source}: ${e}`);
    }
  }

  /** Migrate a real file to target, then replace with symlink. */
  private _migrateFile(source: string, target: string): void {
    try {
      const sourceFile = Bun.file(source);
      if (sourceFile.size > 0) {
        const targetFile = Bun.file(target);
        if (targetFile.size === 0) {
          cpSync(source, target);
        } else {
          // Backup source content as .migrated
          cpSync(source, source + ".migrated");
        }
      }

      unlinkSync(source);
      symlinkSync(target, source);
      log.info(`migrated file ${source} → ${target}`);
    } catch (e) {
      log.error(`file migration failed for ${source}: ${e}`);
    }
  }

  /** Check if a path is a symlink. */
  private _isSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Check symlink status for a single mapping. */
  private _checkStatus(source: string, target: string): LinkStatus {
    if (!existsSync(target) && !this._isSymlink(target)) {
      return "missing_target";
    }
    if (!this._isSymlink(source)) {
      if (!existsSync(source)) return "not_linked";
      return "not_linked"; // Real dir/file, not a symlink
    }
    const current = readlinkSync(source);
    return current === target ? "ok" : "broken";
  }

  /** Collect all known source→target pairs for status reporting. */
  private _collectKnownMappings(): Array<{ source: string; target: string; type: "dir" | "file" }> {
    const pairs: Array<{ source: string; target: string; type: "dir" | "file" }> = [];

    // Global: CLAUDE.md → soul.md
    pairs.push({
      source: join(CLAUDE_HOME, "CLAUDE.md"),
      target: join(REMI_HOME, "soul.md"),
      type: "file",
    });

    // Global: skills/
    const remiSkills = join(REMI_HOME, "skills");
    if (existsSync(remiSkills)) {
      pairs.push({
        source: join(CLAUDE_HOME, "skills"),
        target: remiSkills,
        type: "dir",
      });
    }

    // Project dirs + internal links
    if (existsSync(REMI_PROJECTS)) {
      for (const name of readdirSync(REMI_PROJECTS)) {
        // Project dir symlink: ~/.claude/projects/{hash}/ → ~/.remi/projects/{hash}/
        pairs.push({
          source: join(CLAUDE_PROJECTS, name),
          target: join(REMI_PROJECTS, name),
          type: "dir",
        });

        // Home hash special: memory/ → ~/.remi/memory/
        if (HOME_HASHES.has(name)) {
          pairs.push({
            source: join(REMI_PROJECTS, name, "memory"),
            target: REMI_MEMORY,
            type: "dir",
          });
        }

        // Wiki links: check if wiki/wiki.md exists
        const wikiFile = join(REMI_PROJECTS, name, "wiki", "wiki.md");
        if (existsSync(wikiFile) || existsSync(join(REMI_PROJECTS, name, "wiki"))) {
          pairs.push({
            source: join(REMI_PROJECTS, name, "wiki", "wiki.md"),
            target: wikiFile,
            type: "file",
          });
        }
      }
    }

    return pairs;
  }
}

/** Singleton instance. */
export const symlinkManager = new SymlinkManager();
