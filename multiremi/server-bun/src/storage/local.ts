/**
 * Local-filesystem blob store — the default self-host attachment backend.
 * Blobs live under `<baseDir>/<key>`; content-type + filename are persisted in
 * a sidecar `<key>.meta.json` so a download can set the right headers without
 * the DB row. URLs are `local://<key>`.
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Storage, StoredBlob } from "./storage.js";

const URL_PREFIX = "local://";

export class LocalStorage implements Storage {
  constructor(private readonly baseDir: string) {}

  async upload(key: string, data: Uint8Array, contentType: string, filename: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(join(this.baseDir, key), data);
    await writeFile(join(this.baseDir, `${key}.meta.json`), JSON.stringify({ contentType, filename }));
    return `${URL_PREFIX}${key}`;
  }

  async read(key: string): Promise<StoredBlob | null> {
    try {
      const data = await readFile(join(this.baseDir, key));
      let contentType = "application/octet-stream";
      let filename = key;
      try {
        const meta = JSON.parse(await readFile(join(this.baseDir, `${key}.meta.json`), "utf8")) as { contentType?: string; filename?: string };
        if (meta.contentType) contentType = meta.contentType;
        if (meta.filename) filename = meta.filename;
      } catch {
        /* missing sidecar → defaults */
      }
      return { data: new Uint8Array(data), contentType, filename };
    } catch {
      return null;
    }
  }

  keyFromUrl(url: string): string {
    return url.startsWith(URL_PREFIX) ? url.slice(URL_PREFIX.length) : url;
  }
}
