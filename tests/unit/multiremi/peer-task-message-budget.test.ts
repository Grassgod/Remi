import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createRealtimeFanout } from "@multiremi/api/realtime-fanout.js";
import { createPeerChannel, PEER_MAX_EVENT_BYTES } from "@multiremi/api/peer/peer-channel.js";
import {
  driveTaskMessageFanout,
  fanoutBrowserClient,
  fanoutFixtureStore,
  installDeterministicFanoutClock,
} from "../../fixtures/multiremi/task-message-fanout-fixture.js";
import golden from "../../fixtures/multiremi/task-message-fanout-golden.json";

const SUBJECT_FIELDS = ["agentId", "chatSessionId", "id", "issueId", "issueSessionId", "workspaceId"];
const BYTE_BOUND = 101_711_872;

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("MUL-474 peer task-message wire", () => {
  for (const path of ["local", "full", "degraded", "reference"] as const) {
    it(`${path} emits the unchanged workspace, denied-recipient and Chat golden bytes`, async () => {
      const restoreClock = installDeterministicFanoutClock();
      const db = new Database(":memory:");
      try {
        const store = fanoutFixtureStore(db);
        const frames = driveTaskMessageFanout(store, (store, browser, browserScope, task, messages) => {
          const queries: string[] = [];
          const query = db.query.bind(db);
          db.query = ((sql: string) => {
            queries.push(sql);
            return query(sql);
          }) as typeof db.query;
          let listener: Parameters<MultiremiStore["onTaskMessages"]>[0] | undefined;
          const subscribe = store.onTaskMessages.bind(store);
          store.onTaskMessages = (handler) => {
            listener = handler;
            return subscribe(handler);
          };
          const fanout = createRealtimeFanout({
            store, role: "ui",
            registries: { browser, browserScope, browserUser: new Map(), daemon: new Map() },
          });
          try {
            if (path === "local") listener!({ task, messages });
            else {
              fanout.deliverRemote({
                v: 1, origin: "fake-peer", kind: "task_messages",
                payload: path === "full"
                  ? { task, task_id: task.id, messages }
                  : path === "degraded"
                    ? { task_id: task.id, degraded: true, messages }
                    : { task_id: task.id, degraded: true, seq_start: messages[0]!.seq, seq_end: messages.at(-1)!.seq },
              });
            }
            if (path === "degraded" || path === "reference") {
              const reads = queries.filter((sql) => /FROM multiremi_tasks WHERE id =/i.test(sql));
              expect(reads).toHaveLength(1);
              const columns = reads[0]!.match(/SELECT\s+(.*?)\s+FROM/i)![1]!.split(",");
              expect(columns).toHaveLength(6);
              expect(columns.join(",")).not.toContain("*");
              expect(columns.join(",")).not.toContain("prompt");
              if (path === "reference") {
                expect(queries.filter((sql) => /FROM multiremi_task_messages WHERE task_id =/i.test(sql))).toHaveLength(1);
              }
            }
          } finally {
            fanout.close();
            store.onTaskMessages = subscribe;
            db.query = query;
          }
        });
        expect(JSON.stringify(frames)).toBe(JSON.stringify({
          workspaceFrames: golden.workspaceFrames,
          chatFrames: golden.chatFrames,
          deniedFrames: golden.deniedFrames,
        }));
      } finally {
        db.close();
        restoreClock();
      }
    });
  }

  it("projects a full store task object to exactly the six routing fields", async () => {
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    const agent = store.createAgent({ name: "Projection", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "p".repeat(128 * 1024) });
    const delivered: any[] = [];
    const receiver = createPeerChannel({ url: "http://fake-receiver", origin: "receiver" });
    receiver.subscribe("realtime", (event) => delivered.push(event));
    const sender = createPeerChannel({ url: "http://fake-receiver", origin: "sender",
      fetchImpl: async (_url, init) => {
        const batch = JSON.parse(String(init.body));
        receiver.receive(batch.topic, batch.events);
        return new Response("{}");
      },
    });
    let listener!: Parameters<MultiremiStore["onTaskMessages"]>[0];
    const subscribe = store.onTaskMessages.bind(store);
    store.onTaskMessages = (handler) => { listener = handler; return subscribe(handler); };
    const fanout = createRealtimeFanout({ store, role: "runtime", peer: sender,
      registries: { browser: new Map(), browserScope: new Map(), browserUser: new Map(), daemon: new Map() },
    });
    try {
      const messages = store.appendTaskMessages(task.id, [{ type: "text", content: "six fields" }]);
      listener({ task, messages });
      await until(() => delivered.length === 2);
      for (const event of delivered) expect(Object.keys(event.payload.task).sort()).toEqual(SUBJECT_FIELDS);
    } finally { fanout.close(); receiver.close(); db.close(); }
  });
});

