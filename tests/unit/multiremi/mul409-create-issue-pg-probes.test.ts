/**
 * MUL-409 fix round 5: the six in-transaction issue-creation call sites, plus the
 * claim lane, each probed for commit and rollback on a real Postgres connection.
 *
 * The contract (S1's, carried through this branch's merge of MUL-406): every
 * activity and realtime event produced inside a caller-owned transaction rides
 * that caller's commit-event queue and is published only after COMMIT. A rollback
 * therefore drops the row AND the broadcast together.
 *
 * Paths, each run twice (commit / rollback):
 *   1. Autopilot `create_issue`          (autopilots-repo)
 *   2. Feishu group chat                 (feishu-bot-repo)
 *   3. Feishu ingest direct              (feishu-ingest-repo)
 *   4. Feishu ingest approved proposal   (feishu-ingest-repo)
 *   5. Messaging direct                  (messaging/outcomes)
 *   6. Messaging approved proposal       (messaging/outcomes)
 *   7. claim lane reset                  (tasks-repo, `session_agent_lane_reset`)
 *
 * Commit case: the issue row, its `issue_created` activity and the broadcast each
 * appear exactly once, and the broadcast arrives OUTSIDE the transaction
 * (`inTransaction === false`). Rollback case: all three are absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext, type CommitEventQueue } from "@multiremi/store/context.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul409_probe_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(`[mul409-create-issue-pg-probes] Postgres not reachable at ${PG_ADMIN_URL} — skipping.`);
}

describe.skipIf(!pgAvailable)("MUL-409: in-transaction issue creation on Postgres", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let previousKey: string | undefined;
  let counter = 0;
  let memberId = "";

  beforeAll(async () => {
    previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    memberId = store.getWorkspaceMember("mem_local")?.id ?? store.listWorkspaceMembers("local")[0]!.id;
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  /**
   * Run one creation path and assert the three-way contract for it.
   *
   * `run` must create exactly one issue titled `title`, either by committing or
   * by throwing the injected error when `rollback` is set.
   */
  function observe(title: string, run: () => void, rollback: boolean, issueIdFromRun?: (result: unknown) => string): void {
    const emitted: boolean[] = [];
    const stop = store.onWorkspaceEvent((event) => {
      if (event.type !== "activity:created") return;
      if ((event.payload.entry as { action?: string })?.action !== "issue_created") return;
      emitted.push(db.inTransaction);
    });
    const original = StoreContext.prototype.appendIssueActivity;
    if (rollback) {
      StoreContext.prototype.appendIssueActivity = function patched(
        this: StoreContext,
        issueId: string,
        input: { actorType: string; type: string },
        queue?: CommitEventQueue,
      ) {
        original.call(this, issueId, input, queue);
        if (input.type === "issue_created") throw new Error("mul409 probe rollback injection");
      };
    }
    let result: unknown;
    try {
      if (rollback) expect(() => { run(); }).toThrow(/mul409 probe rollback injection/);
      else result = run();
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      stop();
    }

    const issueId = issueIdFromRun && result ? issueIdFromRun(result) : null;
    const issues = db.query("SELECT id FROM multiremi_issues WHERE title = ?").all(title) as Array<{ id: string }>;
    const activities = db.query(
      `SELECT a.id FROM multiremi_issue_activity a
       JOIN multiremi_issues i ON i.id = a.issue_id
       WHERE i.title = ? AND a.type = 'issue_created'`,
    ).all(title) as Array<{ id: string }>;

    if (rollback) {
      expect({ title, issues: issues.length, activities: activities.length, emitted })
        .toEqual({ title, issues: 0, activities: 0, emitted: [] });
      return;
    }
    expect({ title, issues: issues.length, activities: activities.length, emitted })
      .toEqual({ title, issues: 1, activities: 1, emitted: [false] });
    if (issueId) expect(issues[0]!.id).toBe(issueId);
  }

  function messagingCreationRows(
    title: string,
    ref: { connectionId: string; externalMessageId: string },
  ): { issues: number; activities: number; outcomes: number } {
    const issues = db.query("SELECT id FROM multiremi_issues WHERE title = ?").all(title) as Array<{ id: string }>;
    const activities = db.query(
      `SELECT a.id FROM multiremi_issue_activity a
       JOIN multiremi_issues i ON i.id = a.issue_id
       WHERE i.title = ? AND a.type = 'issue_created'`,
    ).all(title) as Array<{ id: string }>;
    const outcomes = db.query(
      `SELECT id FROM multiremi_message_outcomes
       WHERE connection_id = ? AND external_message_id = ? AND outcome_kind = 'issue_created'`,
    ).all(ref.connectionId, ref.externalMessageId) as Array<{ id: string }>;
    return { issues: issues.length, activities: activities.length, outcomes: outcomes.length };
  }

  it.each([false, true] as const)("Autopilot create_issue (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe autopilot ${counter}`;
    const agent = store.createAgent({ name: `Probe autopilot owner ${counter}`, provider: "claude" });
    const autopilot = store.createAutopilot({
      title, workspaceId: "local", assigneeId: agent.id, executionMode: "create_issue",
    });
    observe(title, () => { store.runAutopilot(autopilot.id); }, rollback);
  });

  it.each([false, true] as const)("Feishu group chat (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe feishu group ${counter}`;
    const agent = store.createAgent({ name: `Probe group agent ${counter}`, provider: "codex" });
    const runtimeId = `rt_probe_group_${counter}`;
    store.registerRuntime({ id: runtimeId, name: `Probe group runtime ${counter}`, provider: "codex", daemonId: `probe-${counter}` });
    store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig("local", {
      agentId: agent.id,
      runtimeId,
      appId: `cli_probe_${counter}`,
      senderAccessPolicy: "allowlist",
      appSecretOp: "set",
      appSecret: APP_SECRET,
      domain: "feishu",
      enabled: true,
    });
    store.reportFeishuBotRuntimeStatus("local", runtimeId, { appliedRevision: config.revision, state: "online" });
    // A group chat only becomes an Issue when the workspace's topic configuration
    // is on for that chat (feishu-bot-repo reads `settings.issueTopics`).
    const workspace = store.getWorkspace("local")!;
    const chatId = `oc_probe_group_${counter}`;
    store.updateWorkspace("local", {
      settings: { ...workspace.settings, issueTopics: { enabled: true, chatId } },
    });
    // The sender must be allowed before a group message can create an Issue.
    store.submitFeishuBotMessage("local", runtimeId, {
      revision: config.revision,
      externalSessionKey: `${chatId}:discovery`,
      externalMessageId: `om_probe_group_seed_${counter}`,
      senderOpenId: "ou_probe_sender",
      text: "seed",
    });
    store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
    observe(title, () => {
      store.submitFeishuBotMessage("local", runtimeId, {
        revision: config.revision,
        chatType: "group",
        chatId,
        externalSessionKey: `${chatId}:thread:om_probe_group_${counter}`,
        externalMessageId: `om_probe_group_${counter}`,
        senderOpenId: "ou_probe_sender",
        // The group Issue's title is derived from the message text itself.
        text: title,
      });
    }, rollback);
  });

  it.each([false, true] as const)("Feishu ingest direct (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe feishu direct ${counter}`;
    const source = store.createFeishuSource({
      workspaceId: "local",
      name: `Probe Feishu source ${counter}`,
      endpointName: `probe_direct_${counter}`,
      allowlist: [{ chatId: `oc_probe_direct_${counter}` }],
    });
    store.ingestFeishuBatch(source.id, [feishuMessage(`om_probe_direct_${counter}`, `oc_probe_direct_${counter}`)]);
    observe(title, () => {
      store.createFeishuIssueOutcome(`om_probe_direct_${counter}`, { workspaceId: "local", title });
    }, rollback);
  });

  it.each([false, true] as const)("Feishu ingest approved proposal (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe feishu proposal ${counter}`;
    const source = store.createFeishuSource({
      workspaceId: "local",
      name: `Probe Feishu proposal source ${counter}`,
      endpointName: `probe_proposal_${counter}`,
      allowlist: [{ chatId: `oc_probe_proposal_${counter}` }],
    });
    store.ingestFeishuBatch(source.id, [feishuMessage(`om_probe_proposal_${counter}`, `oc_probe_proposal_${counter}`)]);
    const proposal = store.createFeishuIssueProposal(`om_probe_proposal_${counter}`, {
      workspaceId: "local", title, recipientId: memberId, actorType: "member", actorId: memberId,
    });
    observe(title, () => {
      store.approveFeishuIssueProposal(proposal.proposal!.id, { workspaceId: "local", approvedBy: memberId });
    }, rollback);
  });

  it.each([false, true] as const)("Messaging direct (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe messaging direct ${counter}`;
    const ref = seedMessage(`probe_direct_${counter}`);
    observe(title, () => {
      store.messagingOutcomes.createIssue(ref, { workspaceId: "local", title, createdBy: memberId });
    }, rollback);
    expect(messagingCreationRows(title, ref)).toEqual(rollback
      ? { issues: 0, activities: 0, outcomes: 0 }
      : { issues: 1, activities: 1, outcomes: 1 });
  });

  it.each([false, true] as const)("Messaging approved proposal (rollback=%s)", (rollback) => {
    counter += 1;
    const title = `Probe messaging proposal ${counter}`;
    const ref = seedMessage(`probe_proposal_${counter}`);
    const proposal = store.messagingOutcomes.proposeIssue(ref, {
      workspaceId: "local", title, recipientId: memberId, actorType: "member", actorId: memberId,
    });
    observe(title, () => {
      store.messagingOutcomes.approveProposal(proposal.outcome.id, { workspaceId: "local", approvedBy: memberId });
    }, rollback);
    expect(messagingCreationRows(title, ref)).toEqual(rollback
      ? { issues: 0, activities: 0, outcomes: 0 }
      : { issues: 1, activities: 1, outcomes: 1 });
    if (rollback) expect(store.messaging.getOutcome(proposal.outcome.id)?.proposalStatus).toBe("pending");
  });

  it("Messaging direct rolls back after the outcome write", () => {
    counter += 1;
    const title = `Probe messaging direct late rollback ${counter}`;
    const ref = seedMessage(`probe_direct_late_${counter}`);
    const emitted: boolean[] = [];
    const stop = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created"
        && (event.payload.entry as { action?: string })?.action === "issue_created") {
        emitted.push(db.inTransaction);
      }
    });
    const original = store.messaging.recordOutcomeWithinTransaction;
    let outcomeWasWritten = false;
    store.messaging.recordOutcomeWithinTransaction = (input) => {
      const outcome = original.call(store.messaging, input);
      if (input.outcomeKind === "issue_created") {
        outcomeWasWritten = true;
        throw new Error("PG messaging outcome rollback injection");
      }
      return outcome;
    };
    try {
      expect(() => store.messagingOutcomes.createIssue(ref, {
        workspaceId: "local", title, createdBy: memberId,
      })).toThrow("PG messaging outcome rollback injection");
    } finally {
      store.messaging.recordOutcomeWithinTransaction = original;
      stop();
    }
    expect(outcomeWasWritten).toBe(true);
    expect(messagingCreationRows(title, ref)).toEqual({ issues: 0, activities: 0, outcomes: 0 });
    expect(emitted).toEqual([]);
  });

  it("Messaging approval rolls back after proposal resolution", () => {
    counter += 1;
    const title = `Probe messaging approval late rollback ${counter}`;
    const ref = seedMessage(`probe_approval_late_${counter}`);
    const proposal = store.messagingOutcomes.proposeIssue(ref, {
      workspaceId: "local", title, recipientId: memberId, actorType: "member", actorId: memberId,
    });
    const emitted: boolean[] = [];
    const stop = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created"
        && (event.payload.entry as { action?: string })?.action === "issue_created") {
        emitted.push(db.inTransaction);
      }
    });
    const original = store.messaging.resolveProposal;
    let proposalWasResolved = false;
    store.messaging.resolveProposal = (input) => {
      const resolved = original.call(store.messaging, input);
      if (input.id === proposal.outcome.id && input.status === "approved") {
        proposalWasResolved = resolved?.proposalStatus === "approved";
        throw new Error("PG messaging proposal resolution rollback injection");
      }
      return resolved;
    };
    try {
      expect(() => store.messagingOutcomes.approveProposal(proposal.outcome.id, {
        workspaceId: "local", approvedBy: memberId,
      })).toThrow("PG messaging proposal resolution rollback injection");
    } finally {
      store.messaging.resolveProposal = original;
      stop();
    }
    expect(proposalWasResolved).toBe(true);
    expect(messagingCreationRows(title, ref)).toEqual({ issues: 0, activities: 0, outcomes: 0 });
    expect(store.messaging.getOutcome(proposal.outcome.id)?.proposalStatus).toBe("pending");
    expect(emitted).toEqual([]);
  });

  it("MessagingRepo recordOutcome remains a standalone transaction", () => {
    counter += 1;
    const ref = seedMessage(`probe_standalone_outcome_${counter}`);
    db.resetTransactionDepthStats();
    const outcome = store.messaging.recordOutcome({
      workspaceId: "local",
      connectionId: ref.connectionId,
      externalMessageId: ref.externalMessageId,
      outcomeKind: "ignored",
      reason: "standalone probe",
    });
    expect(outcome).toMatchObject({ outcomeKind: "ignored", reason: "standalone probe" });
    expect(store.messaging.listOutcomes(ref.connectionId, ref.externalMessageId)).toHaveLength(1);
    expect(db.maxTransactionDepth).toBe(1);
  });

  it.each([false, true] as const)("claim lane reset (rollback=%s)", (rollback) => {
    counter += 1;
    // A dedicated workspace: `claimTask` scans its runtime's workspace, and the
    // earlier cases in this file leave queued rounds in `local`.
    const workspaceId = store.createWorkspace({ name: `Lane probe ${counter}`, slug: `mul409-lane-${process.pid}-${counter}` }).id;
    const runtimeId = `rt_probe_lane_${counter}`;
    store.registerRuntime({ id: runtimeId, name: `Probe lane runtime ${counter}`, provider: "claude", workspaceId });
    const agent = store.createAgent({ name: `Probe lane agent ${counter}`, provider: "claude", runtimeId, workspaceId });
    const issue = store.createIssue({ title: `Probe lane ${counter}`, workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Probe lane reset" });
    // Make the lane look stale so the claim path resets it and writes the audit row.
    db.run(
      `UPDATE multiremi_session_agent_lanes SET provider_session_id = 'expired', provider = 'claude',
       runtime_id = ?, cursor_seq = 1, execution_fingerprint = 'expired'
       WHERE session_id = ? AND agent_id = ?`,
      [runtimeId, session.id, agent.id],
    );

    const emitted: boolean[] = [];
    const stop = store.onWorkspaceEvent((event) => {
      if (event.type !== "activity:created") return;
      if ((event.payload.entry as { action?: string })?.action !== "session_agent_lane_reset") return;
      emitted.push(db.inTransaction);
    });
    const original = StoreContext.prototype.appendIssueActivity;
    if (rollback) {
      StoreContext.prototype.appendIssueActivity = function patched(
        this: StoreContext,
        issueId: string,
        input: { actorType: string; type: string },
        queue?: CommitEventQueue,
      ) {
        original.call(this, issueId, input, queue);
        if (input.type === "session_agent_lane_reset") throw new Error("mul409 probe rollback injection");
      };
    }
    try {
      if (rollback) expect(() => store.claimTask(runtimeId)).toThrow(/mul409 probe rollback injection/);
      else expect(store.claimTask(runtimeId)?.id).toBe(task.id);
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      stop();
    }

    const rows = db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'session_agent_lane_reset'",
    ).all(issue.id) as Array<{ id: string }>;
    if (rollback) {
      expect({ rows: rows.length, emitted, status: store.getTask(task.id)?.status })
        .toEqual({ rows: 0, emitted: [], status: "queued" });
    } else {
      expect({ rows: rows.length, emitted }).toEqual({ rows: 1, emitted: [false] });
    }
  });

  /** An ingested Feishu message in the shape `ingestFeishuBatch` accepts. */
  function feishuMessage(messageId: string, chatId: string) {
    return {
      messageId,
      chatId,
      chatType: "group",
      chatName: "Probe chat",
      sender: { senderId: "ou_probe_sender", name: "Probe sender", type: "user" },
      content: { text: "probe" },
      searchableText: "probe",
      contentFingerprint: `fp_${messageId}`,
      createdAt: new Date().toISOString(),
    };
  }

  /** One Messaging connection + source + message, ready for an outcome. */
  function seedMessage(slug: string): { connectionId: string; externalMessageId: string } {
    const connectionId = `mconn_${slug}`;
    store.messaging.upsertConnection({
      id: connectionId,
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: `Probe connection ${slug}`,
      status: "ready",
    });
    const sourceId = `msrc_${slug}`;
    store.messaging.upsertSource({
      id: sourceId,
      workspaceId: "local",
      connectionId,
      name: `Probe source ${slug}`,
      // The allowlist gates ingestion at minute granularity, so the activation
      // time has to be in the past relative to the message.
      allowlist: [{ externalConversationId: `conv_${slug}`, addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const externalMessageId = `msg_${slug}`;
    const message: CanonicalMessage = {
      externalMessageId,
      externalConversationId: `conv_${slug}`,
      conversationName: "Probe chat",
      conversationKind: "group",
      externalThreadId: null,
      externalRootId: null,
      externalParentId: null,
      sender: { externalSenderId: "sender_probe", displayName: "Sender", kind: "user", isSelf: false },
      text: "probe message",
      attachments: [],
      mentions: [],
      reactions: [],
      url: null,
      sentAt: new Date().toISOString(),
      editedAt: null,
      recalled: false,
      raw: {},
    };
    store.messaging.ingestMessages({ connectionId, sourceId, messages: [message] });
    return { connectionId, externalMessageId };
  }
});
