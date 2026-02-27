/**
 * Token persistence — read/write ~/.remi/auth/tokens.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenEntry } from "./types.js";

export type PersistedTokens = Record<string, Record<string, TokenEntry>>;

export class TokenPersistence {
  private _path: string;

  constructor(filePath: string) {
    this._path = filePath;
  }

  load(): PersistedTokens {
    if (!existsSync(this._path)) return {};
    try {
      return JSON.parse(readFileSync(this._path, "utf-8"));
    } catch {
      return {};
    }
  }

  save(data: PersistedTokens): void {
    const dir = dirname(this._path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this._path, JSON.stringify(data, null, 2), "utf-8");
  }
}
