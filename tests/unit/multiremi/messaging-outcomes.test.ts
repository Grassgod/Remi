import { afterEach, describe, expect, it } from "bun:test";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const REF = { connectionId: "mconn_test", externalMessageId: "external_1" };

function seed(): { store: MultiremiStore; ownerId: string } {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.messaging.upsertConnection({
    id: REF.connectionId,
    workspaceId: "local",
    provider: "test_provider",
    channel: "test_channel",
    name: "Test connection",
    status: "ready",
  });
  store.messaging.upsertSource({
    id: "msrc_test",
    workspaceId: "local",
    connectionId: REF.connectionId,
    name: "Test source",
    allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
  });
  store.messaging.ingestMessages({
    connectionId: REF.connectionId,
    sourceId: "msrc_test",
    messages: [message()],
  });
  const owner = store.listWorkspaceMembers("local").find((member) => member.role === "owner")!;
  return { store, ownerId: owner.id };
}

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    externalMessageId: REF.externalMessageId,
    externalConversationId: "conversation_1",
    conversationName: "Product chat",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: { externalSenderId: "sender_1", displayName: "Sender", kind: "user", isSelf: false },
    text: "the API is down again",
    attachments: [],
    mentions: [],
    reactions: [],
    url: "https://example.invalid/m/external_1",
    sentAt: "2026-08-31T10:00:00.000Z",
    editedAt: null,
    recalled: false,
    raw: {},
    ...overrides,
  };
}

