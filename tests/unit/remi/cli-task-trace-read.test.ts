import { afterEach, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { InMemoryTraceStore, type TraceStore } from "@multiremi/worker/trace-store.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { isTraceFileEvent } from "@multiremi/contracts/trace-file.js";
import { TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { unifiedCommandSpecs } from "../../../apps/remi/cli/commands/unified.js";
import { legacyTraceFile, traceWriter } from "../../helpers/turn-trace.js";
import {
  messageEvent, oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_STORED_EVENT_MAX_BYTES, storedEventBytes, turnStartedEvent,
} from "../multiremi/trace-budget-fixtures.js";

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

/** A task whose hot trace lives in `trace`, served over real HTTP to the registered `turn trace read` command. */
function cliFixture(source: TraceStore | ((taskId: string) => TraceStore), runtimeId = "rt_cli_trace") {
  process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
  process.env.MULTIREMI_WORKSPACE_ID = "local";
  process.env.MULTIREMI_TOKEN = "test-token";
  const database = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(database);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: runtimeId, name: "CLI trace", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "CLI trace agent", provider: "codex", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "Trace budget" });
  store.markTaskTraceDaemon(task.id, runtime.id);
  const trace = typeof source === "function" ? source(task.id) : source;
  const app = createMultiremiApp({ store, authToken: "test-token", daemonTraceReader: new InMemoryDaemonTraceReader(() => trace) });
  const bodies: number[] = [];
  const queries: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url, init);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ commands: [{ id: "turn.trace.read", allowed: true }] });
    }
    queries.push(new URL(request.url).search);
    const response = await app.request(request);
    bodies.push(Buffer.byteLength(await response.clone().text()));
    return response;
  }) as typeof fetch;
  const registry = new CommandRegistry();
  registry.register(unifiedCommandSpecs().find((spec) => spec.id === "turn.trace.read")!);
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    try {
      await registry.execute(["turn", "trace", "read", store.getTurnForAttempt(task.id)!.id, ...args]);
    } finally {
      console.log = realLog;
    }
    return lines;
  };
  const json = async (...args: string[]) => {
    const lines = await run(...args, "--output", "json");
    return { page: JSON.parse(lines.join("\n")), bytes: Buffer.byteLength(lines.join("\n")) };
  };
  return { task, bodies, queries, run, json, close: () => database.close() };
}

