/**
 * RemiData — Soul: ~/.remi/soul.md (global instructions).
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RemiDataContext } from "./context.js";

export class SoulData {
  constructor(private readonly ctx: RemiDataContext) {}

  readSoul(): string {
    const p = join(this.ctx.root, "soul.md");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeSoul(content: string): void {
    const p = join(this.ctx.root, "soul.md");
    this.ctx._backup(p);
    writeFileSync(p, content, "utf-8");
  }
}
