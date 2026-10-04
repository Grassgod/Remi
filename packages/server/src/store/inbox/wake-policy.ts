import type { MessageKind, MessageRecipient, MessageSenderType, MessageWake, WakeReason } from "@multiremi/contracts/unified-model.js";

export interface WakeContext {
  recipientAvailable: boolean;
  recipientId: string | null;
  recipientType: "agent" | "member" | "none";
  dependenciesMet?: boolean;
  sourceSideSession?: boolean;
  sourceHasIssue?: boolean;
  targetHasIssue?: boolean;
  pairHops?: number;
  pairLimit?: number;
  isReplyToDelegator?: boolean;
  isLeader?: boolean;
  isParentOwner?: boolean;
}

/** Ordered policy. Explicitly quieter requests never escalate; no row is rejected. */
export function resolveWake(
  sender: { type: MessageSenderType; id: string | null },
  recipient: MessageRecipient,
  requested: MessageWake,
  kind: MessageKind,
  ctx: WakeContext,
): { applied: MessageWake; reason: WakeReason } {
  const result = (applied: MessageWake, reason: WakeReason) => ({ applied, reason });
  if (recipient.type === "none" || ctx.recipientType === "none") return result("inbox_only", "no_recipient");
  if (!ctx.recipientAvailable) return result("inbox_only", "recipient_unavailable");
  if (sender.type === ctx.recipientType && sender.id === ctx.recipientId) return result("inbox_only", "self");
  if (requested === "inbox_only") return result(requested, "requested_inbox_only");
  if (requested === "next_turn") return result(requested, "requested_next_turn");
  if (ctx.recipientType === "member") return result("now", sender.type === "member" ? "human_sender" : "platform_to_owner");
  if (ctx.dependenciesMet === false) return result("next_turn", "dependencies_unmet");
  if (sender.type === "member") return result("now", "human_sender");
  if (sender.type === "platform" || sender.type === "timer") return result("now", "platform_to_owner");
  if (ctx.sourceSideSession) return result("next_turn", "source_side_session");
  if (kind === "request" && (ctx.sourceHasIssue === false || ctx.targetHasIssue === false)) return result("next_turn", "no_issue_target");
  if ((ctx.pairHops ?? 0) >= 2 * (ctx.pairLimit ?? 5)) return result("next_turn", "pair_round_trip_limit");
  if (kind === "request") return result("now", "agent_dispatch");
  if (ctx.isReplyToDelegator && kind === "reply") return result("now", "member_to_delegator");
  if (ctx.isLeader || recipient.type === "role" && recipient.ref === "leader") return result("now", "to_leader");
  if (ctx.isParentOwner || recipient.type === "role" && recipient.ref === "parent_owner") return result("now", "to_parent_owner");
  return result("next_turn", "agent_pair_not_privileged");
}
