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
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { decisionInteractionMarker, decodeDecisionCardBody, questionCardAction } from "@shared/feishu-task-card.js";
import {
  handleIssueDecisionInteractionEvent,
} from "@connectors/feishu/task-interaction.js";
import { registerIssueDecisionCardFixture as registerIssueDecisionCardInteraction } from "../connectors/question-card-host-fixture.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { restoreMul412Baseline828291b9Schema, tableColumns } from "./mul412-schema-fixture.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_dc412_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const UPGRADE_DB = `${TEST_DB}_upgrade`;
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CARD_OPEN_ID = "ou_pg_decision";

function scanCounts(): { product: number; events: number; failures: number } | null {
  const report = (globalThis as unknown as { __mul406NestingReport?: () => string }).__mul406NestingReport;
  if (!report) return null;
  const parsed = JSON.parse(report());
  return {
    product: parsed.nesting.productPath.total - parsed.nesting.reviewedExceptions.total
      + parsed.nesting.unclassified.total,
    events: parsed.emissionTotal,
    failures: parsed.reportFailures,
  };
}

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
if (!available && process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Configured test Postgres is unreachable");
if (!available) console.warn("[multiremi-issue-decision-card-postgres] Postgres unavailable; skipping.");

const CLAIM_BARRIER_TIMEOUT_MS = 10_000;
type ClaimWorkerMessage = {
  type: "ready" | "due_selected" | "result" | "error";
  pid?: number;
  backendPid?: number;
  decisionIds?: string[];
  delivery?: { id: string; kind: string } | null;
  message?: string;
};

function jsonLineReader(stream: ReadableStream<Uint8Array>): () => Promise<ClaimWorkerMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return JSON.parse(line) as ClaimWorkerMessage;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("claim worker stdout closed before the next barrier message");
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
}

