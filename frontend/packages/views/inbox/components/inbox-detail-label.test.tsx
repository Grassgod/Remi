import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

vi.mock("../../issues/components", () => ({
  StatusIcon: () => null,
  PriorityIcon: () => null,
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

const { useInboxTitle } = await import("./inbox-detail-label");

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "user-1",
    actor_type: null,
    actor_id: null,
    issue_id: null,
    type: "feishu_message_notification",
    title: "飞书消息提醒",
    body: null,
    details: null,
    read: false,
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
    expect(titleOf(item({ type: "issue_assigned", title: "Fix the sidecar" }))).toBe(
      "Fix the sidecar",
    );
  });

  it("names Feishu on a row whose server title never mentions it", () => {
    // The server writes this proposal row as "建议创建 Issue" — indistinguishable
    // from a native suggestion, and Chinese regardless of the viewer's locale.
    const title = titleOf(
      item({
        type: "feishu_issue_proposal",
        title: "建议创建 Issue",
        details: { message_id: "msg-1", proposal_id: "p-1", chat_name: "Dev group" },
      } as Partial<InboxItem>),
    );
    expect(title).toBe("Feishu issue proposal · Dev group");
  });

  it("falls back to the type label when the row carries no chat name", () => {
    expect(titleOf(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>))).toBe(
      "Feishu message",
    );
  });

  it("shows the source rather than a chat on a connection alert", () => {
    const title = titleOf(
      item({
        type: "feishu_ingest_connection_alert",
        title: "飞书消息源连接异常",
        details: { source_id: "src-1", source_name: "personal", consecutive_failures: 3 },
      } as unknown as Partial<InboxItem>),
    );
    expect(title).toBe("Feishu ingestion alert · personal");
  });

  it("drops the type label in the detail heading, which prints it separately", () => {
    const withChat = item({
      details: { message_id: "msg-1", chat_name: "Dev group" },
    } as Partial<InboxItem>);
    expect(titleOf(withChat, "detail")).toBe("Dev group");
    expect(titleOf(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>), "detail")).toBe(
      "Feishu message",
    );
  });
});
