/**
 * ConfigManager — symlink-based config management (CLAUDE.md → soul.md,
 * projects/). Cross-tool MCP/Skills/Prompts sync now lives in the
 * `config-hub` plugin (src/plugins/config-hub), so the cc-switch CLI shell-out
 * is gone from here.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";

const log = createLogger("config");

// ── Constants ──────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_HOME = join(HOME, ".claude");
const REMI_HOME = join(HOME, ".remi");

const CLAUDE_PROJECTS = join(CLAUDE_HOME, "projects");
const REMI_PROJECTS = join(REMI_HOME, "projects");

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
  category: "soul" | "global" | "project";
  projectAlias: string | null;
  parentHash: string | null;
}

// ── ConfigManager ──────────────────────────────────────────────

export class ConfigManager {
  private verified = new Set<string>();

  // ── Symlink methods (unchanged from SymlinkManager) ──────────

  ensureOne(source: string, target: string, type: "dir" | "file"): EnsureResult {
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

    if (type === "dir") {
      this._migrateDir(source, target);
    } else {
      this._migrateFile(source, target);
    }

    this.verified.add(source);
    return { action: "migrated", source, target };
  }

  ensureProjectsRoot(): EnsureResult {
    if (this.verified.has(CLAUDE_PROJECTS)) {
      return { action: "ok", source: CLAUDE_PROJECTS, target: REMI_PROJECTS };
    }

    if (!existsSync(REMI_PROJECTS)) {
      mkdirSync(REMI_PROJECTS, { recursive: true });
    }

    if (!existsSync(CLAUDE_PROJECTS) && !this._isSymlink(CLAUDE_PROJECTS)) {
      mkdirSync(CLAUDE_HOME, { recursive: true });
      symlinkSync(REMI_PROJECTS, CLAUDE_PROJECTS);
      this.verified.add(CLAUDE_PROJECTS);
      log.info(`created ${CLAUDE_PROJECTS} → ${REMI_PROJECTS}`);
      return { action: "created", source: CLAUDE_PROJECTS, target: REMI_PROJECTS };
    }

    if (this._isSymlink(CLAUDE_PROJECTS)) {
      const currentTarget = readlinkSync(CLAUDE_PROJECTS);
      if (currentTarget === REMI_PROJECTS) {
        this.verified.add(CLAUDE_PROJECTS);
        return { action: "ok", source: CLAUDE_PROJECTS, target: REMI_PROJECTS };
      }
      log.warn(
        `${CLAUDE_PROJECTS} is a symlink to ${currentTarget}, expected ${REMI_PROJECTS} — leaving alone`,
      );
      return { action: "wrong-target", source: CLAUDE_PROJECTS, target: REMI_PROJECTS };
    }

    log.warn(
      `${CLAUDE_PROJECTS} is a real directory; refusing to convert to symlink (would lose data). ` +
        `Migrate manually: move contents into ${REMI_PROJECTS}, rmdir ${CLAUDE_PROJECTS}, then restart.`,
    );
    return { action: "needs-migration", source: CLAUDE_PROJECTS, target: REMI_PROJECTS };
  }

  ensureAllProjects(): EnsureResult[] {
    return [this.ensureProjectsRoot()];
  }

  ensureForCwd(_cwd: string): void {
    this.ensureProjectsRoot();
  }

  ensureGlobals(): void {
    this.ensureOne(join(CLAUDE_HOME, "CLAUDE.md"), join(REMI_HOME, "soul.md"), "file");

    const remiSkills = join(REMI_HOME, "skills");
    if (existsSync(remiSkills)) {
      this.ensureOne(join(CLAUDE_HOME, "skills"), remiSkills, "dir");
    }
  }

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

  async syncAll(): Promise<void> {
    this.ensureGlobals();
    this.ensureProjectsRoot();
    // Cross-tool config sync now happens in the config-hub plugin.
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

  private _collectKnownMappings(): Array<Omit<MappingStatus, "status">> {
    return [
      {
        source: join(CLAUDE_HOME, "CLAUDE.md"),
        target: join(REMI_HOME, "soul.md"),
        type: "file",
        category: "soul",
        projectAlias: null,
        parentHash: null,
      },
      {
        source: CLAUDE_PROJECTS,
        target: REMI_PROJECTS,
        type: "dir",
        category: "global",
        projectAlias: "projects (root)",
        parentHash: null,
      },
    ];
  }
}

/** Singleton instance. */
export const configManager = new ConfigManager();

/** Backward-compatible alias. */
export const symlinkManager = configManager;

/** Re-export SymlinkManager as alias for ConfigManager. */
export { ConfigManager as SymlinkManager };
