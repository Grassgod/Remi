import { createResponsibleTestIssue } from './helpers.js';
/**
 * MUL-405 (QA round 2, item 2): every real path that can take more than one of
 * the three lock classes must take them in the contract order
 *
 *   W workspace lifecycle row lock  ->  N number-allocation lock  ->  D domain
 *
 * QA proved the old test could not see an order violation on a path it did not
 * record: deleting the workspace lock from `createIssueWithinTransaction` left
 * the two recorded paths green, because both of them take W before they call
 * into the Issues repo. This file records each path separately and asserts the
 * classification is monotonic, so any single path that reorders its locks goes
 * red on its own line.
 *
 * The trace comes from the real store methods, not from a paraphrase of them:
 * a recording `SqlDatabase` wraps a real in-memory SQLite store and classifies
 * every statement it sees. SQLite has no advisory xact lock, so the wrapper
 * supplies the no-op the production code documents and records the key — the
 * same technique `mul405-lock-order.test.ts` uses for its interleave.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { PostgresSyncDatabase, type SqlDatabase, type SqlStatement } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { resolveSqlDialect } from "@multiremi/store/migrations.js";
import { classifyLockOrderStatement, type LockOrderClass } from "@multiremi/store/lock-order-sentinel.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import type { FeishuBotRepo } from "@multiremi/store/repos/feishu-bot-repo.js";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

type LockClass = LockOrderClass;

class LockRecordingDatabase implements SqlDatabase {
  readonly trace: Array<{ cls: LockClass; key: string; depth: number }> = [];
  failAuditInsert = false;
  // Like the sentinel, nested calls share their outermost transaction frame.
  readonly frames: Array<LockRecordingDatabase["trace"]> = [];
  private depth = 0;
  constructor(private readonly inner: SqlDatabase) {}

  get dialect(): SqlDatabase["dialect"] {
    return this.inner.dialect;
  }

  get currentDepth(): number {
    return this.depth;
  }

  private record(cls: LockClass, key: string): void {
    const entry = { cls, key, depth: this.depth };
    this.trace.push(entry);
    if (this.depth > 0) this.frames[this.frames.length - 1]!.push(entry);
  }

  private classify(sql: string): void {
    for (const cls of classifyLockOrderStatement(sql)) {
      this.record(cls, cls === "W" ? "workspace-lifecycle" : sql.replace(/\s+/g, " ").slice(0, 80));
    }
  }

  query(sql: string): SqlStatement {
    return this.statement(sql, this.inner.query(sql));
  }
  prepare(sql: string): SqlStatement {
    return this.statement(sql, this.inner.prepare(sql));
  }
  private statement(sql: string, statement: SqlStatement): SqlStatement {
    return new Proxy(statement, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (["get", "all", "run", "values"].includes(String(property))) {
          return (...args: unknown[]) => {
            this.classify(sql);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  run(sql: string, ...params: unknown[]) {
    this.classify(sql);
    if (this.failAuditInsert && /^\s*INSERT INTO multiremi_feishu_bot_audit\b/i.test(sql)) {
      throw new Error("injected audit insert failure");
    }
    return this.inner.run(sql, ...params as never[]);
  }
  exec(sql: string): void {
    this.classify(sql);
    this.inner.exec(sql);
  }
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.inner.transaction((...args: any[]) => {
      const outermost = this.depth === 0;
      if (outermost) this.frames.push([]);
      this.depth += 1;
      try {
        return fn(...args);
      } finally {
        this.depth -= 1;
      }
    }) as (...args: any[]) => T;
  }
  get inTransaction(): boolean {
    return this.inner.inTransaction === true;
  }
  advisoryXactLock(key: string): void {
    this.record("N", key);
    this.inner.advisoryXactLock?.(key);
  }
  close(): void {
    this.inner.close();
  }
}

let openDbs: Array<Database | PostgresSyncDatabase> = [];
let pgDatabases: string[] = [];
let previousEncryptionKey: string | undefined;
let previousJobs: string | undefined;
let previousKinds: string | undefined;

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  if (pgDatabases.length) {
    const admin = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    try {
      for (const name of pgDatabases) admin.exec(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      admin.close();
      pgDatabases = [];
    }
  }
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousJobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS;
  else process.env.MULTIREMI_BACKGROUND_JOBS = previousJobs;
  if (previousKinds === undefined) delete process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS;
  else process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS = previousKinds;
});

function freshStore(): { store: MultiremiStore; recorder: LockRecordingDatabase } {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  let db: Database | PostgresSyncDatabase;
  // Exercise SQLite probes while retaining the real-PG-only frame test below.
  const adminUrl = process.env.MULTIREMI_TEST_LOCK_ORDER_BACKEND === "sqlite"
    ? undefined : process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (adminUrl) {
    const name = `mul405_path_${process.pid}_${Date.now()}_${pgDatabases.length}`;
    const admin = new PostgresSyncDatabase(adminUrl);
    try { admin.exec(`CREATE DATABASE ${name}`); } finally { admin.close(); }
    pgDatabases.push(name);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    db = new PostgresSyncDatabase(url.toString());
  } else db = openSqliteDatabase(":memory:");
  openDbs.push(db);
  const recorder = new LockRecordingDatabase(db);
  expect(recorder.dialect).toBe(db instanceof PostgresSyncDatabase ? "postgres" : "sqlite");
  // Reuse QA's native-PG proxy: preserve instanceof/dialect and afterCommit.
  const recordedMethods = new Set(["query", "prepare", "run", "exec", "transaction", "advisoryXactLock"]);
  const recordedDb = db instanceof PostgresSyncDatabase ? new Proxy(db, {
    get(target, property) {
      const owner = recordedMethods.has(String(property)) ? recorder : target;
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  }) : recorder;
  expect(resolveSqlDialect(recordedDb)).toBe(db instanceof PostgresSyncDatabase ? "postgres" : "sqlite");
  const store = new MultiremiStore(recordedDb);
  store.ensureLocalWorkspace();
  return { store, recorder };
}

/** A workspace with an agent and a Runtime that can host a Feishu bot. */
function scaffold(): ReturnType<typeof freshStore> & { agentId: string; runtimeId: string; revision: number } {
  const { store, recorder } = freshStore();
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  const runtimeId = "rt_lock_paths";
  store.registerRuntime({ id: runtimeId, name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "lock-paths-host" });
  store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId,
    appId: "cli_lock_paths",
    senderAccessPolicy: "allowlist",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", runtimeId, { appliedRevision: config.revision, state: "online" });
  store.replaceFeishuBotAgentRoutes("local", [{ scope: "chat", chatId: "oc_lock_paths", agentId: agent.id }]);
  return { store, recorder, agentId: agent.id, runtimeId, revision: config.revision };
}

