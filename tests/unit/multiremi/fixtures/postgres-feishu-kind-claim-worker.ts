import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: PostgresSyncDatabase | undefined;
let store: MultiremiStore | undefined;
let stateDir: string | undefined;
self.onmessage = (event: MessageEvent<{ type: "init" | "claim" | "close"; databaseUrl?: string; migrationReportDir?: string; supportsKinds?: boolean }>) => {
  try {
    if (event.data.type === "init") {
      stateDir = mkdtempSync(join(tmpdir(), "feishu-kind-claim-state-"));
      process.env.MULTIREMI_STATE_DIR = stateDir;
      process.env.MULTIREMI_MIGRATION_REPORT_DIR = event.data.migrationReportDir;
      db = new PostgresSyncDatabase(event.data.databaseUrl!);
      store = new MultiremiStore(db);
      self.postMessage({ phase: "ready" });
    } else if (event.data.type === "claim") {
      const row = store!.claimFeishuBotOutbound("local", "rt_kinds", undefined, true, true, true, event.data.supportsKinds);
      self.postMessage({ phase: "claimed", row });
    } else {
      db?.close();
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
      self.postMessage({ phase: "closed" });
    }
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
