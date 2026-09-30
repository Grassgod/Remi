import { afterEach, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { InMemoryTraceStore, sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { isTraceFileEvent } from "@multiremi/contracts/trace-file.js";
import { TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { collaborationCommandSpecs } from "../../../apps/remi/cli/commands/collaboration.js";
import { oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_SANITIZED_EVENT_MAX_BYTES, traceFiniteEventBytes } from "../multiremi/trace-budget-fixtures.js";

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

const cases = [
  ...oversizedTraceCases.map((fixture) => ({ ...fixture, surrounded: false })),
  { name: "normal, oversized, normal events", input: { type: "text", content: "\u0001".repeat(180_000) }, surrounded: true },
];
for (const { name, input, surrounded } of cases) {
  it(`task.trace.read returns ${name} byte-for-byte and pages to eof through real HTTP`, async () => {
    process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
    process.env.MULTIREMI_WORKSPACE_ID = "local";
    process.env.MULTIREMI_TOKEN = "test-token";
    const database = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(database);
      store.ensureLocalWorkspace();
      const runtime = store.registerRuntime({ id: "rt_cli_trace", name: "CLI trace", provider: "codex", workspaceId: "local" });
      const agent = store.createAgent({ name: "CLI trace agent", provider: "codex", workspaceId: "local" });
      const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "Trace budget" });
      store.markTaskTraceDaemon(task.id, runtime.id);
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      if (name === "contract-limit event" || input.type === "x") {
        expect(sanitizeStoredEvent(input, input.ts ?? TRACE_BUDGET_FIXTURE_TS)).toEqual({ ts: TRACE_BUDGET_FIXTURE_TS, ...input });
      }
      const original = trace.append(task.id, [
        ...(surrounded ? [{ type: "text", content: "first" }] : []), input, { type: "text", content: "last" },
      ]).events;
      const oversized = original[surrounded ? 1 : 0]!;
      const eventBytes = Buffer.byteLength(JSON.stringify(oversized));
      expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      expect(isTraceFileEvent(oversized)).toBe(true);
      expect(oversized.ts).toBe(input.ts ?? TRACE_BUDGET_FIXTURE_TS);
      expect(traceFiniteEventBytes(oversized)).toBeLessThanOrEqual(TRACE_SANITIZED_EVENT_MAX_BYTES);
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
      if (surrounded) {
        const before = await read(0);
        expect(before.page).toMatchObject({ state: "ok", head: 3, next_after_seq: 1, eof: false });
        expect(JSON.stringify(before.page.events)).toBe(JSON.stringify([original[0]!]));
        expect(Buffer.byteLength(JSON.stringify(before.page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
        expect(before.bytes).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
        expect(bodies[0]).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      }
      const first = await read(surrounded ? 1 : 0);
      expect(first.page).toMatchObject({ state: "ok", head: original.length, next_after_seq: oversized.seq, eof: false });
      expect(first.page.events).toHaveLength(1);
      expect(JSON.stringify(first.page.events[0])).toBe(JSON.stringify(oversized));
      expect(bodies[surrounded ? 1 : 0]).toBeLessThanOrEqual(eventBytes + 512);
      expect(first.bytes).toBeLessThanOrEqual(eventBytes + 512);
      const last = await read(first.page.next_after_seq);
      expect(last.page).toMatchObject({ state: "ok", next_after_seq: original.length, head: original.length, eof: true });
      expect(JSON.stringify(last.page.events)).toBe(JSON.stringify([original.at(-1)!]));
      expect(Buffer.byteLength(JSON.stringify(last.page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
      expect(last.bytes).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      expect(bodies.at(-1)).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      realLog(`B5 r9 ${name} CLI: event=${eventBytes}, finite=${traceFiniteEventBytes(oversized)}, events=${Buffer.byteLength(JSON.stringify(first.page.events))}, HTTP=${bodies[surrounded ? 1 : 0]}, stdout=${first.bytes}`);
    } finally {
      database.close();
    }
  });
}
