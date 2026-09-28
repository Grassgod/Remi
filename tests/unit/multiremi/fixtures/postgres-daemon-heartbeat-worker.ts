import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

self.onmessage = (message: MessageEvent<{ databaseUrl: string; runtimeId: string }>) => {
  const { databaseUrl, runtimeId } = message.data;
  const db = new PostgresSyncDatabase(databaseUrl);
  const store = new MultiremiStore(db);
  const app = createMultiremiApp({ store });
  self.onmessage = async () => {
    try {
      const response = await app.request("/api/daemon/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime_id: runtimeId }) });
      await response.text();
      self.postMessage({ phase: "done", status: response.status });
    } catch {
      self.postMessage({ phase: "error" });
    } finally { db.close(); }
  };
  self.postMessage({ phase: "ready" });
};