function splitReceiptFixture() {
  previousJobs = process.env.MULTIREMI_BACKGROUND_JOBS;
  previousKinds = process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS;
  process.env.MULTIREMI_BACKGROUND_JOBS = "1";
  process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS = "1";
  const fixture = scaffold();
  fixture.store.submitFeishuBotMessage("local", fixture.runtimeId, {
    revision: fixture.revision,
    externalSessionKey: "oc_lock_paths:thread:omt_receipt",
    externalMessageId: "om_lock_receipt",
    chatType: "group",
    chatId: "oc_lock_paths",
    threadId: "omt_receipt",
    senderOpenId: "ou_lock_paths",
    text: "receipt lock order",
    deliveryMode: "native_cot_v1",
  });
  const receipt = fixture.store.claimFeishuBotOutbounds("local", fixture.runtimeId)
    .find((row) => row.kind === "receipt");
  expect(receipt).toBeDefined();
  return { ...fixture, receipt: receipt! };
}

function outboundStatus(recorder: LockRecordingDatabase, id: string): string {
  return (recorder.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
    .get(id) as { status: string }).status;
}

function expectDepthOne(): void {
  const db = openDbs.at(-1);
  if (db instanceof PostgresSyncDatabase) expect(db.maxTransactionDepth).toBe(1);
}

