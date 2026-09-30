import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

let db: PostgresSyncDatabase | undefined;
let store: MultiremiStore | undefined;
self.onmessage = (event: MessageEvent<{ type: "init" | "claim" | "close"; databaseUrl?: string; supportsKinds?: boolean }>) => {
  try {
    if (event.data.type === "init") {
      db = new PostgresSyncDatabase(event.data.databaseUrl!);
      store = new MultiremiStore(db);
      self.postMessage({ phase: "ready" });
    } else if (event.data.type === "claim") {
      const row = store!.claimFeishuBotOutbound("local", "rt_kinds", undefined, true, true, true, event.data.supportsKinds);
      self.postMessage({ phase: "claimed", row });
    } else {
      db?.close();
      self.postMessage({ phase: "closed" });
    }
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