describe("messaging outcomes", () => {
  it("refuses the outcomes that have a dedicated command, and requires a reason for the rest", () => {
    const { store } = seed();
    const outcomes = store.messagingOutcomes;

    for (const outcome of ["notified", "reply_drafted", "issue_proposed", "issue_created"] as const) {
      expect(() => outcomes.record(REF, { workspaceId: "local", outcome }))
        .toThrow("dedicated command");
    }
    expect(() => outcomes.record(REF, { workspaceId: "local", outcome: "ignored" }))
      .toThrow("reason is required");
    // A message in another workspace is not visible, even with the right ids.
    expect(() => outcomes.record(REF, { workspaceId: "other", outcome: "ignored", reason: "noise" }))
      .toThrow("Message not found");

    const result = outcomes.record(REF, { workspaceId: "local", outcome: "ignored", reason: "noise" });
    expect(result.outcome.outcomeKind).toBe("ignored");
    expect(result.message.processedAt).not.toBeNull();

    // The ledger appends: a second decision does not overwrite the first.
    outcomes.record(REF, { workspaceId: "local", outcome: "dismissed", reason: "handled elsewhere" });
    expect(store.messaging.listOutcomes(REF.connectionId, REF.externalMessageId).map((o) => o.outcomeKind))
      .toEqual(["ignored", "dismissed"]);
  });

  it("delivers a notification to the inbox and records what it produced", () => {
    const { store, ownerId } = seed();
    const result = store.messagingOutcomes.notify(REF, "notified", {
      workspaceId: "local",
      recipientId: ownerId,
      actorType: "member",
      actorId: ownerId,
      text: "the API is down",
    });

    expect(result.delivered).toBe(true);
    expect(result.inboxItem?.type).toBe("feishu_message_notification");
    expect(result.outcome.ref).toBe(`inbox:${result.inboxItem!.id}`);
    expect(result.inboxItem?.details).toMatchObject({
      connection_id: REF.connectionId,
      external_message_id: REF.externalMessageId,
      external_conversation_id: "conversation_1",
      conversation_name: "Product chat",
    });
    expect(result.message.processedAt).not.toBeNull();

    expect(() => store.messagingOutcomes.notify(REF, "notified", {
      workspaceId: "local",
      recipientId: "nobody",
      actorType: "member",
      actorId: ownerId,
      text: "again",
    })).toThrow("Inbox recipient is unavailable");
  });

  it("dismisses instead of delivering when the recipient muted the notification", () => {
    const { store, ownerId } = seed();
    store.updateNotificationPreferences({
      workspaceId: "local",
      memberId: ownerId,
      preferences: { feishu_messages: "muted" },
    });

    const result = store.messagingOutcomes.notify(REF, "reply_drafted", {
      workspaceId: "local",
      recipientId: ownerId,
      actorType: "agent",
      actorId: "agent_1",
      text: "on it, will fix by 5",
    });

    expect(result.delivered).toBe(false);
    expect(result.inboxItem).toBeNull();
    // The message is still accounted for: silence is a decision, not a gap.
    expect(result.outcome).toMatchObject({ outcomeKind: "dismissed", reason: "recipient_muted" });
    expect(result.message.processedAt).not.toBeNull();
  });

  it("proposes once, then creates the Issue exactly once on approval", () => {
    const { store, ownerId } = seed();
    const outcomes = store.messagingOutcomes;

    const proposed = outcomes.proposeIssue(REF, {
      workspaceId: "local",
      recipientId: ownerId,
      actorType: "agent",
      actorId: "agent_1",
      title: "API outage reported in chat",
      description: "Reported at 10:00.",
      priority: "high",
    });
    expect(proposed.created).toBe(true);
    expect(proposed.proposal?.proposalStatus).toBe("pending");
    expect(proposed.inboxItem?.details).toMatchObject({ proposal_id: proposed.outcome.id });
    expect(store.listInboxItems(ownerId).map((item) => item.id)).toContain(proposed.inboxItem!.id);

    // Re-proposing is a retry, not a second question for the reviewer.
    const again = outcomes.proposeIssue(REF, {
      workspaceId: "local",
      recipientId: ownerId,
      actorType: "agent",
      actorId: "agent_1",
      title: "API outage reported in chat",
    });
    expect(again.created).toBe(false);
    expect(again.outcome.id).toBe(proposed.outcome.id);

    const proposalId = proposed.outcome.id;
    const approved = outcomes.approveProposal(proposalId, { workspaceId: "local", approvedBy: ownerId });
    expect(approved.created).toBe(true);
    expect(approved.proposal.proposalStatus).toBe("approved");
    expect(approved.issue?.title).toBe("API outage reported in chat");
    expect(approved.issue?.priority).toBe("high");
    // The Issue carries the message it came from, so the trail is followable.
    expect(approved.issue?.contextRefs?.[0]).toMatchObject({
      type: "message",
      connection_id: REF.connectionId,
      external_message_id: REF.externalMessageId,
    });
    // The reviewer's inbox item is closed out rather than left asking.
    expect(store.listInboxItems(ownerId).find((item) => item.id === proposed.inboxItem!.id)).toBeUndefined();

    // Approving twice creates one Issue, not two.
    const twice = outcomes.approveProposal(proposalId, { workspaceId: "local", approvedBy: ownerId });
    expect(twice.created).toBe(false);
    expect(twice.issue?.id).toBe(approved.issue!.id);

    expect(() => outcomes.rejectProposal(proposalId, { workspaceId: "local", rejectedBy: ownerId }))
      .toThrow("already approved");
  });

  it("records a rejection as a dismissal and refuses to approve afterwards", () => {
    const { store, ownerId } = seed();
    const outcomes = store.messagingOutcomes;
    const proposed = outcomes.proposeIssue(REF, {
      workspaceId: "local",
      recipientId: ownerId,
      actorType: "agent",
      actorId: "agent_1",
      title: "Not worth an Issue",
    });

    const rejected = outcomes.rejectProposal(proposed.outcome.id, {
      workspaceId: "local",
      rejectedBy: ownerId,
    });
    expect(rejected.created).toBe(true);
    expect(rejected.issue).toBeNull();
    expect(rejected.proposal.proposalStatus).toBe("rejected");
    expect(rejected.outcome).toMatchObject({ outcomeKind: "dismissed", reason: "proposal_rejected" });

    // Rejecting again is idempotent: no second dismissal appears in the ledger.
    const twice = outcomes.rejectProposal(proposed.outcome.id, { workspaceId: "local", rejectedBy: ownerId });
    expect(twice.created).toBe(false);
    expect(twice.outcome.id).toBe(rejected.outcome.id);

    expect(() => outcomes.approveProposal(proposed.outcome.id, { workspaceId: "local", approvedBy: ownerId }))
      .toThrow("already rejected");
    expect(() => outcomes.approveProposal("mout_missing", { workspaceId: "local", approvedBy: ownerId }))
      .toThrow("Proposal not found");
  });

  it("creates an Issue directly, and does not create a second one on a repeat", () => {
    const { store, ownerId } = seed();
    const first = store.messagingOutcomes.createIssue(REF, {
      workspaceId: "local",
      title: "Direct issue",
      createdBy: ownerId,
    });
    expect(first.created).toBe(true);

    const second = store.messagingOutcomes.createIssue(REF, {
      workspaceId: "local",
      title: "Different title, same message",
      createdBy: ownerId,
    });
    expect(second.created).toBe(false);
    expect(second.issue.id).toBe(first.issue.id);

    expect(() => store.messagingOutcomes.createIssue(REF, { workspaceId: "local", title: "  " }))
      .toThrow("title is required");
  });

  it("refuses a task id that belongs to another workspace", () => {
    const { store } = seed();
    expect(() => store.messagingOutcomes.record(REF, {
      workspaceId: "local",
      outcome: "ignored",
      reason: "noise",
      taskId: "task_elsewhere",
    })).toThrow("task_id must reference a task in this workspace");
  });
});
