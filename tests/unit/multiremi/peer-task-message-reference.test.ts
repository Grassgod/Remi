import { describe, expect, it, spyOn } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { Hono } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import { PostgresSyncDatabase, resetDbReplyLimitForTest, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createRealtimeFanout } from "@multiremi/api/realtime-fanout.js";
import { createPeerChannel } from "@multiremi/api/peer/peer-channel.js";
import { registerPeerRoutes } from "@multiremi/api/peer/peer-routes.js";
import { taskMessageRealtimePayload } from "@multiremi/api/wire/tasks.js";
import { createRequestMetricsMiddleware } from "@multiremi/observability/request-metrics.js";
import { fanoutBrowserClient } from "../../fixtures/multiremi/task-message-fanout-fixture.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL;
const CONTENT = "x".repeat(256 * 1024);
const BYTE_BOUND = 101_711_872;

async function drain(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

async function withPgPair(run: (writer: SqlDatabase, reader: SqlDatabase) => Promise<void>): Promise<void> {
  const name = `mul462_ref_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new Bun.SQL(PG_ADMIN_URL!, { max: 1 });
  let writer: PostgresSyncDatabase | undefined;
  let reader: PostgresSyncDatabase | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(PG_ADMIN_URL!);
    url.pathname = `/${name}`;
    writer = new PostgresSyncDatabase(url.toString());
    reader = new PostgresSyncDatabase(url.toString());
    await run(writer, reader);
  } finally {
    writer?.close(); reader?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

async function withReplyLimit(bytes: number, run: () => Promise<void>): Promise<void> {
  const previous = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
  process.env.MULTIREMI_PG_REPLY_MAX_BYTES = String(bytes);
  process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
  resetDbReplyLimitForTest();
  try { await withNonExceptionContext(run); }
  finally {
    if (previous === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previous;
    if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
    else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
    resetDbReplyLimitForTest();
  }
}

// C-1 exempts the real peer route and background work; small-limit probes use an ordinary context.
async function withNonExceptionContext(run: () => Promise<void>): Promise<void> {
  const app = new Hono();
  app.use("*", createRequestMetricsMiddleware({ enabled: false, slowRequestMs: 500,
    summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 256, role: "all" }));
  app.onError(error => { throw error; });
  app.get("/api/peer-limit-fixture", async c => { await run(); return c.body(null, 204); });
  await app.request("/api/peer-limit-fixture");
}

function fanoutPair(writer: SqlDatabase, reader: SqlDatabase, maxEventBytes?: number, probeSmallLimit = false) {
  const store = new MultiremiStore(writer);
  const receiverStore = new MultiremiStore(reader);
  const agent = store.createAgent({ name: "Reference probe", provider: "codex" });
  const task = store.createTask({ agentId: agent.id, prompt: "p".repeat(128 * 1024) });
  const local = fanoutBrowserClient("local");
  const remote = fanoutBrowserClient("local");
  const denied = fanoutBrowserClient("member");
  store.createWorkspaceMember({ workspaceId: "local", userId: "member", name: "Member", role: "member" });
  const references: Array<{ start: number; end: number; seqs: number[]; pages: number }> = [];
  const queries: string[] = [];
  const pageLengths: number[] = [];
  const query = reader.query.bind(reader);
  reader.query = ((sql: string) => {
    if (/FROM multiremi_task_messages WHERE task_id = .*seq >/i.test(sql)) queries.push(sql);
    return query(sql);
  }) as typeof reader.query;
  const read = receiverStore.listTaskMessages.bind(receiverStore);
  receiverStore.listTaskMessages = (...args) => {
    const rows = read(...args);
    pageLengths.push(rows.length);
    return rows;
  };
  const receiver = createPeerChannel({ url: "http://unused-peer", origin: "reference-receiver" });
  let frameStart = 0;
  let pageStart = 0;
  let beforeReference: (() => void) | undefined;
  receiver.subscribe("realtime", (event: any) => {
    if (event.payload.seq_start === undefined) return;
    frameStart = remote.frames.length;
    pageStart = queries.length;
    beforeReference?.();
  });
  const registries = (client: typeof local) => ({
    browser: new Map([["local", new Set([client.client, ...(client === remote ? [denied.client] : [])])]]),
    browserScope: new Map(), browserUser: new Map(), daemon: new Map(),
  });
  const receiving = createRealtimeFanout({
    store: receiverStore, role: "ui", peer: receiver, registries: registries(remote),
  });
  receiver.subscribe("realtime", (event: any) => {
    if (event.payload.seq_start === undefined) return;
    references.push({ start: event.payload.seq_start, end: event.payload.seq_end,
      seqs: remote.frames.slice(frameStart).map(frame => JSON.parse(frame).payload.seq).filter(seq => seq !== undefined),
      pages: queries.length - pageStart,
    });
  });
  const app = new Hono();
  if (probeSmallLimit) app.use("*", (_c, next) => withNonExceptionContext(next));
  const secret = "fake-reference-peer-secret";
  registerPeerRoutes(app, { peer: receiver, secret });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  let peak = 0;
  let largestPost = 0;
  const sample = () => {
    const stats = sender.stats();
    peak = Math.max(peak, stats.queued_bytes + stats.inflight_bytes);
    expect(stats.queued_bytes + stats.inflight_bytes).toBeLessThanOrEqual(BYTE_BOUND);
  };
  const sender = createPeerChannel({ url: `http://127.0.0.1:${server.port}`, secret,
    origin: "reference-sender", maxEventBytes,
    fetchImpl: async (url, init) => {
      sample();
      largestPost = Math.max(largestPost, Buffer.byteLength(String(init.body)));
      const response = await fetch(url, init);
      sample();
      return response;
    },
  });
  const committedSeqs: number[][] = [];
  const forward = sender.forwardRealtime.bind(sender);
  sender.forwardRealtime = (kind, payload) => {
    if (kind === "task_messages") {
      expect(writer.inTransaction).toBe(false);
      const messages = payload.messages as ReturnType<MultiremiStore["appendTaskMessages"]>;
      for (const message of messages) {
        // A separate PG connection must already see the row before it is queued.
        const row = reader.query("SELECT content FROM multiremi_task_messages WHERE task_id = ? AND seq = ?")
          .get(task.id, message.seq) as { content: string | null };
        expect(row.content).toBe(message.content);
      }
      committedSeqs.push(messages.map(message => message.seq));
    }
    forward(kind, payload);
    sample();
  };
  const producing = createRealtimeFanout({ store, role: "ui", peer: sender, registries: registries(local) });
  return {
    store, receiverStore, task, local, remote, denied, sender, receiver, references, queries, pageLengths, committedSeqs,
    setBeforeReference: (hook: () => void) => { beforeReference = hook; },
    metrics: () => ({ peak, largestPost }),
    drained: () => drain(() => sender.stats().queued === 0 && sender.stats().inflight === 0 && sender.stats().sent > 0),
    close: () => { producing.close(); receiving.close(); server.stop(true); reader.query = query; },
  };
}