/**
 * The contract, read the way a deadlock reads it: the FIRST acquisition of each
 * class must be ordered W -> N -> D. A class that appears before a class it must
 * follow is exactly the inversion the cycle needed (D before N is the Feishu
 * bot's old sender-UPSERT-before-number-lock; N before W was the Autopilot
 * path).
 *
 * Re-taking a lock the transaction already holds is deliberately not a
 * violation: Postgres advisory locks and the workspace row lock are free to
 * re-take inside the same transaction, and the store relies on that (the Feishu
 * bot takes W, then the Task writer takes W again; the audit writer re-takes the
 * audit number lock its caller already holds). Only the first acquisition can
 * participate in a cycle, so only the first is ordered here. Consumers that must
 * not silently lose a lock assert its presence separately per path.
 */
const RANK: Record<LockClass, number> = { W: 0, N: 1, D: 2 };

function firstAcquisitions(trace: LockRecordingDatabase["trace"]): LockRecordingDatabase["trace"] {
  const seen = new Set<LockClass>();
  const first: LockRecordingDatabase["trace"] = [];
  for (const entry of trace) {
    if (seen.has(entry.cls)) continue;
    seen.add(entry.cls);
    first.push(entry);
  }
  return first;
}

/**
 * Assert one path's lock discipline: the classes it MUST take are all present,
 * and the first acquisition of each is monotonic W -> N -> D.
 *
 * `required` is the whole point of naming it per path: QA round 3 deleted the W
 * from `recordAuditWithinTransaction` and the eleven cases stayed green, because
 * `recordAudit standalone` only checked monotonicity and an empty trace is
 * trivially monotonic. A path that must take W now fails when W disappears.
 */
function assertPath(
  label: string,
  recorder: LockRecordingDatabase,
  required: readonly LockClass[],
): void {
  const matches = recorder.frames.filter((frame) => {
    const present = new Set(frame.map((entry) => entry.cls));
    return required.every((cls) => present.has(cls));
  });
  if (matches.length === 0) {
    const detail = recorder.trace.length
      ? recorder.trace.map((e) => `${e.cls} ${e.key}`).join("\n  ")
      : "(no locks recorded)";
    const seen = recorder.frames.map((frame) => [...new Set(frame.map((e) => e.cls))].join(","));
    throw new Error(
      `${label} has no transaction that took all required lock(s) ${required.join(", ")}; ` +
        `per-transaction classes: ${seen.join(" | ") || "(none)"}\n  ${detail}`,
    );
  }
  // Every transaction the path opened must itself be monotonic; a path that
  // opens its own transaction (MUL-409's automatic start does) asserts on the
  // frames, not on a concatenation of them.
  for (const frame of recorder.frames) assertMonotonic(label, frame);
}

function assertFrames(
  label: string,
  recorder: LockRecordingDatabase,
  expected: readonly (readonly LockClass[])[],
): void {
  expect(recorder.frames.length).toBe(expected.length);
  recorder.frames.forEach((frame, index) => {
    assertMonotonic(`${label} transaction ${index + 1}`, frame);
    expect(firstAcquisitions(frame).map((entry) => entry.cls)).toEqual([...expected[index]!]);
    expect(frame.every((entry) => entry.depth === 1)).toBe(true);
  });
}

function assertMonotonic(label: string, trace: LockRecordingDatabase["trace"]): void {
  const first = firstAcquisitions(trace);
  let highest = -1;
  for (const entry of first) {
    const rank = RANK[entry.cls];
    if (rank < highest) {
      const detail = trace.map((e, i) => `${i === 0 ? " " : " "} ${e.cls} ${e.key}`).join("\n");
      throw new Error(
        `${label} violates W -> N -> D: first ${entry.cls} acquisition comes after a higher class.\n` +
          `first acquisitions: ${first.map((e) => e.cls).join(" -> ")}\ntrace:\n${detail}`,
      );
    }
    highest = Math.max(highest, rank);
  }
}

function clear(recorder: LockRecordingDatabase): void {
  recorder.trace.length = 0;
  recorder.frames.length = 0;
}