async function beforeBarrierTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `MUL-412 reminder barrier timed out waiting for ${label} after ${CLAIM_BARRIER_TIMEOUT_MS}ms`,
        )), CLAIM_BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!available)("MUL-412 decision cards on Postgres", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let previousLarkAppId: string | undefined;
  let previousLarkAppSecret: string | undefined;
  let scanBefore: ReturnType<typeof scanCounts>;

  beforeAll(async () => {
    scanBefore = scanCounts();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${UPGRADE_DB}`);
    await admin.end();
    previousLarkAppId = process.env.MULTIREMI_LARK_APP_ID;
    previousLarkAppSecret = process.env.MULTIREMI_LARK_APP_SECRET;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
    process.env.MULTIREMI_LARK_APP_ID = "cli_pg412";
    process.env.MULTIREMI_LARK_APP_SECRET = APP_SECRET;
    db = new PostgresSyncDatabase(pgUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    const scanAfter = scanCounts();
    try {
      try { db?.close(); } catch { /* best effort */ }
      const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
      } finally { await admin.end(); }
    } finally {
      if (previousLarkAppId === undefined) delete process.env.MULTIREMI_LARK_APP_ID;
      else process.env.MULTIREMI_LARK_APP_ID = previousLarkAppId;
      if (previousLarkAppSecret === undefined) delete process.env.MULTIREMI_LARK_APP_SECRET;
      else process.env.MULTIREMI_LARK_APP_SECRET = previousLarkAppSecret;
    }
    // MUL-482: this file owns its beforeAll → afterAll delta. Other files'
    // intentional DB savepoint tests remain in the raw report (cmt_kexlr6zs2ras).
    if (scanBefore && scanAfter) {
      expect(scanAfter.product - scanBefore.product).toBe(0);
      expect(scanAfter.events - scanBefore.events).toBe(0);
      expect(scanAfter.failures).toBe(0);
    }
  });

  // The bot is per-workspace, so each case gets its own; that keeps the
  // delivery queue from leaking between cases.
  let workspaceSeq = 0;
  function scaffold(
    notifyMode?: "group_owner" | "person" | "none",
    targetStore = store,
    targetDb = db,
  ) {
    workspaceSeq += 1;
    const workspace = targetStore.createWorkspace({
      id: `wspg412_${workspaceSeq}`, name: `PG 412 ${workspaceSeq}`, slug: `pg412-${workspaceSeq}`,
    });
    const workspaceId = workspace.id;
    // `createWorkspace` already seeded its owner member; bind it to a user whose
    // external_id is this case's Feishu open_id, the same way SSO login does.
    const member = targetStore.listWorkspaceMembers(workspaceId).find(item => item.role === "owner")!;
    const openId = `ou_pg412_${workspaceSeq}`;
    const user = targetStore.getOrCreateUser({
      externalId: openId, name: "PG owner", email: `pg412-${workspaceSeq}@example.com`,
    });
    targetDb.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
    const agentId = targetStore.createAgent({ name: "PG Concierge", provider: "codex", workspaceId }).id;
    const runtimeId = `rt_pg412_${workspaceSeq}`;
    targetStore.registerRuntime({ id: runtimeId, name: "Bot", provider: "codex", workspaceId, daemonId: `d-${runtimeId}` });
    targetStore.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true, supportsIssueDecisionCard: true });
    const config = targetStore.upsertFeishuBotConfig(workspaceId, {
      agentId, runtimeId, appId: "cli_pg412", appSecretOp: "set", appSecret: APP_SECRET, domain: "feishu", enabled: true,
    });
    targetStore.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
    targetStore.updateWorkspace(workspaceId, {
      settings: {
        ...workspace.settings,
        issueTopics: {
          enabled: true, chatId: "oc_pg412",
          ...(notifyMode ? { notifyMode } : {}),
          ...(notifyMode === "person" ? { notifyOpenId: CARD_OPEN_ID } : {}),
        },
      },
    });
    const parent = targetStore.createIssue({ title: `PG ${workspaceSeq}`, workspaceId, assigneeType: "agent", assigneeId: agentId });
    targetStore.prepareFeishuIssueTopicWithinTransaction(parent);
    const root = targetStore.claimFeishuBotOutbound(workspaceId, runtimeId)!;
    targetStore.reportFeishuBotOutbound(workspaceId, runtimeId, root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${workspaceSeq}`,
    });
    const child = targetStore.createIssue({
      title: `PG child ${workspaceSeq}`, workspaceId, parentIssueId: parent.id, assigneeType: "agent", assigneeId: agentId,
    });
    const task = targetStore.createTask({ agentId, issueId: child.id, workspaceId, prompt: "W" });
    return { workspaceId, runtimeId, agentId, member, openId, parent, child, task };
  }

  function escalate(scope: ReturnType<typeof scaffold>, kind = "production_change", targetStore = store) {
    const decision = targetStore.createIssueDecision(scope.child.id, {
      kind, title: "Deploy?", body: "please", options: ["yes", "no"],
    }, { type: "agent", id: scope.agentId, taskId: scope.task.id });
    return decision;
  }

  // Three cold stores perform durable schema checks and two upgrades on real PG.
  it("upgrades the Postgres 828291b9 schema twice without losing existing rows", () => {
    const upgradeDb = new PostgresSyncDatabase(pgUrl(UPGRADE_DB));
    const baselineStore = new MultiremiStore(upgradeDb);
    const scope = scaffold(undefined, baselineStore, upgradeDb);
    const decision = escalate(scope, "production_change", baselineStore);
    const card = baselineStore.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    const deliveryId = card.id;
    restoreMul412Baseline828291b9Schema(upgradeDb);
    expect(tableColumns(upgradeDb, "multiremi_issue_decisions")).not.toContain("reminder_sent_at");
    expect(tableColumns(upgradeDb, "multiremi_feishu_bot_outbound_deliveries")).not.toContain("decision_id");
    expect(tableColumns(upgradeDb, "multiremi_issues")).not.toContain("parent_done_grant_at");

    new MultiremiStore(upgradeDb);
    new MultiremiStore(upgradeDb);
    expect(tableColumns(upgradeDb, "multiremi_issue_decisions")).toContain("reminder_sent_at");
    expect(tableColumns(upgradeDb, "multiremi_feishu_bot_outbound_deliveries"))
      .toEqual(expect.arrayContaining(["decision_id", "decision_issue_id"]));
    expect(tableColumns(upgradeDb, "multiremi_issues"))
      .toEqual(expect.arrayContaining(["parent_done_grant_at", "parent_done_grant_by", "parent_done_grant_agent_id"]));
    expect(upgradeDb.query("SELECT title, status FROM multiremi_issue_decisions WHERE id = ?").get(decision.id))
      .toEqual({ title: "Deploy?", status: "escalated" });
    expect(upgradeDb.query("SELECT id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(deliveryId))
      .toEqual({ id: deliveryId, status: "sending" });
    const indexes = upgradeDb.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'multiremi_feishu_bot_outbound_deliveries'",
    ).all() as Array<{ indexname: string }>;
    expect(indexes.map(row => row.indexname)).toContain("idx_multiremi_feishu_bot_outbound_decision");
    upgradeDb.close();
  }, 15_000);

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

  it("lets two processes materialize and claim only one due reminder", async () => {
    const scope = scaffold();
    const decision = escalate(scope);
    const sentAt = new Date(Date.now() - 51 * 60 * 1000);
    const card = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    store.reportFeishuBotOutbound(scope.workspaceId, scope.runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_pg_concurrent", interactionOpenId: CARD_OPEN_ID,
    }, sentAt);
    const now = new Date();
    const worker = `${import.meta.dir}/mul412-reminder-claim-worker.ts`;
    const spawn = () => Bun.spawn([process.execPath, worker], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MUL412_CLAIM_PG_URL: pgUrl(TEST_DB),
        MUL412_CLAIM_WORKSPACE_ID: scope.workspaceId,
        MUL412_CLAIM_RUNTIME_ID: scope.runtimeId,
        MUL412_CLAIM_NOW: now.toISOString(),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const processes = [spawn(), spawn()];
    const nextMessages = processes.map(child => jsonLineReader(child.stdout));
    const stderr = processes.map(child => new Response(child.stderr).text());
    let completed = false;
    try {
      const ready = await Promise.all(nextMessages.map((next, index) =>
        beforeBarrierTimeout(next(), `worker ${index + 1} initialization`)));
      expect(ready.map(message => message.type)).toEqual(["ready", "ready"]);
      const workerPids = ready.map(message => Number(message.pid));
      const backendPids = ready.map(message => Number(message.backendPid));
      expect(new Set(workerPids).size).toBe(2);
      expect(new Set(backendPids).size).toBe(2);
      expect(workerPids).toEqual(processes.map(child => child.pid));

      for (const child of processes) {
        child.stdin.write("\n");
        child.stdin.flush();
      }
      const selected = await Promise.all(nextMessages.map((next, index) =>
        beforeBarrierTimeout(next(), `worker ${index + 1} due SELECT`)));
      expect(selected.map(message => message.type)).toEqual(["due_selected", "due_selected"]);
      expect(selected.map(message => message.decisionIds)).toEqual([[decision.id], [decision.id]]);

      for (const child of processes) {
        child.stdin.write("\n");
        child.stdin.flush();
      }
      const results = await Promise.all(nextMessages.map((next, index) =>
        beforeBarrierTimeout(next(), `worker ${index + 1} claim result`)));
      expect(results.map(message => message.type)).toEqual(["result", "result"]);
      const deliveries = results.map(message => message.delivery ?? null);
      const taken = deliveries.filter((row): row is { id: string; kind: string } => row !== null);
      const exitCodes = await Promise.all(processes.map((child, index) =>
        beforeBarrierTimeout(child.exited, `worker ${index + 1} exit`)));
      const errors = await Promise.all(stderr);
      expect(exitCodes, errors.join("\n")).toEqual([0, 0]);
      const rows = db.query(
        "SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'decision_reminder' AND decision_id = ?",
      ).get(decision.id) as { n: string | number };
      expect({
        claimed: taken.length,
        unclaimed: deliveries.filter(row => row === null).length,
        reminderRows: Number(rows.n),
      }).toEqual({ claimed: 1, unclaimed: 1, reminderRows: 1 });
      expect(taken[0]!.kind).toBe("decision_reminder");
      completed = true;
    } finally {
      if (!completed) {
        for (const child of processes) {
          if (child.exitCode === null) child.kill(9);
        }
        await Promise.allSettled(processes.map(child => child.exited));
      }
    }
  }, 60_000);

  it("classifies answer failures from the canonical Postgres decision over real HTTP", async () => {
    const scope = scaffold();
    const decision = escalate(scope);
    const card = store.claimFeishuBotOutbound(scope.workspaceId, scope.runtimeId)!;
    const messageId = "om_pg_answer_classification";
    store.reportFeishuBotOutbound(scope.workspaceId, scope.runtimeId, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: messageId,
      interactionOpenId: scope.openId,
    });
    const token = await store.createAccessToken({
      name: "PG bot host", type: "daemon", workspaceId: scope.workspaceId,
      daemonId: `d-${scope.runtimeId}`,
    });
    const api = createMultiremiApp({ store, authToken: "MASTER" });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => api.fetch(request),
    });
    const client = new MultiremiDaemonClient(server.url.origin, token.token);
    const marker = decisionInteractionMarker(scope.parent.id, decision.id);
    const originalAnswer = store.answerIssueDecision.bind(store);
    store.answerIssueDecision = (...args) => {
      store.withdrawIssueDecision(scope.parent.id, decision.id, {
        type: "agent", id: scope.agentId, taskId: scope.task.id,
      });
      return originalAnswer(...args);
    };
    const registration = registerIssueDecisionCardInteraction({
      appId: "cli_pg412", chatId: "oc_pg412", messageId,
      recipientOpenId: scope.openId,
      getDecision: () => client.getFeishuIssueDecision(scope.parent.id, decision.id),
      submit: (answer, operatorOpenId, token) => client.answerFeishuIssueDecision(
        scope.parent.id, decision.id, { answer, operatorOpenId, token },
      ),
    });
    try {
      const result = await handleIssueDecisionInteractionEvent("cli_pg412", {
        operator: { open_id: scope.openId },
        context: { open_message_id: messageId, open_chat_id: "oc_pg412" },
        action: { value: questionCardAction(decodeDecisionCardBody(card.body)!.card), name: `${marker}_o0`, form_value: {} },
      });
      expect(result?.toast).toEqual({
        type: "info",
        content: "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。",
      });
      expect(result).toHaveProperty("card");
      expect(store.getIssueDecision(scope.parent.id, decision.id)?.status).toBe("withdrawn");
    } finally {
      registration.dispose();
      store.answerIssueDecision = originalAnswer;
      await server.stop(true);
    }
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
