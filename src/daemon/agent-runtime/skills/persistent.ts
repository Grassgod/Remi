/**
 * SkillsService — orchestrates the Skills lifecycle:
 *   install(srcDir) → copy into SSOT(~/.remi/skills/<dir>), record row, hash
 *   enable/disable(id, app)  → symlink/unlink each enabled tool's skills dir
 *   uninstall(id)           → unlink everywhere + wipe SSOT + row
 *
 * Sync is fully driven by DB state: applyAll() ensures every (skill × tool)
 * link reflects the current `enabled_<tool>` flag. Safe by construction —
 * never touches a real, non-hub-owned directory.
 */

import { existsSync, cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AppType, Scope } from "../config-hub/types.js";
import { APP_TYPES } from "../config-hub/types.js";
import type { AdapterRegistry } from "../config-hub/adapters/base.js";
import type { SkillRow, SkillsDao } from "../config-hub/db/dao.js";
import { defaultSkillsSsotDir } from "../config-hub/db/config-hub-db.js";
import {
  ensureSkillLink,
  hashDirectory,
  removeSkillLink,
} from "./sync.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("config-hub");

export interface SkillSyncReport {
  byApp: Partial<Record<AppType, { linked: string[]; unlinked: string[]; errors: string[] }>>;
}

export class SkillsService {
  constructor(
    private readonly dao: SkillsDao,
    private readonly adapters: AdapterRegistry,
    private readonly ssotRoot: string = defaultSkillsSsotDir(),
  ) {}

  // ── Reads ────────────────────────────────────────────────

  list(): SkillRow[] {
    return this.dao.list();
  }

  // ── Lifecycle ────────────────────────────────────────────

  /** Install a skill from a local source directory into the SSOT. */
  installFromDir(opts: {
    id?: string;
    name?: string;
    description?: string;
    sourceDir: string;
    directory?: string;
  }): SkillRow {
    if (!existsSync(opts.sourceDir) || !statSync(opts.sourceDir).isDirectory()) {
      throw new Error(`source must be an existing directory: ${opts.sourceDir}`);
    }
    const directory = opts.directory ?? basename(resolve(opts.sourceDir));
    const target = join(this.ssotRoot, directory);
    mkdirSync(this.ssotRoot, { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(opts.sourceDir, target, { recursive: true });
    const hash = hashDirectory(target);
    const id = opts.id ?? directory;
    const name = opts.name ?? directory;
    this.dao.upsert({ id, name, description: opts.description, directory, contentHash: hash });
    return this.dao.get(id)!;
  }

  setEnabled(id: string, app: AppType, enabled: boolean): SkillSyncReport {
    this.dao.setEnabled(id, app, enabled);
    return this.applyAll(app);
  }

  uninstall(id: string): SkillSyncReport {
    const row = this.dao.get(id);
    if (!row) return { byApp: {} };

    // Remove links from every tool first.
    const report: SkillSyncReport = { byApp: {} };
    for (const app of APP_TYPES) {
      const adapter = this.adapters.get(app);
      if (!adapter || !adapter.skillsDir) continue;
      const skillsDir = adapter.skillsDir({ kind: "global" });
      if (!skillsDir) continue;
      const dest = join(skillsDir, row.directory);
      report.byApp[app] = { linked: [], unlinked: [], errors: [] };
      try {
        removeSkillLink(dest, this.ssotRoot);
        report.byApp[app]!.unlinked.push(row.directory);
      } catch (e: any) {
        report.byApp[app]!.errors.push(`${row.directory}: ${e?.message ?? e}`);
      }
    }

    // Wipe SSOT copy then DB row.
    const ssotPath = join(this.ssotRoot, row.directory);
    if (existsSync(ssotPath)) rmSync(ssotPath, { recursive: true, force: true });
    this.dao.delete(id);
    return report;
  }

  // ── Sync (DB → filesystem) ───────────────────────────────

  applyAll(only?: AppType): SkillSyncReport {
    const skills = this.dao.list();
    const report: SkillSyncReport = { byApp: {} };

    for (const app of APP_TYPES) {
      if (only && app !== only) continue;
      const adapter = this.adapters.get(app);
      if (!adapter || !adapter.skillsDir) continue;
      const targetDir = adapter.skillsDir({ kind: "global" } as Scope);
      if (!targetDir) continue;
      report.byApp[app] = { linked: [], unlinked: [], errors: [] };

      // Skip if the tool isn't even installed (don't create ~/.<tool> ourselves).
      if (!adapter.isPresent({ kind: "global" })) continue;

      for (const skill of skills) {
        const source = join(this.ssotRoot, skill.directory);
        const dest = join(targetDir, skill.directory);
        try {
          if (skill.enabled[app]) {
            if (!existsSync(source)) {
              report.byApp[app]!.errors.push(`${skill.directory}: SSOT missing`);
              continue;
            }
            const result = ensureSkillLink(source, dest);
            if (result !== "noop") report.byApp[app]!.linked.push(skill.directory);
          } else {
            const before = existsSync(dest);
            removeSkillLink(dest, this.ssotRoot);
            if (before) report.byApp[app]!.unlinked.push(skill.directory);
          }
        } catch (e: any) {
          const msg = `${skill.directory}: ${e?.message ?? e}`;
          report.byApp[app]!.errors.push(msg);
          log.warn(`[skills:${app}] ${msg}`);
        }
      }
    }
    return report;
  }
}