/** One ingested messaging-core message, so the outcome service has a target. */
function seedMessaging(
  store: MultiremiStore,
  ref: { connectionId: string; externalMessageId: string },
): void {
  store.messaging.upsertConnection({
    id: ref.connectionId, workspaceId: "local", provider: "test_provider", channel: "test_channel",
    name: "Lock paths connection", status: "ready",
  });
  store.messaging.upsertSource({
    id: "msrc_lock_paths", workspaceId: "local", connectionId: ref.connectionId, name: "Lock paths source",
    allowlist: [{ externalConversationId: "conversation_lock_paths", addedAt: "2026-09-01T00:00:00.000Z" }],
  });
  const message: CanonicalMessage = {
    externalMessageId: ref.externalMessageId,
    externalConversationId: "conversation_lock_paths",
    conversationName: "Lock paths chat",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: { externalSenderId: "sender_lock_paths", displayName: "Sender", kind: "user", isSelf: false },
    text: "the API is down again",
    attachments: [],
    mentions: [],
    reactions: [],
    url: "https://example.invalid/m/external_lock_paths",
    sentAt: "2026-09-01T10:00:00.000Z",
    editedAt: null,
    recalled: false,
    raw: {},
  };
  store.messaging.ingestMessages({
    connectionId: ref.connectionId,
    sourceId: "msrc_lock_paths",
    messages: [message],
  });
}

/** One ingested legacy Feishu message, so the ingest outcomes have a target. */
function seedFeishuIngest(store: MultiremiStore): { messageId: string } {
  const source = store.createFeishuSource({
    workspaceId: "local",
    name: "Lock paths feishu",
    endpointName: "local",
    allowlist: [{ chatId: "oc_lock_ingest", addedAt: "2026-09-01T00:00:00.000Z" }],
  });
  const messageId = "om_lock_ingest";
  const input: IngestedFeishuMessageInput = {
    messageId,
    chatId: "oc_lock_ingest",
    chatName: "Lock paths group",
    chatType: "group",
    sender: { id: "ou_lock_ingest", display_name: "Wang" },
    content: { message_id: messageId, chat_id: "oc_lock_ingest", text: "deploy is stuck", create_time: "2026-09-01T10:00:00.000Z" },
    searchableText: "deploy is stuck",
    contentFingerprint: `fingerprint:${messageId}`,
    createdAt: "2026-09-01T10:00:00.000Z",
  };
  store.ingestFeishuBatch(source.id, [input]);
  return { messageId };
}

/** A store with one agent, for the paths that need an assignable owner. */
function freshStoreWithAgent(): { store: MultiremiStore; recorder: LockRecordingDatabase; agentId: string } {
  const { store, recorder } = freshStore();
  const agent = store.createAgent({ name: "Lock paths owner", provider: "codex", workspaceId: "local" });
  return { store, recorder, agentId: agent.id };
}