async function assertUpsertConvergence(writer: SqlDatabase, reader: SqlDatabase, intermediate = false): Promise<void> {
  const pair = fanoutPair(writer, reader);
  try {
    pair.store.appendTaskMessages(pair.task.id, Array.from({ length: 256 }, (_, index) => ({
      seq: index + 1, type: "assistant" as const, content: CONTENT,
    })));
    expect(pair.sender.stats().degraded).toBeGreaterThan(0);
    if (intermediate) pair.store.appendTaskMessages(pair.task.id, [{ seq: 256, type: "assistant", content: "intermediate" }]);
    pair.store.appendTaskMessages(pair.task.id, [{ seq: 256, type: "assistant", content: "updated" }]);
    await pair.drained();
    const localMessages = pair.local.frames.map(frame => JSON.parse(frame).payload);
    const remoteMessages = pair.remote.frames.map(frame => JSON.parse(frame).payload);
    expect(remoteMessages.map(message => message.seq)).toEqual(localMessages.map(message => message.seq));
    for (const reference of pair.references) {
      expect(reference.seqs).toEqual(Array.from({ length: reference.end - reference.start + 1 }, (_, i) => reference.start + i));
    }
    // Load the production browser merge function, not a test-side approximation.
    const { mergeTaskMessages } = await import(new URL("../../../frontend/packages/core/chat/queries.ts", import.meta.url).href);
    const localFinal = mergeTaskMessages(...localMessages.map(message => [message]));
    const remoteFinal = mergeTaskMessages(...remoteMessages.map(message => [message]));
    const current: Record<string, unknown>[] = [];
    let cursor = 0;
    while (cursor < 256) {
      const page = pair.store.listTaskMessages(pair.task.id, cursor, 256, pair.store.getTaskMessagePageRows());
      expect(page.length).toBeGreaterThan(0);
      current.push(...page.map(message => taskMessageRealtimePayload(message, pair.task)));
      cursor = page.at(-1)!.seq;
    }
    expect(JSON.stringify(remoteFinal)).toBe(JSON.stringify(localFinal));
    expect(JSON.stringify(remoteFinal)).toBe(JSON.stringify(current));
    expect(pair.committedSeqs).toEqual([Array.from({ length: 256 }, (_, i) => i + 1), ...(intermediate ? [[256]] : []), [256]]);
    if (intermediate) {
      expect(remoteMessages.filter(message => message.seq === 256).map(message => message.content)).toEqual(["updated", "intermediate", "updated"]);
    }
    console.log("REFERENCE_UPSERT " + JSON.stringify({
      backend: writer.dialect ?? "sqlite", localFrames: localMessages.length, remoteFrames: remoteMessages.length,
      seqsPreserved: true, finalMatchesLocalAndCurrent: true, enqueuedAfterCommit: true,
    }));
  } finally { pair.close(); }
}

