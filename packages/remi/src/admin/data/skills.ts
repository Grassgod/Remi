/**
 * RemiData — Skills.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import { ProjectStore } from "../../project/store.js";
import { RemiDataContext } from "./context.js";

export class SkillsData {
  constructor(private readonly ctx: RemiDataContext) {}

  private get skillsDir(): string {
    return join(homedir(), ".remi", ".claude", "skills");
  }

  private _resolveSkillsDir(scope?: string): string {
    if (!scope || scope === "remi-global") return this.skillsDir;
    if (scope === "claude-global") return join(homedir(), ".claude", "skills");
    if (scope === "pipeline") return join(__dirname, "..", "pipeline", "skills");
    if (scope.startsWith("project:")) {
      const projectId = scope.slice("project:".length);
      const { ProjectStore } = require("../../project/store.js");
      const pStore = new ProjectStore();
      const projects = pStore.list();
      const proj = projects.find((p: any) => p.id === projectId);
      if (proj?.cwd) return join(proj.cwd, ".claude", "skills");
    }
    return this.skillsDir;
  }

  listSkillScopes(): Array<{ scope: string; label: string; path: string; count: number }> {
    const scopes: Array<{ scope: string; label: string; path: string; count: number }> = [];

    // Claude global
    const claudeDir = join(homedir(), ".claude", "skills");
    if (existsSync(claudeDir)) {
      const count = readdirSync(claudeDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).length;
      if (count > 0) scopes.push({ scope: "claude-global", label: "Claude Global", path: claudeDir, count });
    }

    // Remi global
    const remiDir = this.skillsDir;
    if (existsSync(remiDir)) {
      const count = readdirSync(remiDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).length;
      if (count > 0) scopes.push({ scope: "remi-global", label: "Remi Global", path: remiDir, count });
    }

    // Pipeline skills (shipped with Remi source code)
    const pipelineDir = join(__dirname, "..", "pipeline", "skills");
    if (existsSync(pipelineDir)) {
      const count = readdirSync(pipelineDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).length;
      if (count > 0) scopes.push({ scope: "pipeline", label: "Pipeline", path: pipelineDir, count });
    }

    // Project scopes
    const { ProjectStore } = require("../../project/store.js");
    const pStore = new ProjectStore();
    for (const p of pStore.list()) {
      if (!p.cwd) continue;
      const projSkillsDir = join(p.cwd, ".claude", "skills");
      if (!existsSync(projSkillsDir)) continue;
      const count = readdirSync(projSkillsDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).length;
      if (count > 0) {
        scopes.push({ scope: `project:${p.id}`, label: p.name || p.id, path: projSkillsDir, count });
      }
    }

    return scopes;
  }

  listSkills(scope?: string): Array<{
    name: string; description: string; hasSchedule: boolean;
    cron?: string; outputDir?: string; reportCount?: number; lastReportDate?: string;
  }> {
    const dir = this._resolveSkillsDir(scope);
    if (!existsSync(dir)) return [];

    const cronJobs = this.ctx._loadCronJobs();
    const cronMap = new Map<string, { cron?: string; outputDir?: string }>();
    for (const job of cronJobs) {
      if (job.handler === "skill:run" && job.handlerConfig?.skillName) {
        cronMap.set(job.handlerConfig.skillName as string, {
          cron: job.cron,
          outputDir: job.handlerConfig.outputDir as string | undefined,
        });
      }
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map(e => {
        const name = e.name;
        const skillMd = join(dir, name, "SKILL.md");
        let description = "";
        if (existsSync(skillMd)) {
          try {
            const { data } = matter(readFileSync(skillMd, "utf-8"));
            description = (data.description as string) ?? "";
          } catch {}
        }

        const cronInfo = cronMap.get(name);
        let reportCount = 0;
        let lastReportDate: string | undefined;
        if (cronInfo?.outputDir && existsSync(cronInfo.outputDir)) {
          const reports = readdirSync(cronInfo.outputDir)
            .filter(f => f.endsWith(".md"))
            .sort()
            .reverse();
          reportCount = reports.length;
          if (reports[0]) lastReportDate = reports[0].replace(".md", "");
        }

        return {
          name,
          description,
          hasSchedule: cronMap.has(name),
          cron: cronInfo?.cron,
          outputDir: cronInfo?.outputDir,
          reportCount,
          lastReportDate,
        };
      })
      .sort((a, b) => {
        if (a.hasSchedule !== b.hasSchedule) return a.hasSchedule ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  getSkillTree(name: string, scope?: string): { name: string; path: string; type: "file" | "directory"; children?: any[] }[] | null {
    const dir = join(this._resolveSkillsDir(scope), name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    return this._scanSkillDir(dir, "");
  }

  private _scanSkillDir(dir: string, prefix: string): { name: string; path: string; type: "file" | "directory"; children?: any[] }[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const result: { name: string; path: string; type: "file" | "directory"; children?: any[] }[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: entryPath,
          type: "directory",
          children: this._scanSkillDir(join(dir, entry.name), entryPath),
        });
      } else {
        result.push({ name: entry.name, path: entryPath, type: "file" });
      }
    }
    // Sort: directories first, then files; SKILL.md always first among files
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      return a.name.localeCompare(b.name);
    });
  }

  getSkillsBasePath(scope?: string): string {
    return this._resolveSkillsDir(scope);
  }

  readSkillFile(name: string, path = "SKILL.md", scope?: string): string | null {
    if (path.includes("..") || path.startsWith("/")) return null;
    const filePath = join(this._resolveSkillsDir(scope), name, path);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    return readFileSync(filePath, "utf-8");
  }

  writeSkillFile(name: string, content: string, path = "SKILL.md", scope?: string): boolean {
    if (path.includes("..") || path.startsWith("/")) return false;
    const filePath = join(this._resolveSkillsDir(scope), name, path);
    if (!existsSync(filePath)) return false;
    this.ctx._backup(filePath);
    writeFileSync(filePath, content, "utf-8");
    return true;
  }

  listSkillReports(name: string, scope?: string): string[] {
    const skills = this.listSkills(scope);
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir || !existsSync(skill.outputDir)) return [];
    return readdirSync(skill.outputDir)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""))
      .sort()
      .reverse();
  }

  readSkillReport(name: string, date: string, scope?: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const skills = this.listSkills(scope);
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir) return null;
    const filePath = join(skill.outputDir, `${date}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }
}
