import { describe, expect, it } from "vitest";
import { RESOURCES } from "./index";
import enIssues from "./en/issues.json";
import jaIssues from "./ja/issues.json";
import koIssues from "./ko/issues.json";
import zhIssues from "./zh-Hans/issues.json";
import zhChat from "./zh-Hans/chat.json";

// Issues have one execution owner; questions climb the owner chain and then
// reach any workspace member; a finished round is closed by a status change.
// Copy for the retired designated human, formal delivery and acceptance must
// not come back. Onboarding agent templates keep their unrelated advice on
// writing acceptance criteria, so they are not scanned.

function strings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`));
}

const RETIRED: Record<string, RegExp[]> = {
  "zh-Hans": [/验收/, /任何成员都可以回答/, /指定人类/, /执行统筹/, /待人工回答/, /等待人工审批/, /正式交付/, /责任映射/, /等待审核/],
  en: [/designated human/i, /formal delivery/i, /accept(ing)? (the )?delivery/i, /delivery acceptance/i, /execution coordinator/i,
    /any member can answer/i, /waiting for approval/i, /result reviewer/i, /waiting for review/i],
  ja: [/検収/, /レビュー待ち/],
  ko: [/검수/, /검토 대기 중/],
};

describe("issue execution copy", () => {
  for (const [locale, patterns] of Object.entries(RETIRED)) {
    it(`${locale} has no retired responsibility, delivery or acceptance copy`, () => {
      const bundle = RESOURCES[locale as keyof typeof RESOURCES] as Record<string, unknown>;
      const hits = Object.entries(bundle)
        .filter(([namespace]) => namespace !== "onboarding")
        // The workbench keeps its "ready for review" queue for finished rounds.
        .flatMap(([namespace, value]) => strings(value, namespace))
        .filter(([path, text]) => path !== "workbench.sections.awaiting_review" && patterns.some(pattern => pattern.test(text)));
      expect(hits).toEqual([]);
    });
  }

  it("names the execution owner and the question states as agreed", () => {
    expect(zhIssues.detail.prop_assignee).toBe("执行负责人");
    expect(enIssues.detail.prop_assignee).toBe("Execution owner");
    expect(jaIssues.detail.prop_assignee).toBe("実行責任者");
    expect(koIssues.detail.prop_assignee).toBe("실행 책임자");
    expect(zhIssues.responsibility).toMatchObject({
      tag_pending: "待回答",
      tag_waiting_on: "等待 {{name}} 回答",
      tag_answered: "已回答",
      answer_action: "回答问题",
      view_action: "查看",
      pending_other: "{{count}} 个问题待回答",
      drawer_title: "问题",
      pending_section: "待回答的问题",
      agent_section: "等待 Agent 回答",
      history_section: "已回答与已关闭",
      agent_readonly: "由 Agent 处理；答不了会继续上交。",
    });
    expect(zhChat.status_pill.stages.awaiting_human).toBe("等待回答");
  });
});