describe("peer current-committed message references", () => {
  it("preserves seqs, converges with the real browser merge, and queues only after commit (SQLite upsert)", async () => {
    const db = openSqliteDatabase(":memory:");
    try { await assertUpsertConvergence(db, db); }
    finally { db.close(); }
  }, 20_000);

  it("converges even when a reference delivers a newer version before an older queued full frame", async () => {
    const db = openSqliteDatabase(":memory:");
    try { await assertUpsertConvergence(db, db, true); }
    finally { db.close(); }
  }, 20_000);

  it("does not silently swallow a reference query failure or send its header to a denied recipient", async () => {
    const db = openSqliteDatabase(":memory:");
    const pair = fanoutPair(db, db, 1024);
    const read = spyOn(pair.receiverStore, "listTaskMessages").mockImplementation(() => { throw new Error("fake-reference-query-failure"); });
    try {
      pair.store.appendTaskMessages(pair.task.id, [{ type: "assistant", content: CONTENT }]);
      await pair.drained();
      expect(pair.remote.frames).toHaveLength(1);
      expect(JSON.parse(pair.remote.frames[0]!).payload).toMatchObject({ degraded: true, task_id: pair.task.id, seq_start: 1, seq_end: 1 });
      expect(pair.denied.frames).toHaveLength(0);
      expect(pair.receiver.stats()).toMatchObject({ degraded_received: 1, reference_read_failed: 1 });
    } finally { read.mockRestore(); pair.close(); db.close(); }
  }, 20_000);
});

