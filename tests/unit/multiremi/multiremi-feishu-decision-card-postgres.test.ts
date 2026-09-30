/**
 * MUL-407 decision-card lifecycle on real PostgreSQL.
 *
 * The SQLite suite covers the logic; real Postgres checks translated reminder
 * and claim SQL, concurrent delivery claims, and parameter type inference in
 * the settled bot-host snapshot query.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_dc407_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

function pgUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probe(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch { return false; }
}

const available = await probe();
if (!available) console.warn(`[multiremi-decision-card-postgres] Postgres unreachable at ${PG_ADMIN_URL} — skipping.`);

describe.skipIf(!available)("Feishu decision cards on Postgres (MUL-407)", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
    db = new PostgresSyncDatabase(pgUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    try { db?.close(); } catch { /* best effort */ }
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  // The Feishu bot is per-workspace, so each case gets its own workspace. That
  // keeps cases independent without sharing a bot config or a delivery queue.
  let workspaceSeq = 0;
  function newWorkspace() {
    workspaceSeq += 1;
    return store.createWorkspace({ id: `wspg407_${workspaceSeq}`, name: `PG ${workspaceSeq}`, slug: `pg407-${workspaceSeq}` });
  }

  /** A workspace with a configured bot, a seeded Issue topic, and one question. */
  function scaffold(timeoutMs?: number) {
    const workspace = newWorkspace();
    const workspaceId = workspace.id;
    const agentId = store.createAgent({ name: "PG Concierge", provider: "codex", workspaceId }).id;
    const runtimeId = `rt_pg407_${workspaceSeq}`;
    store.registerRuntime({ id: runtimeId, name: "Bot", provider: "codex", workspaceId, daemonId: `d-${runtimeId}` });
    store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
    const config = store.upsertFeishuBotConfig(workspaceId, {
      agentId, runtimeId, appId: "cli_pg407", appSecretOp: "set", appSecret: APP_SECRET, domain: "feishu", enabled: true,
    });
    store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
    store.updateWorkspace(workspaceId, {
      settings: { ...workspace.settings, issueTopics: { enabled: true, chatId: "oc_pg" } },
    });
    const issue = store.createIssue({ title: `PG ${workspaceSeq}`, workspaceId, assigneeType: "agent", assigneeId: agentId });
    store.prepareFeishuIssueTopicWithinTransaction(issue);
    const root = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    store.reportFeishuBotOutbound(workspaceId, runtimeId, root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${workspaceSeq}`,
    });
    const task = store.createTask({ agentId, issueId: issue.id, workspaceId, prompt: "W" });
    const request = store.createTaskHumanRequest({
      taskId: task.id, kind: "question",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
    });
    return { workspaceId, agentId, runtimeId, issue, task, request };
  }

  it("suppresses a reminder inside the final minute and allows it at 61s", () => {
    const { workspaceId, runtimeId, request } = scaffold(60 * 60 * 1000);
    const card = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    store.reportFeishuBotOutbound(workspaceId, runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_window",
      interactionOpenId: "ou_pg",
    });
    const expiresAt = Date.parse(store.getTaskHumanRequest(request.id)!.expiresAt!);
    // 30s and 20s left: inside the window, past the floor.
    expect(store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(expiresAt - 30_000))).toBeNull();
    expect(store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(expiresAt - 20_000))).toBeNull();
    // 61s left: one reminder.
    const reminder = store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(expiresAt - 61_000))!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.humanRequestId).toBe(request.id);
    // And never a second one.
    store.reportFeishuBotOutbound(workspaceId, runtimeId, reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_pg_reminder",
    }, new Date(expiresAt - 61_000));
    expect(store.claimFeishuBotOutbound(workspaceId, runtimeId, new Date(expiresAt - 10_000))).toBeNull();
  });

  it("claims the older relay row and then the degraded card that follows it", () => {
    // The fifth-round blocker on Postgres: the same two rows in one queue, the
    // same claim that has to tolerate the stored config. The tolerance is one
    // code path, but the row it claims and the settings blob it reads come from
    // a different backend, so the behaviour is asserted here too.
    const { workspaceId, agentId, runtimeId, issue, request: seededRequest } = scaffold();
    // Clear the scaffold's own card so the queue starts empty.
    const seeded = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    expect(seeded.humanRequestId).toBe(seededRequest.id);
    store.reportFeishuBotOutbound(workspaceId, runtimeId, seeded.id, {
      claimToken: seeded.claimToken, status: "sent", externalMessageId: "om_pg_seeded",
    });
    const binding = db.query(
      `SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = ? AND issue_id = ?`,
    ).get(workspaceId, issue.id) as { id: string };
    // A relay row from before MUL-407: a real Task id, no mention snapshot. Its
    // `created_at` predates the degradation, so the claim reaches it first.
    const legacyTask = store.createTask({ agentId, issueId: issue.id, workspaceId, prompt: "Legacy relay" });
    db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id,
         body, status, available_at, created_at, updated_at)
       VALUES ('fbo_pg_legacy', ?, ?, ?, 'oc_pg', NULL, 'om_root', 'Legacy relay text',
         'pending', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      [workspaceId, binding.id, legacyTask.id],
    );
    // The illegal `person` config, written straight into the database, then the
    // request that must degrade to text behind the old row.
    const workspace = store.getWorkspace(workspaceId)!;
    store.updateWorkspace(workspaceId, {
      settings: {
        ...workspace.settings,
        issueTopics: { enabled: true, chatId: "oc_pg", notifyMode: "person", notifyOpenId: "not-an-open-id" },
      },
    });
    const task = store.createTask({ agentId, issueId: issue.id, workspaceId, prompt: "Degraded" });
    const request = store.createTaskHumanRequest({
      taskId: task.id, kind: "question", payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
    });

    // The claim tolerates the stored config instead of throwing, so the old row
    // goes out first — with no @ invented from an unusable config.
    const legacy = store.claimFeishuBotOutbound(workspaceId, runtimeId, undefined, true, true, true)!;
    expect(legacy.id).toBe("fbo_pg_legacy");
    expect(legacy.body).toBe("Legacy relay text");
    expect(legacy.mention).toBeUndefined();

    // The degradation that was behind it is claimed next, as plain text.
    const degraded = store.claimFeishuBotOutbound(workspaceId, runtimeId, undefined, true, true, true)!;
    expect(degraded.kind).toBe("decision_card");
    expect(degraded.degraded).toBe("invalid_recipient");
    expect(degraded.humanRequestId).toBe(request.id);
    expect(degraded.body).not.toContain("<at id=");
    expect(degraded.body).toContain("Continue?");
  });

  it("lets exactly one of two concurrent claims take the delivery", async () => {
    const { workspaceId, runtimeId } = scaffold(60 * 60 * 1000);
    // A second, independent connection to the same database.
    const other = new MultiremiStore(new PostgresSyncDatabase(pgUrl(TEST_DB)));
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => store.claimFeishuBotOutbound(workspaceId, runtimeId)),
      Promise.resolve().then(() => other.claimFeishuBotOutbound(workspaceId, runtimeId)),
    ]);
    const taken = [a, b].filter(Boolean);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.kind).toBe("decision_card");
    // The loser sees nothing to take until the winner's lease expires.
    const loser = a ? other : store;
    expect(loser.claimFeishuBotOutbound(workspaceId, runtimeId)).toBeNull();
    // Only one card row exists for the request, whoever won.
    const rows = db.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND human_request_id = ?",
    ).get(taken[0]!.humanRequestId) as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it("writes the terminal card in the shape the host decodes", () => {
    const { workspaceId, runtimeId, request } = scaffold();
    const card = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    const parsed = JSON.parse(card.body) as { card?: Record<string, unknown> };
    expect(parsed.card?.schema).toBe("2.0");
    store.reportFeishuBotOutbound(workspaceId, runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_card", interactionOpenId: "ou_pg",
    });
    store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } }, respondedBy: "alice" });
    const patch = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    expect(patch.kind).toBe("decision_card_patch");
    const patchBody = JSON.parse(patch.body) as { card?: Record<string, unknown> };
    expect(patchBody.card).toBeTruthy();
    expect(JSON.stringify(patchBody.card)).toContain("已提交");
  });

  it("replays a settled Issue decision card to its bot host on Postgres", () => {
    const { workspaceId, runtimeId, task, request } = scaffold();
    const card = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    store.reportFeishuBotOutbound(workspaceId, runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_settled",
      interactionOpenId: "ou_pg",
    });
    const settled = store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } })!;

    const frames = taskInputSnapshot(store, runtimeId, `d-${runtimeId}`, new Set(), () => {});
    expect(frames.filter(frame => frame.type === "task.human_request.settled")).toEqual([
      expect.objectContaining({ payload: { task_id: task.id, request: settled } }),
    ]);
  });
});