describe("peer real store serialized burst bound", () => {
  for (const escaped of [false, true]) {
    it(`keeps two same-tick 256-message reports complete and ordered within ${BYTE_BOUND} B (${escaped ? "escaped" : "plain"})`, async () => {
      const db = new Database(":memory:");
      const store = new MultiremiStore(db);
      const agent = store.createAgent({ name: "Burst", provider: "codex" });
      const task = store.createTask({ agentId: agent.id, prompt: "p".repeat(128 * 1024) });
      const local = fanoutBrowserClient("local");
      const remote = fanoutBrowserClient("local");
      const receiver = createPeerChannel({ url: "http://fake-sender", origin: "receiver" });
      let peak = 0;
      let samples = 0;
      const sample = () => {
        const stats = sender.stats();
        peak = Math.max(peak, stats.queued_bytes + stats.inflight_bytes);
        samples++;
        expect(stats.queued_bytes + stats.inflight_bytes).toBeLessThanOrEqual(BYTE_BOUND);
      };
      let largestPost = 0;
      let receivingReference = false;
      const sender = createPeerChannel({ url: "http://fake-receiver", origin: "sender",
        fetchImpl: async (_url, init) => {
          sample();
          largestPost = Math.max(largestPost, Buffer.byteLength(String(init.body)));
          const batch = JSON.parse(String(init.body));
          receivingReference = true;
          try {
            receiver.receive(batch.topic, batch.events, { epoch: batch.epoch, batchSeq: batch.batch_seq });
          } finally { receivingReference = false; }
          sample();
          return new Response("{}");
        },
      });
      const registries = (client: typeof local) => ({
        browser: new Map([["local", new Set([client.client])]]),
        browserScope: new Map(), browserUser: new Map(), daemon: new Map(),
      });
      const localFanout = createRealtimeFanout({ store, role: "ui", peer: sender, registries: registries(local) });
      const receiverStore = new MultiremiStore(db);
      const remoteFanout = createRealtimeFanout({ store: receiverStore, role: "ui", peer: receiver, registries: registries(remote) });
      const content = escaped
        ? '"\\\n\u0001'.repeat(Math.floor((PEER_MAX_EVENT_BYTES - 2048) / 12))
        : "x".repeat(256 * 1024);
      const messages = Array.from({ length: 256 }, () => ({ type: "assistant" as const, content }));
      const query = db.query.bind(db);
      let messageReads = 0;
      const referenceSizes: number[] = [];
      db.query = ((sql: string) => {
        if (receivingReference && /SELECT \* FROM multiremi_task_messages WHERE task_id =/i.test(sql)) {
          messageReads++;
          expect(sql).toContain("seq >");
          expect(sql).toContain("seq <=");
          expect(sql).toContain("ORDER BY seq ASC");
          expect(sql).toContain("LIMIT ?");
        }
        return query(sql);
      }) as typeof db.query;
      try {
        receiver.subscribe("realtime", (event: any) => {
          if (event.payload.seq_start !== undefined) referenceSizes.push(event.payload.seq_end - event.payload.seq_start + 1);
        });
        store.appendTaskMessages(task.id, messages);
        sample();
        expect(sender.stats().queued_bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
        store.appendTaskMessages(task.id, messages);
        sample();
        await until(() => sender.stats().queued === 0 && sender.stats().inflight === 0 && sender.stats().sent > 0);
        expect(remote.frames).toEqual(local.frames);
        expect(remote.frames).toHaveLength(512);
        expect(remote.frames.map((frame) => JSON.parse(frame).payload.seq)).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
        expect(sender.stats().dropped).toBe(0);
        expect(sender.stats().oversize_dropped).toBe(0);
        expect(sender.stats().degraded).toBeGreaterThan(0);
        expect(receiver.stats().degraded_received).toBe(sender.stats().degraded);
        expect(messageReads).toBe(referenceSizes.reduce((sum, rows) => sum + Math.ceil(rows / receiverStore.getTaskMessagePageRows()), 0));
        expect(largestPost).toBeLessThanOrEqual(1_048_576);
        console.log(`PEER_STORE_BOUND ${JSON.stringify({ escaped, peak, samples, frames: remote.frames.length, largestPost, messageReads, degraded: sender.stats().degraded })}`);
      } finally {
        db.query = query;
        localFanout.close(); remoteFanout.close(); receiver.close(); db.close();
      }
    }, 20_000);
  }
});
