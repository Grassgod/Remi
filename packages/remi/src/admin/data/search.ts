/**
 * RemiData — Memory: keyword search and recall debugging.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { MemoryStore, type RecallDebugResult } from "@memory/store.js";
import type { SearchResult } from "./types.js";
import { RemiDataContext } from "./context.js";

export class MemorySearchData {
  private _memoryStore: MemoryStore | null = null;

  constructor(private readonly ctx: RemiDataContext) {}

  searchMemory(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    // Search global memory
    const soul = this.ctx.host.readSoul();
    if (soul.toLowerCase().includes(q)) {
      const lines = soul.split("\n");
      const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
      results.push({ source: "global", name: "soul.md", snippet: matchLine.trim().slice(0, 200), path: "soul.md" });
    }

    // Search entities
    for (const entity of this.ctx.host.listEntities()) {
      const matchFields = [entity.name, entity.summary, ...entity.tags, ...entity.aliases]
        .join(" ").toLowerCase();
      if (matchFields.includes(q)) {
        results.push({ source: "entity", name: entity.name, snippet: entity.summary || entity.type, path: entity.path });
      }
    }

    // Search daily logs
    for (const { date } of this.ctx.host.listDailyDates()) {
      const content = this.ctx.host.readDaily(date);
      if (content.toLowerCase().includes(q)) {
        const lines = content.split("\n");
        const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
        results.push({ source: "daily", name: date, snippet: matchLine.trim().slice(0, 200), path: `daily/${date}.md` });
      }
    }

    // Search project-level memories
    for (const pm of this.ctx.host.listProjectMemories()) {
      for (const f of pm.files) {
        const content = this.ctx.host.readProjectMemoryFile(pm.projectId, f.path);
        if (content.toLowerCase().includes(q)) {
          const lines = content.split("\n");
          const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
          results.push({ source: "project", name: `${pm.projectName}/${f.name}`, snippet: matchLine.trim().slice(0, 200), path: `${pm.projectId}:${f.path}` });
        }
      }
    }

    return results;
  }

  async recallDebug(query: string, cwd?: string): Promise<RecallDebugResult> {
    if (!this._memoryStore) {
      let vectorStore = null;
      try {
        const config = this.ctx._getConfigStore().load();
        const apiKey = config.embedding?.apiKey;
        if (apiKey) {
          const { VectorStore } = require("@shared/db/vector-store.js");
          vectorStore = new VectorStore({ provider: "voyage", apiKey });
        }
      } catch { /* VectorStore unavailable */ }
      this._memoryStore = new MemoryStore(this.ctx.memoryDir, vectorStore);
    }
    return this._memoryStore.recall(query, { cwd, debug: true });
  }
}
