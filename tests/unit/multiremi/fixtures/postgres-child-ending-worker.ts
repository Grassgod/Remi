/**
 * MUL-400 S1: end a child issue from a SECOND Postgres connection, so the
 * parent-report path really races the test process's own store. Both writers
 * take the same workspace lock in `enqueueChildDoneParentTask`, which is what
 * keeps "one pending round per parent" true across processes.
 */
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

type WorkerInput =
  | { type: "init"; databaseUrl: string }
  | { type: "end"; childIssueId: string; status: string };

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
    if (!store) throw new Error("Postgres child-ending worker is not initialized");
    self.postMessage({ phase: "starting", childIssueId: message.data.childIssueId });
    store.updateIssue(message.data.childIssueId, { status: message.data.status });
    self.postMessage({ phase: "completed", childIssueId: message.data.childIssueId });
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