describe("MUL-405 per-path lock order", () => {
  it("direct createIssue: W -> N", () => {
    const { store, recorder } = freshStore();
    clear(recorder);
    createResponsibleTestIssue(store, { title: "direct", workspaceId: "local" });
    assertPath("direct createIssue", recorder, ["W", "N"]);
  });

  it("quick-create: W -> N", () => {
    const { store, recorder, agentId } = scaffold();
    clear(recorder);
    store.quickCreateIssue({ prompt: "quick create path", workspaceId: "local", agentId });
    assertPath("quickCreateIssue", recorder, ["W", "N"]);
  });

  it("Feishu bot message: W -> N -> sender row", () => {
    const { store, recorder, runtimeId, revision } = scaffold();
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_lock_paths" } } });
    clear(recorder);
    // The sender row is created here (D), and the issue number lock must
    // already be held when that happens.
    store.submitFeishuBotMessage("local", runtimeId, {
      revision,
      externalSessionKey: "oc_lock_paths:thread:omt_paths",
      externalMessageId: "om_paths_1",
      chatType: "group",
      chatId: "oc_lock_paths",
      threadId: "omt_paths",
      senderOpenId: "ou_lock_paths",
      text: "register the sender",
    });
    assertPath("submitFeishuBotMessage", recorder, ["W", "N", "D"]);
  });

  it("Autopilot create_issue: W -> N -> autopilot row", () => {
    const { store, recorder, agentId } = scaffold();
    const autopilot = store.createAutopilot({
      title: "Lock order automation",
      assigneeId: agentId,
      workspaceId: "local",
      executionMode: "create_issue",
      status: "active",
    });
    clear(recorder);
    store.runAutopilot(autopilot.id);
    assertPath("runAutopilot(create_issue)", recorder, ["W", "N", "D"]);
  });

  it("setSenderAllowed: W -> N -> sender row -> audit", () => {
    const { store, recorder, runtimeId, revision } = scaffold();
    store.submitFeishuBotMessage("local", runtimeId, {
      revision,
      externalSessionKey: "oc_sender:thread:omt_sender",
      externalMessageId: "om_sender_1",
      chatType: "group",
      chatId: "oc_sender",
      threadId: "omt_sender",
      senderOpenId: "ou_sender_path",
      text: "register",
    });
    const sender = store.listFeishuBotSenders("local")[0]!;
    clear(recorder);
    store.setFeishuBotSenderAllowed("local", sender.id, true, "local");
    assertPath("setSenderAllowed", recorder, ["W", "N", "D"]);
    assertFrames("setSenderAllowed", recorder, [["W", "N", "D"]]);
  });

  it("recordAudit standalone: W -> N", () => {
    const { store, recorder } = scaffold();
    clear(recorder);
    store.recordFeishuBotAudit("local", "updated", { actorId: "local", details: { probe: true } });
    // QA round 3: this case used to assert monotonicity only, so deleting the W
    // from recordAuditWithinTransaction left all eleven cases green.
    assertPath("recordFeishuBotAudit", recorder, ["W", "N", "D"]);
    assertFrames("recordFeishuBotAudit", recorder, [["W", "N", "D"]]);
  });

  it("claimOutbound exhausted receipt: W -> N -> D in one transaction", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    const now = new Date(Date.now() + 121_000);
    recorder.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET attempt_count = 6, leased_until = ? WHERE id = ?",
      new Date(now.getTime() - 1_000).toISOString(), receipt.id);
    clear(recorder);
    const db = openDbs.at(-1);
    if (db instanceof PostgresSyncDatabase) db.resetTransactionDepthStats();
    store.claimFeishuBotOutbound("local", runtimeId, now, true, true, true, true);
    assertFrames("claimOutbound exhausted receipt", recorder, [["W", "N", "D"]]);
    expectDepthOne();
    expect(outboundStatus(recorder, receipt.id)).toBe("failed");
  });

  it("claimOutbound without an exhausted receipt: W -> D", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    recorder.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET status = 'pending', available_at = ? WHERE id = ?",
      new Date(Date.now() - 1_000).toISOString(), receipt.id);
    clear(recorder);
    store.claimFeishuBotOutbound("local", runtimeId, new Date(), true, true, true, true);
    assertFrames("claimOutbound ordinary delivery", recorder, [["W", "D"]]);
  });

  it("reportOutbound terminal receipt: W -> N -> D in one transaction", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    clear(recorder);
    const db = openDbs.at(-1);
    if (db instanceof PostgresSyncDatabase) db.resetTransactionDepthStats();
    expect(store.reportFeishuBotOutbound("local", runtimeId, receipt.id,
      { claimToken: receipt.claimToken, status: "failed", retryable: false })).toBe(true);
    assertFrames("reportOutbound terminal receipt", recorder, [["W", "N", "D"]]);
    expectDepthOne();
  });

  it("reportOutbound retryable receipt: D only", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    clear(recorder);
    expect(store.reportFeishuBotOutbound("local", runtimeId, receipt.id,
      { claimToken: receipt.claimToken, status: "failed", retryable: true })).toBe(true);
    assertFrames("reportOutbound retryable receipt", recorder, [["D"]]);
  });

  it("claimOutbound rolls back exhausted receipt when audit insert fails", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    const now = new Date(Date.now() + 121_000);
    recorder.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET attempt_count = 6, leased_until = ? WHERE id = ?",
      new Date(now.getTime() - 1_000).toISOString(), receipt.id);
    recorder.failAuditInsert = true;
    expect(() => store.claimFeishuBotOutbound("local", runtimeId, now, true, true, true, true))
      .toThrow("injected audit insert failure");
    expect(outboundStatus(recorder, receipt.id)).toBe("sending");
  });

  it("reportOutbound rolls back terminal receipt when audit insert fails", () => {
    const { store, recorder, runtimeId, receipt } = splitReceiptFixture();
    recorder.failAuditInsert = true;
    expect(() => store.reportFeishuBotOutbound("local", runtimeId, receipt.id,
      { claimToken: receipt.claimToken, status: "failed", retryable: false }))
      .toThrow("injected audit insert failure");
    expect(outboundStatus(recorder, receipt.id)).toBe("sending");
  });

  it("exhausted sweep updates only the selected ids", () => {
    const { store, recorder, receipt } = splitReceiptFixture();
    const other = recorder.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE id <> ? AND delivery_mode = 'split' LIMIT 1")
      .get(receipt.id) as { id: string };
    const now = new Date(Date.now() + 121_000).toISOString();
    recorder.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET attempt_count = 6, leased_until = ? WHERE id IN (?, ?)",
      new Date(Date.parse(now) - 1_000).toISOString(), receipt.id, other.id);
    const repo = (store as unknown as { feishuBot: FeishuBotRepo }).feishuBot as unknown as {
      sweepExhaustedWithinTransaction(workspaceId: string, ids: string[], nowIso: string): Array<{ id: string }>;
    };
    const changed = recorder.transaction(() => repo.sweepExhaustedWithinTransaction("local", [receipt.id], now))();
    expect(changed.map((row) => row.id)).toEqual([receipt.id]);
    expect(outboundStatus(recorder, receipt.id)).toBe("failed");
    expect(outboundStatus(recorder, other.id)).toBe("sending");
  });

  it("createPinnedItem: W -> N", () => {
    const { store, recorder } = freshStore();
    const issue = createResponsibleTestIssue(store, { title: "pin me", workspaceId: "local" });
    clear(recorder);
    store.createPinnedItem({
      workspaceId: "local",
      userId: "local",
      itemType: "issue",
      itemId: issue.id,
    });
    assertPath("createPinnedItem", recorder, ["W", "N", "D"]);
  });

  it("messaging outcomes createIssue: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const ref = { connectionId: "mconn_lock_paths", externalMessageId: "external_lock_paths" };
    seedMessaging(store, ref);
    clear(recorder);
    store.messagingOutcomes.createIssue(ref, { workspaceId: "local", title: "Outcome Issue" });
    assertPath("messagingOutcomes.createIssue", recorder, ["W", "N", "D"]);
  });

  it("messaging outcomes approveProposal: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const ref = { connectionId: "mconn_lock_paths", externalMessageId: "external_lock_paths" };
    seedMessaging(store, ref);
    const member = store.createWorkspaceMember({ name: "Reviewer" });
    const proposal = store.messagingOutcomes.proposeIssue(ref, {
      workspaceId: "local", title: "Proposed Issue",
      recipientId: member.id, actorType: "member", actorId: member.id,
    });
    clear(recorder);
    store.messagingOutcomes.approveProposal(proposal.proposal!.id, {
      workspaceId: "local", approvedBy: member.id,
    });
    assertPath("messagingOutcomes.approveProposal", recorder, ["W", "N", "D"]);
  });

  it("Feishu ingest createIssueOutcome: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const { messageId } = seedFeishuIngest(store);
    clear(recorder);
    store.createFeishuIssueOutcome(messageId, { workspaceId: "local", title: "Ingest Issue" });
    assertPath("createFeishuIssueOutcome", recorder, ["W", "N", "D"]);
  });

  it("Feishu ingest approveIssueProposal: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const { messageId } = seedFeishuIngest(store);
    const member = store.createWorkspaceMember({ name: "Feishu reviewer" });
    const proposal = store.createFeishuIssueProposal(messageId, {
      workspaceId: "local", title: "Feishu proposed Issue",
      recipientId: member.id, actorType: "member", actorId: member.id,
    });
    clear(recorder);
    store.approveFeishuIssueProposal(proposal.proposal!.id, {
      workspaceId: "local", approvedBy: member.id,
    });
    assertPath("approveFeishuIssueProposal", recorder, ["W", "N", "D"]);
  });

  it("archiveAgent: W -> N -> agent row -> Feishu audit", () => {
    const { store, recorder, agentId } = scaffold();
    // The cascade reaches the Feishu audit writer, so this path takes N too
    // (QA round 3 found it running W -> D -> N).
    clear(recorder);
    store.archiveAgent(agentId);
    assertPath("archiveAgent", recorder, ["W", "N", "D"]);
  });

  it("Runtime cascade delete: W -> N -> config row -> Feishu audit", () => {
    const { store, recorder, runtimeId } = scaffold();
    // The "last managed daemon Runtime" guard refuses to delete the only one, so
    // plant a spare: QA's probe was blocked by that guard and could not reach the
    // audit. The spare must belong to a different daemon id.
    store.registerRuntime({
      id: "rt_lock_paths_spare", name: "Spare host", provider: "codex",
      workspaceId: "local", daemonId: "lock-paths-host",
    });
    clear(recorder);
    const result = store.deleteRuntimeWithArchivedAgentCleanup(runtimeId);
    expect(result.status).toBe("deleted");
    assertPath("deleteRuntimeWithArchivedAgentCleanup", recorder, ["W", "N", "D"]);
  });

  it("updateIssueWithinTransaction: W -> issue row, and it takes no number lock", () => {
    const { store, recorder } = freshStore();
    const issue = createResponsibleTestIssue(store, { title: "MUL-457 write path", workspaceId: "local" });
    clear(recorder);
    // Moves the Issue into a project, which is the branch that takes the
    // workspace lifecycle lock before the Issue row lock. The path never creates
    // a child Issue or writes the audit trail, so N must NOT appear.
    const project = store.createProject({ title: "Lock paths project", workspaceId: "local" });
    clear(recorder);
    store.updateIssue(issue.id, { projectId: project.id });
    assertPath("updateIssue(projectId)", recorder, ["W", "D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
  });

  it("grantParentDone: W (via the issue lock) then issue row, no number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const issue = createResponsibleTestIssue(store, {
      title: "Parent-done target", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
    });
    clear(recorder);
    store.grantParentDone(issue.id, "local");
    // The `UPDATE ... SET id = id` row lock is the first acquisition; this path
    // does not write the Feishu audit trail or create a child Issue, so N must
    // not appear.
    assertPath("grantParentDone", recorder, ["D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(false);
  });

  it("revokeParentDone: issue row lock only, no number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const issue = createResponsibleTestIssue(store, {
      title: "Parent-done revoke target", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
    });
    store.grantParentDone(issue.id, "local");
    clear(recorder);
    store.revokeParentDone(issue.id, "local");
    assertPath("revokeParentDone", recorder, ["D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(false);
  });

  // ── MUL-409 (main bbc964c9): the dependency gate's new transaction paths ──
  //
  // Each one is checked for a number lock before it is classified: none of them
  // creates an Issue or writes the Feishu audit trail, so N must NOT appear and
  // the required set is {W, D} (or {D} where the path takes only the Issue row).

  it("MUL-409 forced start: W -> issue row -> round, no number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const prereq = createResponsibleTestIssue(store, { title: "Prereq", workspaceId: "local", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "Forced dependent", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
      blockedBy: [prereq.id],
    });
    clear(recorder);
    // The member override flips backlog -> todo despite the unmet prerequisite.
    store.updateIssue(dependent.id, {
      status: "todo", force: true, actorType: "member", actorId: "local",
    });
    assertPath("MUL-409 forced start", recorder, ["W", "D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
  });

  it("MUL-409 automatic start: W -> issue row -> round, no number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const prereq = createResponsibleTestIssue(store, { title: "Prereq", workspaceId: "local", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "Auto dependent", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
      blockedBy: [prereq.id],
    });
    clear(recorder);
    store.updateIssue(prereq.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
    assertFrames("MUL-409 automatic start", recorder, [["W", "D"], ["W", "D"]]);
    assertPath("MUL-409 automatic start", recorder, ["W", "D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
  });

  it("MUL-409 session task creation: W -> participant row -> task, no number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const issue = createResponsibleTestIssue(store, {
      title: "Session task host", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
    });
    const session = store.createIssueSession(issue.id, { title: "Lane" });
    clear(recorder);
    store.createSessionTask(session.id, { agentId, prompt: "session round" });
    // before the merge this was D (participant INSERT) -> W; the sentinel caught
    // it on MUL-409's own Postgres probe.
    assertPath("MUL-409 session task", recorder, ["W", "D"]);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
  });

  it("MUL-409 standalone dependency write: D only, no workspace or number lock", () => {
    const { store, recorder, agentId } = freshStoreWithAgent();
    const prereq = createResponsibleTestIssue(store, { title: "Prereq", workspaceId: "local", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "Dependency writer", workspaceId: "local",
      assigneeType: "agent", assigneeId: agentId,
    });
    clear(recorder);
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });
    // This entry point opens its own transaction for the edge row alone: it
    // reads both Issues, writes `multiremi_issue_dependencies` (D) and never
    // takes the workspace row lock or a number lock.
    assertPath("MUL-409 createIssueDependency", recorder, ["D"]);
    assertFrames("MUL-409 createIssueDependency", recorder, [["D"]]);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(false);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(false);
  });

  it("MUL-409 messaging outcome joins its creation owner: W -> N -> D", () => {
    const { store, recorder } = freshStore();
    const ref = { connectionId: "conn_owner_lock", externalMessageId: "msg_owner_lock" };
    seedMessaging(store, ref);
    const original = store.messaging.recordOutcomeWithinTransaction;
    const depths: number[] = [];
    store.messaging.recordOutcomeWithinTransaction = function (input) {
      depths.push(recorder.currentDepth);
      return original.call(this, input);
    };
    clear(recorder);
    try {
      expect(store.messagingOutcomes.createIssue(ref, { workspaceId: "local", title: "Owner outcome" }).created).toBe(true);
    } finally {
      store.messaging.recordOutcomeWithinTransaction = original;
    }
    expect(depths).toEqual([1]);
    assertPath("MUL-409 messaging owner", recorder, ["W", "N", "D"]);
    assertFrames("MUL-409 messaging owner", recorder, [["W", "N", "D"]]);
    expect(store.messaging.listOutcomes(ref.connectionId, ref.externalMessageId)).toHaveLength(1);
  });
});

