/**
 * @mention handling utilities.
 * Adapted from OpenClaw feishu extension mention.ts — zero modification.
 */

import type { FeishuMessageEvent } from "./types.js";

export type MentionTarget = {
  openId: string;
  name: string;
  key: string; // Placeholder in original message, e.g. @_user_1
};

/** Extract mention targets from message event (excluding the bot itself). */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];

  return mentions
    .filter((m) => {
      if (botOpenId && m.id.open_id === botOpenId) return false;
      return !!m.id.open_id;
    })
    .map((m) => ({
      openId: m.id.open_id!,
      name: m.name,
      key: m.key,
    }));
}

/** Extract message body from text (remove @ placeholders). */
export function extractMessageBody(text: string, allMentionKeys: string[]): string {
  let result = text;
  for (const key of allMentionKeys) {
    result = result.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
  }
  return result.replace(/\s+/g, " ").trim();
}

/** Format @mention for text message. */
export function formatMentionForText(target: MentionTarget): string {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}

/** Format @mention for card message (lark_md). */
export function formatMentionForCard(target: MentionTarget): string {
  return `<at id=${target.openId}></at>`;
}

/** Build complete message with @mentions (text format). */
export function buildMentionedMessage(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) return message;
  const mentionParts = targets.map((t) => formatMentionForText(t));
  return `${mentionParts.join(" ")} ${message}`;
}

/** Build card content with @mentions (Markdown format). */
export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) return message;
  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}
