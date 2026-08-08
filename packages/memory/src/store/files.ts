/**
 * MemoryStore — MEMORY.md, daily logs, and the `.versions/` backup + retention
 * file management.
 *
 * Moved verbatim out of `memory/store.ts`; `MemoryStore` delegates here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "@shared/logger.js";
import { backupFile, MEMORY_VERSION_RETENTION } from "./versions.js";

const log = createLogger("memory");

export class MemoryFiles {
  constructor(readonly root: string) {}

  _backup(path: string): void {
    backupFile(this.root, path, { keep: MEMORY_VERSION_RETENTION });
  }

  get memoryFile(): string {
    return join(this.root, "MEMORY.md");
  }

  readMemory(): string {
    if (existsSync(this.memoryFile)) {
      return readFileSync(this.memoryFile, "utf-8");
    }
    return "";
  }

  writeMemory(content: string): void {
    this._backup(this.memoryFile);
    writeFileSync(this.memoryFile, content, "utf-8");
  }

  appendMemory(entry: string): void {
    this._backup(this.memoryFile);
    appendFileSync(this.memoryFile, `\n${entry.trimEnd()}\n`, "utf-8");
  }

  _dailyPath(date?: string | null): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    return join(this.root, "daily", `${d}.md`);
  }

  readDaily(date?: string | null): string {
    const path = this._dailyPath(date);
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
    return "";
  }

  appendDaily(entry: string, date?: string | null): void {
    const path = this._dailyPath(date);
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(path) || statSync(path).size === 0) {
      const d = date ?? now.toISOString().slice(0, 10);
      writeFileSync(path, `# ${d}\n\n`, "utf-8");
    }
    appendFileSync(path, `- [${timestamp}] ${entry.trimEnd()}\n`, "utf-8");
  }

  cleanupOldDailies(keepDays: number = 30): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const dailyDir = join(this.root, "daily");
    if (!existsSync(dailyDir)) return 0;

    for (const file of readdirSync(dailyDir)) {
      if (!file.endsWith(".md")) continue;
      const stem = file.replace(".md", "");
      const parsed = Date.parse(stem);
      if (!isNaN(parsed) && parsed < cutoff) {
        unlinkSync(join(dailyDir, file));
        removed++;
      }
    }
    return removed;
  }

  cleanupOldVersions(keep: number = 50): number {
    const versionsDir = join(this.root, ".versions");
    if (!existsSync(versionsDir)) return 0;

    const files = readdirSync(versionsDir)
      .map((f) => ({
        name: f,
        mtime: statSync(join(versionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    let removed = 0;
    for (const file of files.slice(keep)) {
      unlinkSync(join(versionsDir, file.name));
      removed++;
    }
    return removed;
  }
}