it.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("MUL-409 real PG: automatic start and dependency transaction frames", async () => {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL!;
  const database = `mul405_frames_${process.pid}_${Date.now()}`;
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const pg = new PostgresSyncDatabase(url.toString());
  const recorder = new LockRecordingDatabase(pg);
  // Preserve instanceof/dialect: auto-start must exercise its actual PG row lock.
  const recordedMethods = new Set(["query", "prepare", "run", "exec", "transaction", "advisoryXactLock"]);
  const recordedPg = new Proxy(pg, {
    get(target, property) {
      const owner = recordedMethods.has(String(property)) ? recorder : target;
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
  expect(resolveSqlDialect(recordedPg)).toBe("postgres");
  try {
    const store = new MultiremiStore(recordedPg);
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "PG frame owner", provider: "codex", workspaceId: "local" });
    const prerequisite = createResponsibleTestIssue(store, { title: "PG prerequisite", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "PG dependent", assigneeType: "agent", assigneeId: agent.id, status: "backlog",
    });
    clear(recorder);
    pg.resetTransactionDepthStats();
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
    assertFrames("PG createIssueDependency", recorder, [["D"]]);
    expect(pg.maxTransactionDepth).toBe(1);
    console.info("MUL-409 PG dependency frames", JSON.stringify(recorder.frames.map(firstAcquisitions)));

    clear(recorder);
    pg.resetTransactionDepthStats();
    store.updateIssue(prerequisite.id, { status: "done" });
    assertFrames("PG automatic start", recorder, [["W", "D"], ["W", "D"]]);
    expect(pg.maxTransactionDepth).toBe(1);
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
    console.info("MUL-409 PG automatic-start frames", JSON.stringify(recorder.frames.map(firstAcquisitions)));
  } finally {
    pg.close();
    await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
