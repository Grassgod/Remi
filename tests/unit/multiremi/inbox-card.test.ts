import { describe, expect, it } from "bun:test";
import type { MultiremiInboxItem, MultiremiWorkspace } from "@multiremi/contracts/types.js";
import {
  buildInboxNotificationCard,
  buildInboxNotificationCardWithImages,
  escapeMarkdown,
  humanizeEventType,
} from "@multiremi/notifications/inbox-card.js";
import { summarizeAutopilotOutcome } from "@multiremi/store/autopilot-run-notification.js";

const CHECKOUT_FAILURE_FIXTURE = await Bun.file(new URL(
  "../../fixtures/multiremi/autopilot-no-change-checkout-failure.txt",
  import.meta.url,
)).text();

function item(overrides: Partial<MultiremiInboxItem> = {}): MultiremiInboxItem {
  return {
    id: "inbox-1",
    workspaceId: "workspace-1",
    issueId: "issue-1",
    memberId: "member-1",
    recipientType: "member",
    recipientId: "member-1",
    actorType: "system",
    actorId: null,
    type: "autopilot_run_completed",
    severity: "info",
    title: "Atlas · Repository Wiki · Remi #82",
    body: "Completed in 2m | Good, now let's inspect the repository...",
    details: null,
    read: false,
    archived: false,
    createdAt: "2026-08-28T05:28:37.614Z",
    issue: null,
    ...overrides,
  };
}

const workspace = { slug: "acme" } as MultiremiWorkspace;

function cardContent(card: Record<string, unknown>): string {
  const body = card.body as { elements: Array<{ content?: string }> };
  return body.elements[0]?.content ?? "";
}

function cardButton(card: Record<string, unknown>): Record<string, unknown> {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  return body.elements[1] ?? {};
}

