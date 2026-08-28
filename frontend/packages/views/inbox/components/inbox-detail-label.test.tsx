import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import { describe, expect, it, vi } from "vitest";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhInbox from "../../locales/zh-Hans/inbox.json";
import { InboxDetailLabel, useInboxTitle } from "./inbox-detail-label";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("../../issues/components", () => ({
  StatusIcon: () => null,
  PriorityIcon: () => null,
}));

function autopilotItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "workspace-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "system",
    actor_id: null,
    type: "autopilot_run_completed",
    severity: "info",
    issue_id: null,
    title: "Server fallback",
    body: "Completed in 12s | No changes.",
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-08-27T09:00:00Z",
    details: null,
    ...overrides,
  };
}

function renderLabel(
  value: InboxItem,
  locale: "en" | "zh-Hans" = "en",
  groupedItems?: InboxItem[],
) {
  return render(
    <I18nProvider
      locale={locale}
      resources={{
        en: { common: enCommon, inbox: enInbox },
        "zh-Hans": { common: zhCommon, inbox: zhInbox },
      }}
    >
      <InboxDetailLabel item={value} groupedItems={groupedItems} />
    </I18nProvider>,
  );
}

describe("InboxDetailLabel autopilot outcomes", () => {
  it("renders a localized no-change result instead of the English fallback", () => {
    renderLabel(autopilotItem({
      details: {
        duration_seconds: 12,
        outcome: {
          kind: "no_change",
          text: null,
          links: [],
          counts: null,
          risks: [],
          action: { kind: "none", text: null },
        },
      },
    }), "zh-Hans");

    expect(screen.getByText("本次无变更")).toBeInTheDocument();
    expect(screen.getByText(/耗时 12 秒/)).toBeInTheDocument();
    expect(screen.queryByText(/Completed in/)).not.toBeInTheDocument();
  });

  it("renders change counts and the most important output link", () => {
    renderLabel(autopilotItem({
      details: {
        duration_seconds: 9,
        outcome: {
          kind: "changes",
          text: "Updated the docs.",
          links: [
            { kind: "pull_request", url: "https://github.com/Grassgod/Remi/pull/80", number: 80 },
            { kind: "merge_request", url: "https://code.byted.org/acme/docs/merge_requests/12", number: 12 },
          ],
          counts: { changes: 2 },
          risks: [],
          action: { kind: "review", text: null },
        },
      },
    }));

    expect(screen.getByText("2 changes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #80" })).toHaveAttribute(
      "href",
      "https://github.com/Grassgod/Remi/pull/80",
    );
    expect(screen.queryByRole("link", { name: "MR #12" })).not.toBeInTheDocument();
  });

  it("localizes the failure wrapper while preserving the cleaned agent summary", () => {
    renderLabel(autopilotItem({
      type: "autopilot_run_failed",
      details: {
        outcome: {
          kind: "failed",
          text: "Dependency service unavailable.",
          links: [],
          counts: null,
          risks: ["Dependency service unavailable."],
          action: { kind: "investigate", text: "Dependency service unavailable." },
        },
      },
    }), "zh-Hans");

    expect(screen.getByText("失败：Dependency service unavailable.")).toBeInTheDocument();
    expect(screen.getByText(/需要排查/)).toBeInTheDocument();
  });

  it("uses one consistent run-with-output count for a merged row", () => {
    const changed = autopilotItem({
      id: "changed",
      details: {
        outcome: {
          kind: "changes",
          text: "Published.",
          links: [{ kind: "pull_request", url: "https://github.com/Grassgod/Remi/pull/80", number: 80 }],
          counts: { changes: 1 },
          risks: [],
          action: { kind: "review", text: null },
        },
      },
    });
    const unchanged = autopilotItem({
      id: "unchanged",
      details: {
        outcome: {
          kind: "no_change",
          text: null,
          links: [],
          counts: null,
          risks: [],
          action: { kind: "none", text: null },
        },
      },
    });

    renderLabel(changed, "zh-Hans", [changed, unchanged]);
    expect(screen.getByText("1 次包含产出")).toBeInTheDocument();
    expect(screen.getByText(/1 次需要处理/)).toBeInTheDocument();
    expect(screen.queryByText(/个改动/)).not.toBeInTheDocument();
  });

  it("renders a plain-text completed summary exactly once", () => {
    const summary = "Published the repository wiki update successfully.";
    renderLabel(autopilotItem({
      body: "Completed in 8s | fallback",
      details: {
        outcome: {
          kind: "unknown",
          text: summary,
          links: [],
          counts: null,
          risks: [],
          action: { kind: "none", text: null },
        },
      },
    }), "zh-Hans");

    expect(screen.getByText(`本次运行已完成：${summary}`)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u")))
      .toHaveLength(1);
  });

  it.each([
    [59, "Took 59s"],
    [60, "Took 1m"],
    [3515, "Took 58m"],
    [7200, "Took 2h 0m"],
  ])("formats a %i-second duration as %s", (durationSeconds, expected) => {
    renderLabel(autopilotItem({
      details: {
        duration_seconds: durationSeconds,
        outcome: {
          kind: "no_change",
          text: null,
          links: [],
          counts: null,
          risks: [],
          action: { kind: "none", text: null },
        },
      },
    }));

    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
  });
});

function feishuItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "user-1",
    actor_type: null,
    actor_id: null,
    issue_id: null,
    issue_status: null,
    type: "feishu_message_notification",
    severity: "info",
    title: "飞书消息提醒",
    body: null,
    details: null,
    read: false,
    archived: false,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as InboxItem;
}

function Probe({ value, variant }: { value: InboxItem; variant: "row" | "detail" }) {
  const inboxTitle = useInboxTitle();
  return <span data-testid="title">{inboxTitle(value, variant)}</span>;
}

function titleOf(value: InboxItem, variant: "row" | "detail" = "row"): string {
  const { unmount } = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <Probe value={value} variant={variant} />
    </I18nProvider>,
  );
  const text = screen.getByTestId("title").textContent ?? "";
  unmount();
  return text;
}

describe("useInboxTitle", () => {
  it("keeps the server title for a native notification", () => {
    expect(titleOf(feishuItem({ type: "issue_assigned", title: "Fix the sidecar" }))).toBe(
      "Fix the sidecar",
    );
  });

  it("names Feishu on a row whose server title never mentions it", () => {
    const title = titleOf(
      feishuItem({
        type: "feishu_issue_proposal",
        title: "建议创建 Issue",
        details: { message_id: "msg-1", proposal_id: "p-1", chat_name: "Dev group" },
      } as Partial<InboxItem>),
    );
    expect(title).toBe("Feishu issue proposal · Dev group");
  });

  it("falls back to the type label when the row carries no chat name", () => {
    expect(titleOf(feishuItem({ details: { message_id: "msg-1" } } as Partial<InboxItem>))).toBe(
      "Feishu message",
    );
  });

  it("shows the source rather than a chat on a connection alert", () => {
    const title = titleOf(
      feishuItem({
        type: "feishu_ingest_connection_alert",
        title: "飞书消息源连接异常",
        details: { source_id: "src-1", source_name: "personal", consecutive_failures: 3 },
      } as unknown as Partial<InboxItem>),
    );
    expect(title).toBe("Feishu ingestion alert · personal");
  });

  it("drops the type label in the detail heading, which prints it separately", () => {
    const withChat = feishuItem({
      details: { message_id: "msg-1", chat_name: "Dev group" },
    } as Partial<InboxItem>);
    expect(titleOf(withChat, "detail")).toBe("Dev group");
    expect(titleOf(feishuItem({ details: { message_id: "msg-1" } } as Partial<InboxItem>), "detail"))
      .toBe("Feishu message");
  });
});
