/**
 * Mission approval — Feishu card buttons for approve/reject.
 * Reuses the card-actions.ts pending action mechanism.
 */

import type { Mission } from "./model.js";

/**
 * Build a Feishu Card 2.0 JSON for mission approval.
 */
export function buildApprovalCard(mission: Mission): Record<string, unknown> {
  const contractCount = mission.contract?.cases?.length ?? 0;

  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { content: `📋 需求审批: ${mission.title}`, tag: "plain_text" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**提交人**: ${mission.createdByName ?? "Unknown"}`,
            mission.description ? `**描述**: ${mission.description}` : null,
            contractCount > 0 ? `**Contract**: ${contractCount} 个验证 Case` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { content: "✅ 批准", tag: "plain_text" },
              type: "primary",
              value: JSON.stringify({
                _action_type: "mission_approve",
                missionId: mission.id,
              }),
            },
            {
              tag: "button",
              text: { content: "❌ 驳回", tag: "plain_text" },
              type: "danger",
              value: JSON.stringify({
                _action_type: "mission_reject",
                missionId: mission.id,
              }),
            },
          ],
        },
      ],
    },
  };
}

/**
 * Parse a mission action from a card button click value.
 * Returns null if not a mission action.
 */
export function parseMissionAction(
  valueJson: string,
): { type: "mission_approve" | "mission_reject"; missionId: string } | null {
  try {
    const val = JSON.parse(valueJson);
    if (val._action_type === "mission_approve" || val._action_type === "mission_reject") {
      return { type: val._action_type, missionId: val.missionId };
    }
  } catch {
    // not a mission action
  }
  return null;
}