describe("autopilot inbox notification cards", () => {
  it("renders structured Chinese result, trigger, and action lines with a clickable PR", () => {
    const card = buildInboxNotificationCard({
      item: item({
        details: {
          autopilot_id: "autopilot-1",
          triggered_at: "2026-08-28T05:28:37.614Z",
          trigger: "scm_event",
          trigger_object: {
            event_type: "change.merged",
            repository_name: "Remi",
            change_number: 82,
            target_branch: "main",
            occurred_at: "2026-08-28T05:28:37.614Z",
          },
          outcome: {
            kind: "changes",
            headline: null,
            text: "Published the release.",
            links: [{
              kind: "pull_request",
              url: "https://github.com/Grassgod/Remi/pull/82",
              number: 82,
            }],
            counts: { changes: 1 },
            risks: [],
            action: { kind: "review", text: null },
          },
        },
      }),
      workspace,
      publicUrl: "https://remi.example.com",
    });

    const content = cardContent(card);
    expect(content.split("\n")).toHaveLength(3);
    expect(content).toContain("**结论**  产生 1 个改动 · [PR #82](https://github.com/Grassgod/Remi/pull/82)");
    expect(content).toContain("**触发**  Remi #82 · ");
    expect(content).toContain("**处理**  请审阅变更");
    expect(content).not.toContain("Good, now let's");
    expect(content).not.toContain("github\\.com");
    expect(cardButton(card)).toMatchObject({
      text: { tag: "plain_text", content: "查看详情" },
      behaviors: [{
        type: "open_url",
        default_url: "https://remi.example.com/acme/inbox?item=inbox-1",
      }],
    });
  });

  it("renders the real checkout failure headline without repeating it in the action line", () => {
    const outcome = summarizeAutopilotOutcome(CHECKOUT_FAILURE_FIXTURE);
    const card = buildInboxNotificationCard({
      item: item({
        details: {
          autopilot_id: "autopilot-1",
          triggered_at: "2026-08-28T05:28:37.614Z",
          trigger: "scm_event",
          trigger_object: {
            event_type: "change.merged",
            repository_name: "dy-code-context",
            change_number: 133,
          },
          outcome,
        },
      }),
      workspace,
      publicUrl: "https://remi.example.com",
    });

    const content = cardContent(card);
    expect(content.split("\n")).toHaveLength(3);
    expect(content).toContain("**结论**  结果：no-op（因目标仓库无法检出，未做任何 Wiki 变更）。");
    expect(content).toContain("**处理**  需要排查");
    expect(content).not.toContain("**处理**  需要排查：");
  });

  it("keeps legacy cards on the body fallback without corrupting URLs or punctuation", () => {
    const card = buildInboxNotificationCard({
      item: item({
        details: { autopilot_id: "autopilot-1" },
        body: "Completed in 2m | See https://github.com/Grassgod/Remi/pull/82.",
      }),
      workspace,
      publicUrl: "https://remi.example.com",
    });

    const content = cardContent(card);
    expect(content).toContain("**Event**  Autopilot run completed");
    expect(content).toContain("Completed in 2m | See https://github.com/Grassgod/Remi/pull/82.");
    expect(content).not.toContain("\\|");
    expect(content).not.toContain("github\\.com");
    expect(content).not.toContain("2026-08-28T05:28:37.614Z");
    expect(content).toContain("2026/08/28 GMT+8 13:28");
  });

  it("does not claim a partial structured outcome needs no action", () => {
    const card = buildInboxNotificationCard({
      item: item({
        details: {
          autopilot_id: "autopilot-1",
          trigger: "schedule",
          outcome: {
            kind: "unknown",
            text: "Legacy structured summary.",
            links: [],
            counts: null,
          },
        },
      }),
      workspace,
      publicUrl: null,
    });

    expect(cardContent(card)).toContain("**处理**  请查看运行详情");
    expect(cardContent(card)).not.toContain("无需处理");
  });

  it("limits legacy card summaries to the same 240-character budget as inbox summaries", () => {
    const card = buildInboxNotificationCard({
      item: item({ type: "status_changed", body: `Start ${"x".repeat(500)} END` }),
      workspace,
      publicUrl: null,
    });
    const resultLine = cardContent(card).split("\n").find((line) => line.startsWith("**Result**")) ?? "";
    expect(resultLine).toEndWith("…");
    expect(resultLine).not.toContain("END");
  });

  it("recognizes the actual autopilot ledger event keys", () => {
    expect(humanizeEventType("autopilot_run_completed")).toBe("Autopilot run completed");
    expect(humanizeEventType("autopilot_run_failed")).toBe("Autopilot run failed");
  });

  it("escapes formatting markers but leaves ordinary punctuation and URLs intact", () => {
    expect(escapeMarkdown("*Result* | https://example.com/a-b_(c)."))
      .toBe("\\*Result\\* | https://example.com/a-b_(c).");
  });

  it("renders uploaded body images as card image elements", async () => {
    const card = await buildInboxNotificationCardWithImages({
      item: item({ type: "comment_created", body: "See ![capture](/tmp/capture.png) now" }),
      workspace,
      publicUrl: "https://remi.example.com",
    }, async () => "img_notification");
    const elements = (card.body as { elements: Array<Record<string, any>> }).elements;

    expect(elements).toContainEqual({
      tag: "img",
      img_key: "img_notification",
      alt: { tag: "plain_text", content: "capture" },
    });
    expect(JSON.stringify(card)).not.toContain("/tmp/capture.png");
  });

  it("degrades notification body images to clickable links without changing ordinary escaping", () => {
    const card = buildInboxNotificationCard({
      item: item({
        type: "comment_created",
        body: "*Result* ![capture](/api/attachments/att_card/content)",
      }),
      workspace,
      publicUrl: "https://remi.example.com",
    });
    const json = JSON.stringify(card);

    expect(json).toContain("\\\\*Result\\\\*");
    expect(json).toContain("[图片: capture](https://remi.example.com/api/attachments/att_card/content)");
    expect(json).not.toContain("![capture]");
  });
});
