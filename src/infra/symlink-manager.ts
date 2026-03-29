/**
 * SymlinkManager — 3-layer symlink centralization for Remi
 *
 * Layer 1: ~/.claude/projects/{hash} → ~/.remi/projects/{hash}  (project dirs)
 * Layer 2: projects/{hash}/memory    → ~/.remi/memory/[projects/{alias}]  (memory centralization)
 * Layer 3: projects/{hash}/wiki      → ~/.remi/wiki/[projects/{alias}]    (wiki centralization)
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
const REMI_WIKI = join(REMI_HOME, "wiki");

// Home directory hashes — these get special treatment
const HOME_HASH = HOME.replace(/\//g, "-");
const HOME_HASHES = new Set([
  HOME_HASH,
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

export interface MappingStatus {
  source: string;
  target: string;
  type: "dir" | "file";
  status: LinkStatus;
  category: "soul" | "global" | "memory" | "wiki" | "project";
  projectAlias: string | null;
  parentHash: string | null;
}

// ── SymlinkManager ─────────────────────────────────────────────

export class SymlinkManager {
  private verified = new Set<string>();
  private _projects: Record<string, string> = {};

  /** Register known projects (id → cwd mapping). */
  setProjects(projects: Record<string, string>): void {
    this._projects = projects;
  }

  /** Convert a filesystem path to CC's hash format. */
  pathToHash(path: string): string {
    return path.replace(/\//g, "-");
  }

  /**
   * Convert a hash to a readable alias.
   * Priority: remi.toml alias > path-derived name > raw hash.
   * Returns null for home hashes.
   */
  hashToAlias(hash: string): string | null {
    if (HOME_HASHES.has(hash)) return null;
    // Check remi.toml registered projects
    for (const [alias, path] of Object.entries(this._projects)) {
      if (this.pathToHash(path) === hash) return alias;
    }
    // Derive from hash: extract after "-project-"
    const projectMatch = hash.match(/-project-(.+)$/);
    if (projectMatch) return projectMatch[1];
    // Tasks: extract after "-tasks-"
    const tasksMatch = hash.match(/-tasks-(.+)$/);
    if (tasksMatch) return tasksMatch[1];
    return hash;
  }

  /**
   * Register and ensure a single symlink mapping.
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

    // Source doesn't exist → create symlink
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

    // Source is a symlink
    if (this._isSymlink(source)) {
      const currentTarget = readlinkSync(source);
      if (currentTarget === target) {
        this.verified.add(source);
        return { action: "ok", source, target };
      }
      unlinkSync(source);
      symlinkSync(target, source);
      this.verified.add(source);
      log.info(`fixed ${source} → ${target} (was → ${currentTarget})`);
      return { action: "fixed", source, target };
    }

    // Source is a real dir/file → migrate
    if (type === "dir") {
      this._migrateDir(source, target);
    } else {
      this._migrateFile(source, target);
    }

    this.verified.add(source);
    return { action: "migrated", source, target };
  }

  /**
   * Layer 1: Scan ~/.claude/projects/ and ensure all project dirs are symlinked.
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

      try {
        const stat = lstatSync(source);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch { continue; }

      const target = join(REMI_PROJECTS, name);
      const result = this.ensureOne(source, target, "dir");
      results.push(result);
    }

    // Home memory → ~/.remi/memory/
    this._ensureHomeMemoryLinks();

    log.info(
      `ensureAllProjects: ${results.length} processed (${results.filter((r) => r.action !== "ok").length} changed)`,
    );
    return results;
  }

  /** Home memory symlinks → ~/.remi/memory/ */
  private _ensureHomeMemoryLinks(): void {
    for (const hash of HOME_HASHES) {
      const memDir = join(REMI_PROJECTS, hash, "memory");
      if (!existsSync(join(REMI_PROJECTS, hash))) continue;

      if (this._isSymlink(memDir)) {
        const target = readlinkSync(memDir);
        if (target === REMI_MEMORY) continue;
      }

      // Real dir → migrate from_*.md, then replace
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

      try {
        mkdirSync(join(REMI_PROJECTS, hash), { recursive: true });
        symlinkSync(REMI_MEMORY, memDir);
        log.info(`home memory linked: ${hash}/memory/ → ~/.remi/memory/`);
      } catch (e) {
        log.warn(`failed to link home memory ${hash}: ${e}`);
      }
    }
  }

  /** Ensure symlink for a specific cwd. */
  ensureForCwd(cwd: string): void {
    const hash = this.pathToHash(cwd);
    const source = join(CLAUDE_PROJECTS, hash);
    if (this.verified.has(source)) return;
    const target = join(REMI_PROJECTS, hash);
    this.ensureOne(source, target, "dir");
  }

  /** Ensure global symlinks: CLAUDE.md → soul.md, skills/ */
  ensureGlobals(): void {
    this.ensureOne(join(CLAUDE_HOME, "CLAUDE.md"), join(REMI_HOME, "soul.md"), "file");

    const remiSkills = join(REMI_HOME, "skills");
    if (existsSync(remiSkills)) {
      this.ensureOne(join(CLAUDE_HOME, "skills"), remiSkills, "dir");
    }
  }

  /**
   * Layer 2: Project memory centralization.
   * projects/{hash}/memory → ~/.remi/memory/projects/{alias}
   */
  ensureProjectMemoryLinks(): void {
    mkdirSync(join(REMI_MEMORY, "projects"), { recursive: true });

    if (!existsSync(REMI_PROJECTS)) return;

    for (const name of readdirSync(REMI_PROJECTS)) {
      if (HOME_HASHES.has(name)) continue; // home handled separately

      const projectDir = join(REMI_PROJECTS, name);
      try {
        const stat = lstatSync(projectDir);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch { continue; }

      const memDir = join(projectDir, "memory");
      const alias = this.hashToAlias(name);
      if (!alias) continue;

      const centralTarget = join(REMI_MEMORY, "projects", alias);

      // Already correct symlink → skip
      if (this._isSymlink(memDir)) {
        const current = readlinkSync(memDir);
        if (current === centralTarget) continue;
        // Don't touch home memory symlinks
        if (current === REMI_MEMORY || current === "../../memory") continue;
        unlinkSync(memDir);
      }

      // Real directory → migrate, then symlink
      if (existsSync(memDir) && !this._isSymlink(memDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          for (const item of readdirSync(memDir)) {
            const src = join(memDir, item);
            const dst = join(centralTarget, item);
            if (!existsSync(dst) && !this._isSymlink(src)) {
              cpSync(src, dst, { recursive: true });
            }
          }
          rmSync(memDir, { recursive: true, force: true });
        } catch (e) {
          log.warn(`failed to migrate memory ${name}: ${e}`);
          continue;
        }
      }

      // Create symlink
      if (!existsSync(memDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          symlinkSync(centralTarget, memDir);
          log.info(`memory linked: ${name}/memory/ → ${centralTarget}`);
        } catch (e) {
          log.warn(`failed to link memory ${name}: ${e}`);
        }
      }
    }
  }

  /**
   * Layer 3: Wiki centralization.
   * Home: projects/{home}/wiki → ~/.remi/wiki
   * Projects: projects/{hash}/wiki → ~/.remi/wiki/projects/{alias}
   */
  ensureWikiCentralization(): void {
    mkdirSync(REMI_WIKI, { recursive: true });
    mkdirSync(join(REMI_WIKI, "projects"), { recursive: true });

    if (!existsSync(REMI_PROJECTS)) return;

    for (const name of readdirSync(REMI_PROJECTS)) {
      const projectDir = join(REMI_PROJECTS, name);
      try {
        const stat = lstatSync(projectDir);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch { continue; }

      const wikiDir = join(projectDir, "wiki");
      const isHome = HOME_HASHES.has(name);
      const alias = this.hashToAlias(name);

      const centralTarget = isHome ? REMI_WIKI : alias ? join(REMI_WIKI, "projects", alias) : null;
      if (!centralTarget) continue;

      // Already correct symlink → skip
      if (this._isSymlink(wikiDir)) {
        const current = readlinkSync(wikiDir);
        if (current === centralTarget) continue;
        unlinkSync(wikiDir);
      }

      // Real directory → migrate content, then symlink
      if (existsSync(wikiDir) && !this._isSymlink(wikiDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          for (const item of readdirSync(wikiDir)) {
            if (item === "wiki.md") continue; // skip broken wiki.md
            const src = join(wikiDir, item);
            const dst = join(centralTarget, item);
            if (!existsSync(dst) && !this._isSymlink(src)) {
              cpSync(src, dst, { recursive: true });
            }
          }
          rmSync(wikiDir, { recursive: true, force: true });
        } catch (e) {
          log.warn(`failed to migrate wiki ${name}: ${e}`);
          continue;
        }
      }

      // Create symlink
      if (!existsSync(wikiDir)) {
        mkdirSync(centralTarget, { recursive: true });
        try {
          symlinkSync(centralTarget, wikiDir);
          log.info(`wiki linked: ${name}/wiki/ → ${centralTarget}`);
        } catch (e) {
          log.warn(`failed to link wiki ${name}: ${e}`);
        }
      }
    }
  }

  /** Get status of all managed symlinks (for dashboard API). */
  getStatus(): {
    mappings: MappingStatus[];
    stats: { total: number; ok: number; broken: number; notLinked: number };
  } {
    const pairs = this._collectKnownMappings();
    const mappings: MappingStatus[] = [];

    for (const pair of pairs) {
      const status = this._checkStatus(pair.source, pair.target);
      mappings.push({ ...pair, status });
    }

    const stats = {
      total: mappings.length,
      ok: mappings.filter((m) => m.status === "ok").length,
      broken: mappings.filter((m) => m.status === "broken").length,
      notLinked: mappings.filter((m) => m.status === "not_linked" || m.status === "missing_target").length,
    };

    return { mappings, stats };
  }

  /** Fix all broken/missing symlinks. */
  fixAll(): { fixed: number; errors: string[] } {
    let fixed = 0;
    const errors: string[] = [];

    const { mappings } = this.getStatus();
    for (const m of mappings) {
      if (m.status === "ok") continue;
      try {
        const result = this.ensureOne(m.source, m.target, m.type);
        if (result.action !== "ok") fixed++;
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

  private _migrateDir(source: string, target: string): void {
    try {
      for (const item of readdirSync(source)) {
        const srcItem = join(source, item);
        const tgtItem = join(target, item);
        if (existsSync(tgtItem)) continue;
        if (this._isSymlink(srcItem)) continue;
        try { cpSync(srcItem, tgtItem, { recursive: true }); } catch (e) { log.warn(`failed to copy ${srcItem}: ${e}`); }
      }
      rmSync(source, { recursive: true, force: true });
      symlinkSync(target, source);
      log.info(`migrated dir ${source} → ${target}`);
    } catch (e) {
      log.error(`migration failed for ${source}: ${e}`);
    }
  }

  private _migrateFile(source: string, target: string): void {
    try {
      const sourceFile = Bun.file(source);
      if (sourceFile.size > 0) {
        const targetFile = Bun.file(target);
        if (targetFile.size === 0) cpSync(source, target);
        else cpSync(source, source + ".migrated");
      }
      unlinkSync(source);
      symlinkSync(target, source);
      log.info(`migrated file ${source} → ${target}`);
    } catch (e) {
      log.error(`file migration failed for ${source}: ${e}`);
    }
  }

  private _isSymlink(path: string): boolean {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
  }

  private _checkStatus(source: string, target: string): LinkStatus {
    if (!existsSync(target) && !this._isSymlink(target)) return "missing_target";
    if (!this._isSymlink(source)) {
      if (!existsSync(source)) return "not_linked";
      return "not_linked";
    }
    const current = readlinkSync(source);
    return current === target ? "ok" : "broken";
  }

  /** Collect all known mappings with category metadata. */
  private _collectKnownMappings(): Array<Omit<MappingStatus, "status">> {
    const pairs: Array<Omit<MappingStatus, "status">> = [];

    // Soul
    pairs.push({
      source: join(CLAUDE_HOME, "CLAUDE.md"),
      target: join(REMI_HOME, "soul.md"),
      type: "file",
      category: "soul",
      projectAlias: null,
      parentHash: null,
    });

    // Project dirs + sub-mappings
    if (existsSync(REMI_PROJECTS)) {
      for (const name of readdirSync(REMI_PROJECTS)) {
        const isHome = HOME_HASHES.has(name);
        const alias = this.hashToAlias(name);

        // Project/Global dir mapping
        pairs.push({
          source: join(CLAUDE_PROJECTS, name),
          target: join(REMI_PROJECTS, name),
          type: "dir",
          category: isHome ? "global" : "project",
          projectAlias: isHome ? "~ (home)" : alias,
          parentHash: null,
        });

        // Memory sub-mapping
        const memDir = join(REMI_PROJECTS, name, "memory");
        if (existsSync(memDir) || this._isSymlink(memDir)) {
          const memTarget = isHome
            ? REMI_MEMORY
            : alias ? join(REMI_MEMORY, "projects", alias) : null;
          if (memTarget) {
            pairs.push({
              source: memDir,
              target: memTarget,
              type: "dir",
              category: "memory",
              projectAlias: isHome ? "~ (home)" : alias,
              parentHash: name,
            });
          }
        }

        // Wiki sub-mapping
        const wikiDir = join(REMI_PROJECTS, name, "wiki");
        if (existsSync(wikiDir) || this._isSymlink(wikiDir)) {
          const wikiTarget = isHome
            ? REMI_WIKI
            : alias ? join(REMI_WIKI, "projects", alias) : null;
          if (wikiTarget) {
            pairs.push({
              source: wikiDir,
              target: wikiTarget,
              type: "dir",
              category: "wiki",
              projectAlias: isHome ? "~ (home)" : alias,
              parentHash: name,
            });
          }
        }
      }
    }

    return pairs;
  }
}

/** Singleton instance. */
export const symlinkManager = new SymlinkManager();
