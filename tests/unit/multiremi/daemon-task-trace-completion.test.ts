import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { log } from "@multiremi/api/helpers/common.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `multiremi_trace_completion_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const cases = [
  { name: "explicit zero", trace: { event_count: 0 }, location: "none", warn: false },
  { name: "positive count without legacy rows", trace: { event_count: 7 }, location: "daemon", warn: false },
  { name: "largest safe count", trace: { event_count: Number.MAX_SAFE_INTEGER }, location: "daemon", warn: false },
  { name: "missing trace", trace: undefined, location: "daemon", warn: false },
  { name: "missing event_count", trace: { head: 0, closed: true }, location: "daemon", warn: false },
  { name: "negative count", trace: { event_count: -1 }, location: "daemon", warn: true },
  { name: "fractional count", trace: { event_count: 0.5 }, location: "daemon", warn: true },
  { name: "unsafe count", trace: { event_count: Number.MAX_SAFE_INTEGER + 1 }, location: "daemon", warn: true },
  { name: "string zero", trace: { event_count: "0" }, location: "daemon", warn: true },
  { name: "null count", trace: { event_count: null }, location: "daemon", warn: true },
  { name: "boolean count", trace: { event_count: false }, location: "daemon", warn: true },
  { name: "invalid trace block", trace: [], location: "daemon", warn: true },
] as const;

afterEach(resetMultiremiTestEnv);

for (const backend of ["SQLite", "Postgres"] as const) {
  describe.skipIf(backend === "Postgres" && !pgUrl)(`daemon terminal trace counts on ${backend}`, () => {
    let pgDb: PostgresSyncDatabase | undefined;
    let pgStore: MultiremiStore | undefined;

    beforeAll(async () => {
      if (backend !== "Postgres") return;
      const admin = new Bun.SQL(pgUrl!, { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      } finally {
        await admin.end();
      }
      const url = new URL(pgUrl!);
      url.pathname = `/${databaseName}`;
      pgDb = new PostgresSyncDatabase(url.toString());
      pgStore = new MultiremiStore(pgDb);
    });

    afterAll(async () => {
      if (backend !== "Postgres") return;
      pgDb?.close();
      const admin = new Bun.SQL(pgUrl!, { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });

    for (const route of ["complete", "fail"] as const) {
      for (const testCase of cases) {
        it(`${route}: ${testCase.name}`, async () => {
          const store = backend === "SQLite" ? createStore() : pgStore!;
          store.ensureLocalWorkspace();
          const runtime = store.registerRuntime({ name: "Completion trace daemon", provider: "codex", workspaceId: "local" });
          const agent = store.createAgent({ name: "Trace completion", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
          const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "trace completion" });
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          store.startTask(task.id);
          expect(store.getTaskTrace(task.id)?.location).toBe("daemon");
          const app = createMultiremiApp({ store, authToken: "trace-completion-test" });
          const warn = spyOn(log, "warn").mockImplementation(() => {});
          try {
            const response = await app.request(`/api/daemon/tasks/${task.id}/${route}`, {
              method: "POST",
              headers: { Authorization: "Bearer trace-completion-test", "Content-Type": "application/json" },
              body: JSON.stringify({ output: "done", error: "failed", trace: testCase.trace }),
            });
            expect(response.status).toBe(200);
            expect(store.getTask(task.id)?.status).toBe(route === "complete" ? "completed" : "failed");
            expect(store.getTaskTrace(task.id)?.location).toBe(testCase.location);
            expect(store.getTaskTrace(task.id)?.runtimeId).toBe(testCase.location === "none" ? null : runtime.id);
            expect(warn).toHaveBeenCalledTimes(testCase.warn ? 1 : 0);
            if (testCase.warn) {
              expect(warn).toHaveBeenCalledWith("Ignoring invalid daemon completion trace.event_count", { taskId: task.id });
            }
          } finally {
            warn.mockRestore();
          }
        });
      }
    }
  });
}
