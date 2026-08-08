/**
 * RemiData — Memory: entities and project-level memories.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { ProjectStore } from "../../project/store.js";
import type { EntitySummary, EntityDetail } from "./types.js";
import { RemiDataContext } from "./context.js";

export class MemoryEntitiesData {
  constructor(private readonly ctx: RemiDataContext) {}

  listEntities(): EntitySummary[] {
    const entitiesDir = join(this.ctx.memoryDir, "entities");
    const results: EntitySummary[] = [];

    // 1. Scan entities/{type}/*.md
    if (existsSync(entitiesDir)) {
      for (const typeDir of readdirSync(entitiesDir)) {
        const typePath = join(entitiesDir, typeDir);
        if (!statSync(typePath).isDirectory()) continue;

        for (const file of readdirSync(typePath)) {
          if (!file.endsWith(".md")) continue;
          try {
            const fullPath = join(typePath, file);
            const raw = readFileSync(fullPath, "utf-8");
            const { data } = matter(raw);
            results.push({
              type: data.type ?? typeDir,
              name: data.name ?? basename(file, ".md"),
              tags: data.tags ?? [],
              summary: data.summary ?? "",
              aliases: data.aliases ?? [],
              related: data.related ?? [],
              path: `${typeDir}/${file}`,
              updatedAt: data.updated ?? data.created ?? "",
            });
          } catch {
            // skip malformed files
          }
        }
      }
    }

    // 2. Scan loose *.md files in memory root (feedback_*, from_*, etc.)
    const SKIP_ROOT = new Set(["MEMORY.md", "claude-bridge.md", ".bridge-snapshot", ".conversation_summary.md"]);
    for (const file of readdirSync(this.ctx.memoryDir)) {
      if (!file.endsWith(".md") || SKIP_ROOT.has(file) || file.startsWith(".")) continue;
      const fullPath = join(this.ctx.memoryDir, file);
      if (!statSync(fullPath).isFile()) continue;
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const { data } = matter(raw);
        if (!data.type && !data.name) continue; // skip files without frontmatter
        // Override type for loose files: from_* are archives, not projects
        let looseType = data.type ?? "note";
        if (file.startsWith("from_")) looseType = "archive";
        results.push({
          type: looseType,
          name: data.name ?? basename(file, ".md"),
          tags: data.tags ?? [],
          summary: data.description ?? data.summary ?? "",
          aliases: data.aliases ?? [],
          related: data.related ?? [],
          path: `_root/${file}`,
          updatedAt: data.updated ?? data.created ?? "",
        });
      } catch { /* skip */ }
    }

    return results;
  }

  listProjectMemories(): Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    hasMemoryMd: boolean;
    memoryMdSize: number;
    files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
  }> {
    const projectsMemoryDir = join(this.ctx.memoryDir, "projects");
    if (!existsSync(projectsMemoryDir)) return [];

    // Resolve alias → cwd from DB so we can show the source path in the UI
    const aliasToCwd = new Map<string, string>();
    try {
      for (const p of new ProjectStore().list()) {
        if (p.cwd) aliasToCwd.set(p.id, p.cwd);
      }
    } catch { /* DB unavailable — projectPath stays empty */ }

    const results: Array<{
      projectId: string;
      projectName: string;
      projectPath: string;
      hasMemoryMd: boolean;
      memoryMdSize: number;
      files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
    }> = [];

    for (const alias of readdirSync(projectsMemoryDir)) {
      const memoryDir = join(projectsMemoryDir, alias);
      if (!statSync(memoryDir).isDirectory()) continue;

      const memoryMdPath = join(memoryDir, "MEMORY.md");
      const hasMemoryMd = existsSync(memoryMdPath);
      const memoryMdSize = hasMemoryMd ? statSync(memoryMdPath).size : 0;

      const files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }> = [];
      const scanDir = (dir: string, prefix: string) => {
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          if (f.startsWith(".")) continue;
          const fp = join(dir, f);
          const st = statSync(fp);
          if (st.isDirectory()) {
            scanDir(fp, `${prefix}${f}/`);
          } else if (f.endsWith(".md")) {
            try {
              const raw = readFileSync(fp, "utf-8");
              const { data } = matter(raw);
              files.push({
                name: data.name ?? basename(f, ".md"),
                type: data.type ?? (f === "MEMORY.md" ? "memory" : "note"),
                summary: data.description ?? data.summary ?? "",
                path: `${prefix}${f}`,
                updatedAt: data.updated ?? "",
              });
            } catch {
              files.push({
                name: basename(f, ".md"),
                type: f === "MEMORY.md" ? "memory" : "note",
                summary: "",
                path: `${prefix}${f}`,
                updatedAt: "",
              });
            }
          }
        }
      };
      scanDir(memoryDir, "");

      if (files.length > 0 || hasMemoryMd) {
        results.push({
          projectId: alias,
          projectName: alias,
          projectPath: aliasToCwd.get(alias) ?? "",
          hasMemoryMd,
          memoryMdSize,
          files,
        });
      }
    }

    return results.sort((a, b) => b.files.length - a.files.length);
  }

  readProjectMemoryFile(projectId: string, filePath: string): string {
    const fp = join(this.ctx.memoryDir, "projects", projectId, filePath);
    return existsSync(fp) ? readFileSync(fp, "utf-8") : "";
  }

  readEntity(type: string, name: string): EntityDetail | null {
    // Try loose root files first (feedback, archive, note types from _root/)
    const filePath = this._findEntityFile(type, name) ?? this._findLooseFile(name);
    if (!filePath || !existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { data, content: body } = matter(raw);
    const entitiesDir = join(this.ctx.memoryDir, "entities");

    // Use the requested type (which may have been overridden during listing)
    // e.g. from_* files have frontmatter type=project but are listed as archive
    const isLooseFile = filePath.startsWith(this.ctx.memoryDir + "/") && !filePath.includes("/entities/");
    const effectiveType = isLooseFile ? type : (data.type ?? type);

    return {
      type: effectiveType,
      name: data.name ?? name,
      tags: data.tags ?? [],
      summary: data.summary ?? "",
      aliases: data.aliases ?? [],
      related: data.related ?? [],
      path: filePath.replace(entitiesDir + "/", ""),
      updatedAt: data.updated ?? "",
      createdAt: data.created ?? "",
      content: raw,
      body: body.trim(),
      metadata: data,
    };
  }

  createEntity(opts: { type: string; name: string; observation?: string; tags?: string[]; summary?: string }): void {
    const typeDir = join(this.ctx.memoryDir, "entities", pluralize(opts.type));
    if (!existsSync(typeDir)) mkdirSync(typeDir, { recursive: true });

    const slug = opts.name.replace(/[^\w\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-");
    let filePath = join(typeDir, `${slug}.md`);
    let i = 2;
    while (existsSync(filePath)) {
      filePath = join(typeDir, `${slug}-${i}.md`);
      i++;
    }

    const now = isoNow();
    const frontmatter = {
      type: opts.type,
      name: opts.name,
      created: now,
      updated: now,
      tags: opts.tags ?? [],
      source: "user-explicit",
      summary: opts.summary ?? "",
      aliases: [],
      related: [],
    };

    let body = `\n# ${opts.name}\n`;
    if (opts.observation) {
      const date = new Date().toISOString().split("T")[0];
      body += `\n## 备注\n- [${date}] ${opts.observation}\n`;
    }

    writeFileSync(filePath, matter.stringify(body, frontmatter), "utf-8");
  }

  updateEntity(type: string, name: string, content: string): boolean {
    const filePath = this._findEntityFile(type, name);
    if (!filePath) return false;

    this.ctx._backup(filePath);

    // Update the "updated" timestamp in frontmatter
    const { data, content: body } = matter(content);
    data.updated = isoNow();
    writeFileSync(filePath, matter.stringify(body, data), "utf-8");
    return true;
  }

  deleteEntity(type: string, name: string): boolean {
    const filePath = this._findEntityFile(type, name);
    if (!filePath || !existsSync(filePath)) return false;

    this.ctx._backup(filePath);
    unlinkSync(filePath);
    return true;
  }

  private _findEntityFile(type: string, name: string): string | null {
    const typeDir = join(this.ctx.memoryDir, "entities", pluralize(type));
    if (!existsSync(typeDir)) return null;

    // Try direct slug match
    const slug = name.replace(/[^\w\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-");
    const direct = join(typeDir, `${slug}.md`);
    if (existsSync(direct)) return direct;

    // Scan files and match by frontmatter name
    for (const file of readdirSync(typeDir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(typeDir, file), "utf-8");
        const { data } = matter(raw);
        if (data.name === name) return join(typeDir, file);
        if (data.aliases?.includes(name)) return join(typeDir, file);
      } catch { /* skip */ }
    }
    return null;
  }

  private _findLooseFile(name: string): string | null {
    // Search loose *.md files in memory root by frontmatter name
    for (const file of readdirSync(this.ctx.memoryDir)) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;
      const fp = join(this.ctx.memoryDir, file);
      if (!statSync(fp).isFile()) continue;
      try {
        const { data } = matter(readFileSync(fp, "utf-8"));
        if (data.name === name) return fp;
      } catch { /* skip */ }
    }
    return null;
  }
}

function pluralize(type: string): string {
  if (type === "person") return "people";
  if (type === "child") return "children";
  return type + "s";
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}
