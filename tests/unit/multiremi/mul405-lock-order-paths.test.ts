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
import { Database } from "bun:sqlite";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

type LockClass = "W" | "N" | "D";

/** `UPDATE multiremi_workspaces SET updated_at = updated_at ...` — the W lock. */
const WORKSPACE_ROW_LOCK = /UPDATE\s+multiremi_workspaces\s+SET\s+updated_at\s*=\s*updated_at/i;
/**
 * Domain row locks this suite cares about: the no-op UPDATE/UPSERT whose only
 * purpose is to serialize two writers of the same row. Ordinary writes are not
 * locks and are recorded as D only when they are the known lock statements.
 */
const DOMAIN_LOCK_PATTERNS: RegExp[] = [
  /UPDATE\s+multiremi_message_messages\s+SET\s+processed_at\s*=\s*processed_at/i,
  /UPDATE\s+multiremi_feishu_messages\s+SET\s+processed_at\s*=\s*processed_at/i,
  /UPDATE\s+multiremi_autopilots\s+SET\s+updated_at\s*=\s*updated_at/i,
  /UPDATE\s+multiremi_feishu_bot_senders\s+SET\s+allowed/i,
  /INSERT\s+INTO\s+multiremi_feishu_bot_senders/i,
];

class LockRecordingDatabase implements SqlDatabase {
  readonly trace: Array<{ cls: LockClass; key: string }> = [];
  constructor(private readonly inner: Database) {}

  private record(cls: LockClass, key: string): void {
    this.trace.push({ cls, key });
  }

  private classify(sql: string, kind: "read" | "write"): void {
    if (WORKSPACE_ROW_LOCK.test(sql)) this.record("W", "workspace-lifecycle");
    else if (DOMAIN_LOCK_PATTERNS.some((pattern) => pattern.test(sql))) {
      this.record("D", sql.replace(/\s+/g, " ").slice(0, 60));
    } else if (kind === "write") {
      // Non-locking writes are domain operations too, but they are not the D
      // locks this contract is about; recording them would drown the signal.
    }
  }

  query(sql: string): SqlStatement {
    this.classify(sql, "read");
    return this.inner.query(sql);
  }
  prepare(sql: string): SqlStatement {
    this.classify(sql, "read");
    return this.inner.prepare(sql);
  }
  run(sql: string, ...params: unknown[]) {
    this.classify(sql, "write");
    return this.inner.run(sql, ...params as never[]);
  }
  exec(sql: string): void {
    this.classify(sql, "write");
    this.inner.exec(sql);
  }
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.inner.transaction(fn) as (...args: any[]) => T;
  }
  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }
  advisoryXactLock(key: string): void {
    this.record("N", key);
  }
  close(): void {
    this.inner.close();
  }
}

let openDbs: Database[] = [];
let previousEncryptionKey: string | undefined;

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
});

function freshStore(): { store: MultiremiStore; recorder: LockRecordingDatabase } {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  const db = new Database(":memory:");
  openDbs.push(db);
  const recorder = new LockRecordingDatabase(db);
  const store = new MultiremiStore(recorder as unknown as SqlDatabase);
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

describe("MUL-405 per-path lock order", () => {
  it("direct createIssue: W -> N", () => {
    const { store, recorder } = freshStore();
    clear(recorder);
    store.createIssue({ title: "direct", workspaceId: "local" });
    assertMonotonic("direct createIssue", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
  });

  it("quick-create: W -> N", () => {
    const { store, recorder, agentId } = scaffold();
    clear(recorder);
    store.quickCreateIssue({ prompt: "quick create path", workspaceId: "local", agentId });
    assertMonotonic("quickCreateIssue", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
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
    assertMonotonic("submitFeishuBotMessage", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
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
    assertMonotonic("runAutopilot(create_issue)", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
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
    assertMonotonic("setSenderAllowed", recorder.trace);
    expect(recorder.trace.filter((entry) => entry.cls === "N").length).toBeGreaterThan(0);
  });

  it("recordAudit standalone: W -> N", () => {
    const { store, recorder } = scaffold();
    clear(recorder);
    store.recordFeishuBotAudit("local", "updated", { actorId: "local", details: { probe: true } });
    assertMonotonic("recordFeishuBotAudit", recorder.trace);
  });

  it("createPinnedItem: W -> N", () => {
    const { store, recorder } = freshStore();
    const issue = store.createIssue({ title: "pin me", workspaceId: "local" });
    clear(recorder);
    store.createPinnedItem({
      workspaceId: "local",
      userId: "local",
      itemType: "issue",
      itemId: issue.id,
    });
    assertMonotonic("createPinnedItem", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
  });

  it("messaging outcomes createIssue: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const ref = { connectionId: "mconn_lock_paths", externalMessageId: "external_lock_paths" };
    seedMessaging(store, ref);
    clear(recorder);
    store.messagingOutcomes.createIssue(ref, { workspaceId: "local", title: "Outcome Issue" });
    assertMonotonic("messagingOutcomes.createIssue", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
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
    assertMonotonic("messagingOutcomes.approveProposal", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
  });

  it("Feishu ingest createIssueOutcome: W -> N -> message row", () => {
    const { store, recorder } = freshStore();
    const { messageId } = seedFeishuIngest(store);
    clear(recorder);
    store.createFeishuIssueOutcome(messageId, { workspaceId: "local", title: "Ingest Issue" });
    assertMonotonic("createFeishuIssueOutcome", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
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
    assertMonotonic("approveFeishuIssueProposal", recorder.trace);
    expect(recorder.trace.some((entry) => entry.cls === "W")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "N")).toBe(true);
    expect(recorder.trace.some((entry) => entry.cls === "D")).toBe(true);
  });
});
