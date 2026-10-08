import { describe, expect, it } from "bun:test";
import type { MultiremiIssueDecision, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import { buildIssueDecisionCard, buildQuestionElements, buildTaskInteractionCard } from "@shared/feishu-task-card.js";

const questions = { questions: [
  { question: "合入吗？", options: [{ label: "合入" }, { label: "暂缓" }] },
  { question: "环境？", multiSelect: true, options: [{ label: "PPE" }, { label: "生产" }] },
] };
const request: MultiremiTaskHumanRequest = {
  id: "hr_test", taskId: "tsk_test", kind: "question", payload: questions, status: "pending",
  response: null, respondedBy: null, createdAt: "2026-10-08T00:00:00.000Z", respondedAt: null,
};
const decision: MultiremiIssueDecision = {
  id: "dcs_test", workspaceId: "local", issueId: "iss_test", sourceIssueId: "iss_test", sourceTaskId: "tsk_test",
  kind: "merge", title: "合入吗？", body: "请确认。", options: ["合入", "暂缓"], status: "escalated",
  answer: null, answeredByMemberId: null, answeredAt: null, history: [], ownerAgentId: null, createdByAgentId: "agt_test",
  createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
};

function inputs(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(inputs);
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [...(node.tag === "input" ? [node] : []), ...Object.values(node).flatMap(inputs)];
}

describe("MUL-531 Feishu input limits", () => {
  const header = { title: { tag: "plain_text", content: "Remi" } };
  const cards = [
    { name: "question form", card: buildQuestionElements("form_test", questions), count: 2 },
    ...[{ recipientOpenId: "ou_reviewer" }, { recipientPending: true }].flatMap(recipient => [
      { name: `task question ${JSON.stringify(recipient)}`, card: buildTaskInteractionCard(request, { header, ...recipient }), count: 2 },
      ...[["合入", "暂缓"], null].map(options => ({
        name: `issue decision ${JSON.stringify(recipient)} options=${JSON.stringify(options)}`,
        card: buildIssueDecisionCard({ ...decision, options }, { header, ...recipient }), count: 1,
      })),
    ]),
  ];
  for (const { name, card, count } of cards) {
    it(`${name}: all nested input controls respect the Feishu maximum`, () => {
      const controls = inputs(card);
      expect(controls).toHaveLength(count);
      for (const control of controls) {
        expect(typeof control.max_length).toBe("number");
        expect(control.max_length as number).toBeGreaterThan(0);
        expect(control.max_length as number).toBeLessThanOrEqual(1000);
      }
      if (name.startsWith("issue decision")) expect(controls[0].max_length).toBe(1000);
    });
  }
});
