import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

type WorkerInput =
  | { type: "init"; databaseUrl: string }
  | { type: "edit"; commentId: string; body: string };

let db: PostgresSyncDatabase | null = null;
let store: MultiremiStore | null = null;

self.onmessage = (message: MessageEvent<WorkerInput>) => {
  try {
    if (message.data.type === "init") {
      db = new PostgresSyncDatabase(message.data.databaseUrl);
      store = new MultiremiStore(db);
      self.postMessage({ phase: "ready" });
      return;
    }
    if (!store) throw new Error("Postgres comment edit worker is not initialized");
    self.postMessage({ phase: "editing" });
    store.updateIssueComment(message.data.commentId, { body: message.data.body });
    self.postMessage({ phase: "completed" });
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
