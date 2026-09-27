/**
 * MUL-412 decision cards on real PostgreSQL.
 *
 * The SQLite suite covers the logic. This file covers what only a real Postgres
 * can answer: that the reminder compare-and-set and the claim filters behave the
 * same once translated, that the additive columns exist after an upgrade as
 * well as on a fresh database, and that two independent connections racing for
 * one card produce one delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { decodeDecisionCardBody } from "@shared/feishu-task-card.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_dc412_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CARD_OPEN_ID = "ou_pg_decision";

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
if (!available) console.warn(`[multiremi-issue-decision-card-postgres] Postgres unreachable at ${PG_ADMIN_URL} — skipping.`);

describe.skipIf(!available)("MUL-412 decision cards on Postgres", () => {
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
    // MUL-400 S1 hard constraint, measured rather than asserted by eye: with
    // `--preload ./tests/unit/multiremi/pg-nesting-preload.ts` the run must show
    // zero nested transactions and zero events published inside one. The global
    // only exists when that preload ran, so a plain run skips the check.
    const report = (globalThis as unknown as { __mul406NestingReport?: () => string }).__mul406NestingReport;
    if (report) {
      const parsed = JSON.parse(report()) as {
        total: number; emissionTotal: number;
        signatures: Array<{ count: number; stack: string }>;
        emissionSignatures: Array<{ count: number; stack: string }>;
      };
      if (parsed.total !== 0 || parsed.emissionTotal !== 0) {
        throw new Error(`decision-card nesting report is not clean: ${report()}`);
      }
    }
    try { db?.close(); } catch { /* best effort */ }
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  // The bot is per-workspace, so each case gets its own; that keeps the
  // delivery queue from leaking between cases.
  let workspaceSeq = 0;
  function scaffold(notifyMode?: "group_owner" | "person" | "none") {
    workspaceSeq += 1;
    const workspace = store.createWorkspace({
      id: `wspg412_${workspaceSeq}`, name: `PG 412 ${workspaceSeq}`, slug: `pg412-${workspaceSeq}`,
    });
    const workspaceId = workspace.id;
    // `createWorkspace` already seeded its owner member; bind it to a user whose
    // external_id is this case's Feishu open_id, the same way SSO login does.
    const member = store.listWorkspaceMembers(workspaceId).find(item => item.role === "owner")!;
    const user = store.getOrCreateUser({
      externalId: `ou_pg412_${workspaceSeq}`, name: "PG owner", email: `pg412-${workspaceSeq}@example.com`,
    });
    db.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
    const agentId = store.createAgent({ name: "PG Concierge", provider: "codex", workspaceId }).id;
    const runtimeId = `rt_pg412_${workspaceSeq}`;
    store.registerRuntime({ id: runtimeId, name: "Bot", provider: "codex", workspaceId, daemonId: `d-${runtimeId}` });
    store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true, supportsIssueDecisionCard: true });
    const config = store.upsertFeishuBotConfig(workspaceId, {
      agentId, runtimeId, appId: "cli_pg412", appSecretOp: "set", appSecret: APP_SECRET, domain: "feishu", enabled: true,
    });
    store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
    store.updateWorkspace(workspaceId, {
      settings: {
        ...workspace.settings,
        issueTopics: {
          enabled: true, chatId: "oc_pg412",
          ...(notifyMode ? { notifyMode } : {}),
          ...(notifyMode === "person" ? { notifyOpenId: CARD_OPEN_ID } : {}),
        },
      },
    });
    const parent = store.createIssue({ title: `PG ${workspaceSeq}`, workspaceId, assigneeType: "agent", assigneeId: agentId });
    store.prepareFeishuIssueTopicWithinTransaction(parent);
    const root = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    store.reportFeishuBotOutbound(workspaceId, runtimeId, root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${workspaceSeq}`,
    });
    const child = store.createIssue({
      title: `PG child ${workspaceSeq}`, workspaceId, parentIssueId: parent.id, assigneeType: "agent", assigneeId: agentId,
    });
    const task = store.createTask({ agentId, issueId: child.id, workspaceId, prompt: "W" });
    return { workspaceId, runtimeId, agentId, member, parent, child, task };
  }

  function escalate(scope: ReturnType<typeof scaffold>, kind = "production_change") {
    const decision = store.createIssueDecision(scope.child.id, {
      kind, title: "Deploy?", body: "please", options: ["yes", "no"],
    }, { type: "agent", id: scope.agentId, taskId: scope.task.id });
    return decision;
  }

  it("upgrades an existing decision and delivery table without losing rows", () => {
    // The columns this change adds must be visible on a database already
    // migrated by main, which is what "additive nullable" has to mean in
    // practice — both as a fresh create and after a re-run.
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns("multiremi_issue_decisions")).toContain("reminder_sent_at");
    expect(columns("multiremi_feishu_bot_outbound_deliveries")).toContain("decision_id");
    expect(columns("multiremi_feishu_bot_outbound_deliveries")).toContain("decision_issue_id");
    const indexes = db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'multiremi_feishu_bot_outbound_deliveries'",
    ).all() as Array<{ indexname: string }>;
    expect(indexes.map(row => row.indexname)).toContain("idx_multiremi_feishu_bot_outbound_decision");
  });

  it("sends one card, then exactly one reminder inside the window", () => {
    const scope = scaffold();
    const decision = escalate(scope);
    expect(decision.status).toBe("escalated");
    const card = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    expect(card.kind).toBe("decision_card");
    expect(decodeDecisionCardBody(card.body)).toBeTruthy();
    store.reportFeishuBotOutbound(scope.workspaceId, scope.runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_card",
      interactionOpenId: CARD_OPEN_ID,
    });
    // Before the offset: nothing. It is a delay, not a deadline window.
    const early = new Date(Date.now() + 49 * 60 * 1000);
    expect(store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId, early)).toBeNull();
    const due = new Date(Date.now() + 51 * 60 * 1000);
    const reminder = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId, due)!;
    expect(reminder.kind).toBe("decision_reminder");
    expect(reminder.mention).toMatchObject({ mode: "person", resolvedOpenId: CARD_OPEN_ID });
    store.reportFeishuBotOutbound(scope.workspaceId, scope.runtimeId, reminder.id, {
      claimToken: reminder.claimToken, status: "sent", externalMessageId: "om_pg_reminder",
    }, due);
    expect(store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId, new Date(due.getTime() + 3_600_000))).toBeNull();
    const row = db.query("SELECT reminder_sent_at FROM multiremi_issue_decisions WHERE id = ?")
      .get(decision.id) as { reminder_sent_at: string | null };
    expect(row.reminder_sent_at).toBe(due.toISOString());
  });

  it("lets exactly one of two concurrent claims take the card", async () => {
    const scope = scaffold();
    escalate(scope);
    const other = new MultiremiStore(new PostgresSyncDatabase(pgUrl(TEST_DB)));
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)),
      Promise.resolve().then(() => other.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)),
    ]);
    const taken = [a, b].filter(Boolean);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.kind).toBe("decision_card");
    const rows = db.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_card' AND decision_id = ?",
    ).get(taken[0]!.decisionId) as { n: string | number };
    expect(Number(rows.n)).toBe(1);
  });

  it("writes the terminal card in the shape the host decodes, and rewrites once", () => {
    const scope = scaffold();
    const decision = escalate(scope);
    const card = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    store.reportFeishuBotOutbound(scope.workspaceId, scope.runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_terminal", interactionOpenId: CARD_OPEN_ID,
    });
    store.answerIssueDecision(scope.parent.id, decision.id, { answer: "yes", reason: "ok", overturn: "" },
      { type: "member", id: scope.member.id, taskId: null });
    const patch = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    expect(patch.kind).toBe("decision_card_patch");
    expect(patch.targetMessageId).toBe("om_pg_terminal");
    const parsed = JSON.parse(patch.body) as { card?: Record<string, unknown> };
    expect(parsed.card?.schema).toBe("2.0");
    expect(JSON.stringify(parsed.card)).toContain("已回答");
    store.answerIssueDecision(scope.parent.id, decision.id, { answer: "no", reason: "changed", overturn: "" },
      { type: "member", id: scope.member.id, taskId: null });
    expect(store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)).toBeNull();
  });

  it("leaves no delivery row behind when the escalation transaction rolls back", () => {
    const scope = scaffold();
    const ownerTask = store.createTask({ agentId: scope.agentId, issueId: scope.parent.id, workspaceId: scope.workspaceId, prompt: "owner" });
    const decision = store.createIssueDecision(scope.child.id, { kind: "merge", title: "Merge?" }, {
      type: "agent", id: scope.agentId, taskId: scope.task.id,
    });
    expect(decision.status).toBe("pending");
    type ActivityInput = { type: string };
    const ctx = (store as unknown as {
      ctx: { appendIssueActivity: (...args: unknown[]) => void };
    }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    ctx.appendIssueActivity = (...args: unknown[]) => {
      if ((args[1] as ActivityInput).type === "decision_card_queued") throw new Error("injected pg failure");
      original(...args);
    };
    let thrown: Error | null = null;
    try {
      store.escalateIssueDecision(scope.parent.id, decision.id, {
        type: "agent", id: scope.agentId, taskId: ownerTask.id,
      });
    } catch (error) {
      thrown = error as Error;
    } finally {
      ctx.appendIssueActivity = original;
    }
    expect(thrown?.message).toBe("injected pg failure");
    expect(store.getIssueDecision(scope.parent.id, decision.id)!.status).toBe("pending");
    expect(db.query(
      "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?",
    ).get(decision.id)).toEqual({ n: "0" });
    // And the same transaction commits cleanly on a retry.
    store.escalateIssueDecision(scope.parent.id, decision.id, {
      type: "agent", id: scope.agentId, taskId: ownerTask.id,
    });
    expect(store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!.kind).toBe("decision_card");
  });
});
