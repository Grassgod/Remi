/**
 * MemoryStore — entity CRUD plus the path/rendering helpers it needs.
 *
 * Moved verbatim out of `memory/store.ts`; `MemoryStore` delegates here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "@shared/logger.js";
import { EntityIndex } from "./entity-index.js";
import { MemoryFiles } from "./files.js";

const log = createLogger("memory");

const PLURAL_MAP: Record<string, string> = {
  person: "people",
  child: "children",
};
export class MemoryEntities {
  constructor(
    readonly root: string,
    private readonly index: EntityIndex,
    private readonly files: MemoryFiles,
  ) {}

  _typeToDir(typeName: string): string {
    const t = typeName.toLowerCase();
    if (t in PLURAL_MAP) return PLURAL_MAP[t];
    return t + "s";
  }

  _slugify(name: string): string {
    let slug = name.replace(/[<>:"/\\|?*\n\r\t]/g, "");
    slug = slug.trim().replace(/ /g, "-");
    return slug || "unnamed";
  }

  _resolveEntityPath(entity: string, type: string, baseDir: string): string {
    const typeDir = join(baseDir, this._typeToDir(type));
    if (!existsSync(typeDir)) {
      mkdirSync(typeDir, { recursive: true });
    }
    const slug = this._slugify(entity);

    // Check existing files whose name field matches
    const pattern = `${slug}`;
    for (const file of readdirSync(typeDir)) {
      if (file.startsWith(pattern) && file.endsWith(".md")) {
        const fullPath = join(typeDir, file);
        const meta = this.index._parseFrontmatter(fullPath);
        if (meta.name === entity) {
          return fullPath;
        }
      }
    }

    // Generate new path, handle collision
    let path = join(typeDir, `${slug}.md`);
    let counter = 2;
    while (existsSync(path)) {
      path = join(typeDir, `${slug}-${counter}.md`);
      counter++;
    }
    return path;
  }

  _renderNewEntity(
    entity: string,
    type: string,
    observation: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): string {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    return (
      `---\n` +
      `type: ${type}\n` +
      `name: ${entity}\n` +
      `created: ${ts}\n` +
      `updated: ${ts}\n` +
      `tags: []\n` +
      `source: ${source}\n` +
      `summary: ""\n` +
      `aliases: []\n` +
      `related: []\n` +
      `importance: 0.5\n` +
      `last_accessed: ${ts.slice(0, 10)}\n` +
      `access_count: 0\n` +
      `---\n\n` +
      `# ${entity}\n\n` +
      `## 备注\n` +
      `- [${ts.slice(0, 10)}] ${observation}\n`
    );
  }

  _appendObservation(path: string, observation: string): void {
    let content = readFileSync(path, "utf-8");
    const ts = new Date().toISOString().slice(0, 10);
    const entry = `\n- [${ts}] ${observation}`;

    if (content.includes("## 备注")) {
      content = content.replace("## 备注", `## 备注${entry}`);
    } else {
      content += `\n\n## 备注${entry}`;
    }

    writeFileSync(path, content, "utf-8");
  }

  _updateFrontmatterTimestamp(path: string): void {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    let content = readFileSync(path, "utf-8");
    content = content.replace(/^updated:.*$/m, `updated: ${ts}`);
    writeFileSync(path, content, "utf-8");
  }

  createEntity(
    name: string,
    type: string,
    content: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): void {
    const baseDir = join(this.root, "entities");
    const path = this._resolveEntityPath(name, type, baseDir);
    if (existsSync(path)) {
      log.warn(`Entity ${name} already exists at ${path}`);
      return;
    }
    const rendered = this._renderNewEntity(name, type, content, source);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, rendered, "utf-8");
    this.index._invalidateIndex(path);
  }

  updateEntity(name: string, content: string): void {
    const path = this.index._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for update`);
      return;
    }
    this.files._backup(path);
    writeFileSync(path, content, "utf-8");
    this._updateFrontmatterTimestamp(path);
    this.index._invalidateIndex(path);
  }

  appendObservation(name: string, observation: string): void {
    const path = this.index._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for observation`);
      return;
    }
    this.files._backup(path);
    this._appendObservation(path, observation);
    this._updateFrontmatterTimestamp(path);
    this.index._invalidateIndex(path);
  }

  patchProjectMemory(
    projectPath: string,
    section: string,
    content: string,
    mode: "append" | "overwrite" = "append",
  ): void {
    const memoryFile = join(projectPath, ".remi", "memory.md");
    if (!existsSync(memoryFile)) {
      log.warn(`Project memory not found: ${memoryFile}`);
      return;
    }

    this.files._backup(memoryFile);
    let text = readFileSync(memoryFile, "utf-8");

    const sectionHeader = `## ${section}`;
    if (text.includes(sectionHeader)) {
      const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(## ${escapedSection}\n)(.*?)(?=\n## |$)`, "s");
      const match = text.match(pattern);
      if (match) {
        let replacement: string;
        if (mode === "overwrite") {
          replacement = `${sectionHeader}\n${content}\n`;
        } else {
          const existing = match[2].trimEnd();
          replacement = `${sectionHeader}\n${existing}\n${content}\n`;
        }
        text = text.slice(0, match.index!) + replacement + text.slice(match.index! + match[0].length);
      }
    } else {
      text = text.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
    }

    writeFileSync(memoryFile, text, "utf-8");
  }

  deleteEntity(name: string): void {
    const path = this.index._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for deletion`);
      return;
    }
    this.files._backup(path);
    unlinkSync(path);
    this.index._index.delete(path);
  }
}
