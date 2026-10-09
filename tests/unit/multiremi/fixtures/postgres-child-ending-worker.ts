/**
 * MUL-400 S1: end a child issue from a SECOND Postgres connection, so the
 * parent-report path really races the test process's own store. Both writers
 * take the same workspace lock in `enqueueChildDoneParentTask`, which is what
 * keeps "one pending round per parent" true across processes.
 */
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { IssueDeliveryActor } from "@multiremi/store/issue-deliveries.js";

type WorkerInput =
  | { type: "init"; databaseUrl: string; migrationReportDir: string }
  | { type: "end"; childIssueId: string; status: string; delivery?: { id: string; revision: string }; actor?: IssueDeliveryActor };

let db: PostgresSyncDatabase | null = null;
let store: MultiremiStore | null = null;

self.onmessage = (message: MessageEvent<WorkerInput>) => {
  try {
    if (message.data.type === "init") {
      process.env.MULTIREMI_MIGRATION_REPORT_DIR = message.data.migrationReportDir;
      db = new PostgresSyncDatabase(message.data.databaseUrl);
      store = new MultiremiStore(db);
      self.postMessage({ phase: "ready" });
      return;
    }
    if (!store) throw new Error("Postgres child-ending worker is not initialized");
    self.postMessage({ phase: "starting", childIssueId: message.data.childIssueId });
    if (message.data.status === "done") {
      if (!message.data.delivery || !message.data.actor) throw new Error("Child acceptance requires its exact delivery and reviewer");
      store.respondIssueDelivery(message.data.childIssueId, message.data.delivery.id,
        { action: "accept", revision: message.data.delivery.revision }, message.data.actor);
    } else {
      store.updateIssue(message.data.childIssueId, { status: message.data.status });
    }
    self.postMessage({ phase: "completed", childIssueId: message.data.childIssueId });
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
