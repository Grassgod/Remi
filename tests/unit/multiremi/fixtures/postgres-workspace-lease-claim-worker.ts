import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

type ClaimWorkerMessage =
  | { type: "init"; databaseUrl: string }
  | { type: "claim"; runtimeId: string }
  | { type: "close" };

let db: PostgresSyncDatabase | null = null;
let store: MultiremiStore | null = null;

self.onmessage = (message: MessageEvent<ClaimWorkerMessage>) => {
  try {
    if (message.data.type === "init") {
      db = new PostgresSyncDatabase(message.data.databaseUrl);
      store = new MultiremiStore(db);
      self.postMessage({ phase: "ready" });
      return;
    }
    if (message.data.type === "claim") {
      if (!store) throw new Error("claim worker is not initialized");
      const claimed = store.claimTask(message.data.runtimeId);
      self.postMessage({ phase: "claimed", taskId: claimed?.id ?? null });
      return;
    }
    db?.close();
    db = null;
    store = null;
    self.postMessage({ phase: "closed" });
  } catch (error) {
    self.postMessage({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