describe.skipIf(!PG_ADMIN_URL)("peer current-committed message references on real PG", () => {
  it("delivers two same-tick 256 x 256 KiB reports byte-for-byte through indexed pages", async () => {
    await withPgPair(async (writer, reader) => {
      const pair = fanoutPair(writer, reader);
      try {
        for (let report = 0; report < 2; report++) {
          pair.store.appendTaskMessages(pair.task.id, Array.from({ length: 256 }, () => ({ type: "assistant", content: CONTENT })));
        }
        await pair.drained();
        expect(pair.remote.frames).toEqual(pair.local.frames);
        expect(pair.remote.frames).toHaveLength(512);
        expect(pair.remote.frames.map(frame => JSON.parse(frame).payload.seq)).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
        const pageRows = pair.receiverStore.getTaskMessagePageRows();
        for (const reference of pair.references) {
          expect(reference.pages).toBe(Math.ceil((reference.end - reference.start + 1) / pageRows));
        }
        for (const query of pair.queries) {
          expect(query).toContain("ORDER BY seq ASC LIMIT ?");
          expect(query).toContain("seq <= ?");
        }
        expect(pair.receiver.stats().degraded_received).toBe(pair.references.length);
        expect(pair.sender.stats().dropped).toBe(0);
        expect(pair.metrics().largestPost).toBeLessThanOrEqual(1_048_576);
        console.log("REFERENCE_PG_PLAIN " + JSON.stringify({ frames: pair.remote.frames.length, pageRows,
          pageQueries: pair.queries.length, references: pair.references.length, ...pair.metrics() }));
      } finally { pair.close(); }
    });
  }, 20_000);

  it("pages below a deliberately small PG bridge limit instead of reading the whole range", async () => {
    await withReplyLimit(512 * 1024, () => withPgPair(async (writer, reader) => {
      const pair = fanoutPair(writer, reader, 1024, true);
      try {
        pair.store.appendTaskMessages(pair.task.id, Array.from({ length: 32 }, () => ({ type: "assistant", content: CONTENT })));
        await pair.drained();
        expect(pair.references).toHaveLength(1);
        expect(pair.references[0]!.seqs).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
        expect(pair.remote.frames).toEqual(pair.local.frames);
        expect(pair.receiverStore.getTaskMessagePageRows()).toBe(1);
        expect(pair.queries).toHaveLength(32);
        expect(pair.pageLengths).toEqual(Array(32).fill(1));
        console.log("REFERENCE_PG_SMALL_LIMIT " + JSON.stringify({ limitBytes: 512 * 1024, pages: 32, frames: 32 }));
      } finally { pair.close(); }
    }));
  }, 20_000);

  it("converges after an upsert visible on a separate committed PG connection", async () => {
    await withReplyLimit(0, () => withPgPair((writer, reader) => assertUpsertConvergence(writer, reader, true)));
  }, 20_000);

  it("sends a header-only refetch frame and counts a reference read failure when one row cannot fit", async () => {
    await withPgPair(async (writer, reader) => {
      const pair = fanoutPair(writer, reader, 1024, true);
      const previous = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
      try {
        pair.store.appendTaskMessages(pair.task.id, [{ type: "assistant", content: CONTENT }]);
        pair.setBeforeReference(() => {
          process.env.MULTIREMI_PG_REPLY_MAX_BYTES = String(128 * 1024);
          process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
          resetDbReplyLimitForTest();
        });
        await pair.drained();
        expect(pair.remote.frames).toHaveLength(1);
        const frame = JSON.parse(pair.remote.frames[0]!);
        expect(frame).toMatchObject({ type: "task:message", actor_id: pair.task.agentId,
          payload: { task_id: pair.task.id, degraded: true, seq_start: 1, seq_end: 1 } });
        expect(frame.payload).not.toHaveProperty("content");
        expect(frame.payload).not.toHaveProperty("seq");
        expect(pair.receiver.stats()).toMatchObject({ degraded_received: 1, reference_read_failed: 1 });
        console.log("REFERENCE_PG_READ_FAILED " + JSON.stringify({ frames: 1, referenceReadFailed: 1 }));
      } finally {
        if (previous === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
        else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previous;
        if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
        else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
        resetDbReplyLimitForTest(); pair.close();
      }
    });
  }, 20_000);
});
