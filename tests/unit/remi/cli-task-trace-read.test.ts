import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { InMemoryTraceStore, sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { collaborationCommandSpecs } from "../../../apps/remi/cli/commands/collaboration.js";
import { oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_SANITIZED_EVENT_MAX_BYTES } from "../multiremi/trace-budget-fixtures.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const savedEnv = Object.fromEntries(["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN"]
  .map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

for (const { name, input } of oversizedTraceCases) {
  it(`task.trace.read returns ${name} byte-for-byte and pages to eof through real HTTP`, async () => {
    process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
    process.env.MULTIREMI_WORKSPACE_ID = "local";
    process.env.MULTIREMI_TOKEN = "test-token";
    const database = new Database(":memory:");
    try {
      const store = new MultiremiStore(database);
      store.ensureLocalWorkspace();
      const runtime = store.registerRuntime({ id: "rt_cli_trace", name: "CLI trace", provider: "codex", workspaceId: "local" });
      const agent = store.createAgent({ name: "CLI trace agent", provider: "codex", workspaceId: "local" });
      const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "Trace budget" });
      store.markTaskTraceDaemon(task.id, runtime.id);
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      if (name === "contract-limit event") {
        expect(sanitizeStoredEvent(input, TRACE_BUDGET_FIXTURE_TS)).toEqual({ ts: TRACE_BUDGET_FIXTURE_TS, ...input });
      }
      const original = trace.append(task.id, [input, { type: "text", content: "last" }]).events;
      const eventBytes = Buffer.byteLength(JSON.stringify(original[0]));
      expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      if (name === "contract-limit event") expect(eventBytes).toBeLessThanOrEqual(TRACE_SANITIZED_EVENT_MAX_BYTES);
      const app = createMultiremiApp({ store, authToken: "test-token", daemonTraceReader: new InMemoryDaemonTraceReader(() => trace) });
      const bodies: number[] = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const request = url instanceof Request ? url : new Request(url, init);
        if (new URL(request.url).pathname === "/api/cli/capabilities") {
          return Response.json({ commands: [{ id: "task.trace.read", allowed: true }] });
        }
        const response = await app.request(request);
        bodies.push(Buffer.byteLength(await response.clone().text()));
        return response;
      }) as typeof fetch;
      const registry = new CommandRegistry();
      registry.register(collaborationCommandSpecs().find((spec) => spec.id === "task.trace.read")!);
      const read = async (afterSeq: number) => {
        const lines: string[] = [];
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
        try {
          await registry.execute(["task", "trace", "read", task.id, "--after", String(afterSeq), "--output", "json"]);
        } finally {
          console.log = realLog;
        }
        return { page: JSON.parse(lines.join("\n")), bytes: Buffer.byteLength(lines.join("\n")) };
      };
      const first = await read(0);
      expect(first.page).toMatchObject({ state: "ok", head: 2, next_after_seq: 1, eof: false });
      expect(first.page.events).toHaveLength(1);
      expect(JSON.stringify(first.page.events[0])).toBe(JSON.stringify(original[0]));
      expect(bodies[0]).toBeLessThanOrEqual(eventBytes + 512);
      expect(first.bytes).toBeLessThanOrEqual(eventBytes + 512);
      const last = await read(first.page.next_after_seq);
      expect(last.page).toMatchObject({ state: "ok", events: [original[1]!], next_after_seq: 2, head: 2, eof: true });
      realLog(`B5 r8 ${name} CLI: event=${eventBytes}, events=${Buffer.byteLength(JSON.stringify(first.page.events))}, HTTP=${bodies[0]}, stdout=${first.bytes}`);
    } finally {
      database.close();
    }
  });
}
