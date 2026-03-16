/**
 * Patch @larksuiteoapi/node-sdk to support card.action.trigger via WebSocket.
 *
 * The SDK's WSClient.handleEventData() only processes MessageType.event,
 * silently dropping MessageType.card messages. This patch adds card support.
 *
 * Bug: https://github.com/larksuite/node-sdk/issues/XXX
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SDK_DIR = join(import.meta.dirname, "..", "node_modules", "@larksuiteoapi", "node-sdk");
const FILES = ["es/index.js", "lib/index.js"];
const SEARCH = "if (type !== MessageType.event) {";
const REPLACE = "if (type !== MessageType.event && type !== MessageType.card) {";

let patched = 0;
for (const file of FILES) {
  const path = join(SDK_DIR, file);
  try {
    const content = readFileSync(path, "utf-8");
    if (content.includes(REPLACE)) {
      console.log(`[patch-lark-sdk] ${file}: already patched`);
      continue;
    }
    if (!content.includes(SEARCH)) {
      console.warn(`[patch-lark-sdk] ${file}: search string not found, SDK may have been updated`);
      continue;
    }
    writeFileSync(path, content.replace(SEARCH, REPLACE));
    console.log(`[patch-lark-sdk] ${file}: patched successfully`);
    patched++;
  } catch (e) {
    console.warn(`[patch-lark-sdk] ${file}: ${e.message}`);
  }
}
console.log(`[patch-lark-sdk] Done (${patched} file(s) patched)`);