const cases = [
  ...oversizedTraceCases.map((fixture) => ({ ...fixture, surrounded: false })),
  { name: "normal, oversized, normal events", input: oversizedTraceCases[1]!.input, surrounded: true },
];
for (const { name, input, surrounded } of cases) {
  it(`turn.trace.read --raw returns ${name} byte-for-byte and pages to eof through real HTTP`, async () => {
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const cli = cliFixture(trace);
    try {
      const original = trace.append(cli.task.id, [
        ...(surrounded ? [messageEvent("msg:first", "first")] : []), input, messageEvent("msg:last", "last"),
      ]).events;
      const oversized = original[surrounded ? 1 : 0]!;
      const eventBytes = storedEventBytes(oversized);
      expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      expect(eventBytes).toBeLessThanOrEqual(TRACE_STORED_EVENT_MAX_BYTES);
      expect(isTraceFileEvent(oversized)).toBe(true);
      const read = (afterSeq: number) => cli.json("--raw", "--after", String(afterSeq));
      if (surrounded) {
        const before = await read(0);
        expect(before.page).toMatchObject({ view: "events", state: "ok", head: 3, next_after_seq: 1, eof: false });
        expect(JSON.stringify(before.page.events)).toBe(JSON.stringify([original[0]!]));
        expect(Buffer.byteLength(JSON.stringify(before.page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
        expect(before.bytes).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
        expect(cli.bodies[0]).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      }
      const first = await read(surrounded ? 1 : 0);
      expect(first.page).toMatchObject({ state: "ok", head: original.length, next_after_seq: oversized.seq, eof: false });
      expect(first.page.events).toHaveLength(1);
      expect(JSON.stringify(first.page.events[0])).toBe(JSON.stringify(oversized));
      expect(cli.bodies[surrounded ? 1 : 0]).toBeLessThanOrEqual(eventBytes + 512);
      expect(first.bytes).toBeLessThanOrEqual(eventBytes + 512);
      const last = await read(first.page.next_after_seq);
      expect(last.page).toMatchObject({ state: "ok", next_after_seq: original.length, head: original.length, eof: true });
      expect(JSON.stringify(last.page.events)).toBe(JSON.stringify([original.at(-1)!]));
      expect(last.bytes).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      expect(cli.queries.every((query) => query.includes("view=events"))).toBe(true);
      realLog(`PR2 trace ${name} CLI: event=${eventBytes}, events=${Buffer.byteLength(JSON.stringify(first.page.events))}, HTTP=${cli.bodies[surrounded ? 1 : 0]}, stdout=${first.bytes}`);
    } finally {
      cli.close();
    }
  });
}

it("turn.trace.read prints the folded turn by default and pages it with --cursor", async () => {
  const writer = traceWriter(new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS), { runtimeId: "rt_cli_trace" });
  const cli = cliFixture(writer.store);
  try {
    writer.append(cli.task.id, [turnStartedEvent(cli.task.id), messageEvent("msg:1", "one"), messageEvent("msg:2", "two")]);
    const first = await cli.json("--limit", "1");
    expect(first.page).toMatchObject({ view: "turn", format: "v2", state: "ok", closed: false, head: 3, next_item_cursor: 1,
      turn: { id: cli.task.id, status: "running" }, items: [{ id: "msg:1", text: "one" }] });
    const rest = await cli.json("--cursor", "1");
    expect(rest.page).toMatchObject({ next_item_cursor: null, items: [{ id: "msg:2", text: "two" }] });
    expect(cli.queries.at(-1)).toContain("view=turn");
    expect(cli.queries.at(-1)).toContain("item_cursor=1");
    // The table lists the items; JSONL prints one item per line.
    const table = (await cli.run()).join("\n");
    expect(table).toContain("msg:1");
    expect(table).toContain("agent_message");
    const jsonl = await cli.run("--output", "jsonl");
    expect(jsonl.map((line) => JSON.parse(line).id)).toEqual(["msg:1", "msg:2"]);
  } finally {
    cli.close();
    await writer.stop();
  }
});

it("turn.trace.read --raw prints a v1 trace's raw lines; the default view answers legacy", async () => {
  const lines = [
    { seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "old fragment" },
    { seq: 2, ts: `2026-01-01T00:00:00.${"0".repeat(100)}Z`, type: "tool_use", tool: "Bash" },
  ];
  const made: Array<ReturnType<typeof legacyTraceFile>> = [];
  const cli = cliFixture((taskId) => {
    made.push(legacyTraceFile(taskId, lines, { runtimeId: "rt_cli_trace", closed: true }));
    return made[0]!.store;
  });
  const legacy = made[0]!;
  try {
    const folded = await cli.json();
    expect(folded.page).toMatchObject({ view: "turn", format: "legacy", state: "ok", turn: null, items: [], head: 2, closed: true });
    const raw = await cli.json("--raw");
    expect(raw.page).toMatchObject({ view: "events", format: "legacy", head: 2, eof: true, closed: true });
    expect(raw.page.events.map((event: unknown) => JSON.stringify(event))).toEqual(legacy.lines.slice(1, 3));
    // JSONL prints the stored lines one per line, verbatim.
    expect(await cli.run("--raw", "--output", "jsonl")).toEqual(legacy.lines.slice(1, 3));
  } finally {
    cli.close();
    legacy.cleanup();
  }
});

it("rejects a cursor of the other view before sending a request", async () => {
  const cli = cliFixture(new InMemoryTraceStore());
  try {
    await expect(cli.run("--after", "3")).rejects.toThrow("--after pages raw event lines");
    await expect(cli.run("--raw", "--cursor", "3")).rejects.toThrow("--cursor pages the folded turn");
    expect(cli.queries).toEqual([]);
  } finally {
    cli.close();
  }
});
