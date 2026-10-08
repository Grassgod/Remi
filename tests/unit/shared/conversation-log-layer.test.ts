import { describe, expect, it } from "bun:test";
import { conversationLogLayer, type ConversationLogLayer } from "@multiremi/contracts/conversation-log";
import { issueActivityLayer } from "@multiremi/contracts/issue-activity";
import { MESSAGE_KINDS, type WakeReason } from "@multiremi/contracts/unified-model";

const wakeLayers = {
  human_sender: "conversation", agent_dispatch: "conversation",
  platform_to_owner: "system", member_to_delegator: "system",
  to_leader: "system", to_parent_owner: "system",
  agent_pair_not_privileged: "system", pair_round_trip_limit: "system",
  self: "system", recipient_unavailable: "system", no_recipient: "system",
  requested_next_turn: "system", requested_inbox_only: "system", migration: "system",
  dependencies_unmet: "system", source_side_session: "system", no_issue_target: "system",
} satisfies Record<WakeReason, ConversationLogLayer>;

describe("conversationLogLayer", () => {
  it("classifies every message kind by sender, even with recipient envelope metadata", () => {
    for (const message_kind of MESSAGE_KINDS) {
      for (const sender_type of ["member", "agent", "platform", "timer"]) {
        expect(conversationLogLayer({ kind: "message", body_md: "Report", message_kind, sender_type,
          author_type: "agent", metadata: { envelope: { kind: "report" } } }))
          .toBe(sender_type === "member" || sender_type === "agent" ? "conversation" : "system");
      }
    }
  });

  it.each(Object.entries(wakeLayers))("explicitly classifies WakeReason %s as %s", (wake_source, expected) => {
    expect(conversationLogLayer({ kind: "turn", body_md: "QA completed a task. Read the latest Session Updates.",
      metadata: { wake_source } })).toBe(expected);
  });

  it.each([
    [null, "conversation"], [undefined, "conversation"], ["mention", "conversation"], ["relay", "conversation"],
    ["delegation_return", "system"], ["re_ring", "system"], ["future_reason", "system"], [7, "system"],
  ] as const)("classifies historical or unknown source %s as %s", (wake_source, expected) => {
    expect(conversationLogLayer({ kind: "turn", body_md: "Task", metadata: { wake_source } })).toBe(expected);
  });

  it.each(["读收件箱 ises_123", "\n# 读收件箱 ises_123", "## **读收件箱**"])(
    "preserves legacy inbox prefixes even for a dispatch source: %s", body_md => {
      expect(conversationLogLayer({ kind: "turn", body_md, metadata: { wake_source: "human_sender" } })).toBe("system");
    },
  );

  it("supports old cached rows without canonical headers", () => {
    for (const author_type of ["member", "agent"]) {
      expect(conversationLogLayer({ kind: "message", body_md: "Comment", author_type })).toBe("conversation");
      expect(conversationLogLayer({ kind: "message", body_md: "Envelope", author_type,
        metadata: { envelope: { kind: "report" } } })).toBe("system");
    }
    expect(conversationLogLayer({ kind: "message", body_md: "System", author_type: "system" })).toBe("system");
    expect(conversationLogLayer({ kind: "head", body_md: "Title" })).toBe("conversation");
    expect(conversationLogLayer({ kind: "turn", body_md: "Task" })).toBe("conversation");
  });

  it("keeps workspace clearing on the activity side and classifies other events as system", () => {
    expect(issueActivityLayer("workspace_move_cleared")).toBe("conversation");
    expect(conversationLogLayer({ kind: "message", body_md: "Cleared project", sender_type: "platform",
      metadata: { type: "workspace_move_cleared" } })).toBe("system");
    for (const kind of ["system", "result_published", "follow_frozen", "future_kind"]) {
      expect(conversationLogLayer({ kind, body_md: "Event" })).toBe("system");
    }
  });
});
