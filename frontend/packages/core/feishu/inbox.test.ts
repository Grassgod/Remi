import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import {
  feishuInboxActions,
  feishuInboxContext,
  feishuInboxOrigin,
  isFeishuInboxType,
  safeFeishuAppLink,
} from "./inbox";

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
    title: "New Feishu message",
    body: null,
    details: null,
    read: false,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as InboxItem;
}

describe("isFeishuInboxType", () => {
  it("accepts the four ingestion types and nothing else", () => {
    expect(isFeishuInboxType("feishu_message_notification")).toBe(true);
    expect(isFeishuInboxType("feishu_reply_draft")).toBe(true);
    expect(isFeishuInboxType("feishu_issue_proposal")).toBe(true);
    expect(isFeishuInboxType("feishu_ingest_connection_alert")).toBe(true);
    expect(isFeishuInboxType("issue_assigned")).toBe(false);
    expect(isFeishuInboxType("feishu_")).toBe(false);
  });
});

describe("safeFeishuAppLink", () => {
  it("keeps absolute https links", () => {
    expect(safeFeishuAppLink("https://applink.feishu.cn/client/message/link/open?token=x")).toBe(
      "https://applink.feishu.cn/client/message/link/open?token=x",
    );
  });

  it("drops every scheme that could execute in the page", () => {
    // The value is copied verbatim from a Feishu payload, so it is attacker
    // influenced text on its way into an `href`.
    expect(safeFeishuAppLink("javascript:alert(1)")).toBeNull();
    expect(safeFeishuAppLink("JavaScript:alert(1)")).toBeNull();
    expect(safeFeishuAppLink("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeFeishuAppLink("http://applink.feishu.cn/x")).toBeNull();
    expect(safeFeishuAppLink("lark://msg/1")).toBeNull();
  });

  it("drops relative and empty values", () => {
    expect(safeFeishuAppLink("/settings")).toBeNull();
    expect(safeFeishuAppLink("")).toBeNull();
    expect(safeFeishuAppLink(null)).toBeNull();
    expect(safeFeishuAppLink(undefined)).toBeNull();
  });
});

describe("feishuInboxContext", () => {
  it("returns null for non-Feishu rows", () => {
    expect(feishuInboxContext(item({ type: "issue_assigned" }))).toBeNull();
  });

  it("reads the details bag and sanitizes the app link", () => {
    const context = feishuInboxContext(
      item({
        details: {
          message_id: "msg-1",
          source_id: "src-1",
          chat_id: "chat-1",
          message_app_link: "javascript:alert(1)",
        },
      } as Partial<InboxItem>),
    );
    expect(context?.messageId).toBe("msg-1");
    expect(context?.sourceId).toBe("src-1");
    expect(context?.chatId).toBe("chat-1");
    expect(context?.appLink).toBeNull();
  });

  it("reads the chat name the ingestion pipeline copies into details", () => {
    const context = feishuInboxContext(
      item({ details: { message_id: "msg-1", chat_id: "chat-1", chat_name: "研发群" } } as Partial<InboxItem>),
    );
    expect(context?.chatName).toBe("研发群");
    expect(feishuInboxContext(item({ details: { chat_id: "chat-1" } } as Partial<InboxItem>))?.chatName).toBeNull();
  });

  it("coerces consecutive_failures whether it arrives as a number or a string", () => {
    const asNumber = feishuInboxContext(
      item({
        type: "feishu_ingest_connection_alert",
        details: { source_name: "personal", consecutive_failures: 3 },
      } as unknown as Partial<InboxItem>),
    );
    expect(asNumber?.consecutiveFailures).toBe(3);
    expect(asNumber?.sourceName).toBe("personal");

    const asString = feishuInboxContext(
      item({
        type: "feishu_ingest_connection_alert",
        details: { consecutive_failures: "5" },
      } as Partial<InboxItem>),
    );
    expect(asString?.consecutiveFailures).toBe(5);

    const missing = feishuInboxContext(item({ type: "feishu_ingest_connection_alert" }));
    expect(missing?.consecutiveFailures).toBeNull();
  });

  it("prefers the nested proposal title and falls back to the body", () => {
    const nested = feishuInboxContext(
      item({
        type: "feishu_issue_proposal",
        body: "body title",
        details: { proposal_id: "p-1", proposed_issue: { title: "Fix the flaky poller" } },
      } as unknown as Partial<InboxItem>),
    );
    expect(nested?.proposedTitle).toBe("Fix the flaky poller");
    expect(nested?.proposalId).toBe("p-1");

    const fallback = feishuInboxContext(
      item({ type: "feishu_issue_proposal", body: "body title" }),
    );
    expect(fallback?.proposedTitle).toBe("body title");
  });

  it("does not invent a proposal title for other row kinds", () => {
    const context = feishuInboxContext(item({ body: "just a message" }));
    expect(context?.proposedTitle).toBeNull();
  });
});

describe("feishuInboxOrigin", () => {
  it("names the chat for an ingested message and the source for an alert", () => {
    const message = feishuInboxContext(
      item({ details: { message_id: "msg-1", chat_name: "研发群" } } as Partial<InboxItem>),
    );
    expect(message && feishuInboxOrigin(message)).toBe("研发群");

    const alert = feishuInboxContext(
      item({
        type: "feishu_ingest_connection_alert",
        // The alert has no chat — it is about the source itself.
        details: { source_id: "src-1", source_name: "personal", chat_name: "研发群" },
      } as Partial<InboxItem>),
    );
    expect(alert && feishuInboxOrigin(alert)).toBe("personal");
  });

  it("returns null when the row carries no origin to show", () => {
    const context = feishuInboxContext(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>));
    expect(context && feishuInboxOrigin(context)).toBeNull();
  });
});

describe("feishuInboxActions", () => {
  const context = (overrides: Partial<InboxItem>) => {
    const value = feishuInboxContext(item(overrides));
    if (value === null) throw new Error("expected a Feishu context");
    return value;
  };

  it("offers approve and reject only for a proposal that still has its id", () => {
    const withId = feishuInboxActions(
      context({
        type: "feishu_issue_proposal",
        details: { message_id: "msg-1", proposal_id: "p-1" },
      } as Partial<InboxItem>),
    );
    expect(withId.canApprove).toBe(true);
    expect(withId.canReject).toBe(true);

    const withoutId = feishuInboxActions(
      context({ type: "feishu_issue_proposal", details: { message_id: "msg-1" } } as Partial<InboxItem>),
    );
    expect(withoutId.canApprove).toBe(false);
    expect(withoutId.canReject).toBe(false);
  });

  it("requires a message id before offering ignore or mark-processed", () => {
    const resolvable = feishuInboxActions(
      context({ details: { message_id: "msg-1" } } as Partial<InboxItem>),
    );
    expect(resolvable.canIgnore).toBe(true);
    expect(resolvable.canMarkProcessed).toBe(true);

    const orphaned = feishuInboxActions(context({}));
    expect(orphaned.canIgnore).toBe(false);
    expect(orphaned.canMarkProcessed).toBe(false);
  });

  it("gives the connection alert nothing to decide", () => {
    const actions = feishuInboxActions(
      context({
        type: "feishu_ingest_connection_alert",
        details: { message_id: "msg-1", proposal_id: "p-1" },
      } as Partial<InboxItem>),
    );
    expect(actions).toEqual({
      canApprove: false,
      canReject: false,
      canIgnore: false,
      canMarkProcessed: false,
    });
  });
});
