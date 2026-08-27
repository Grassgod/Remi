import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

const approve = vi.hoisted(() => vi.fn());
const reject = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    settings: () => "/test/settings",
    issueDetail: (id: string) => `/test/issues/${id}`,
  }),
}));

vi.mock("@multiremi/core/feishu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/feishu")>()),
  useApproveFeishuProposal: () => ({ mutate: approve, isPending: false }),
  useRejectFeishuProposal: () => ({ mutate: reject, isPending: false }),
  useResolveFeishuMessage: () => ({ mutate: resolve, isPending: false }),
}));

vi.mock("../../navigation", () => ({ useNavigation: () => ({ push }) }));

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

const { FeishuInboxActions } = await import("./feishu-inbox-actions");

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

function renderPanel(value: InboxItem, onArchive = vi.fn()) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <FeishuInboxActions item={value} onArchive={onArchive} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  approve.mockReset();
  reject.mockReset();
  resolve.mockReset();
  push.mockReset();
  toastSuccess.mockReset();
});

describe("FeishuInboxActions", () => {
  it("renders nothing for a non-Feishu row", () => {
    const { container } = renderPanel(item({ type: "issue_assigned" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("approves a proposal and lands on the created issue", async () => {
    approve.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) => {
      opts.onSuccess({ outcomes: [{ outcomeKind: "issue_created", ref: "MUL-9" }] });
    });
    renderPanel(
      item({
        type: "feishu_issue_proposal",
        body: "Fix the sidecar",
        details: { message_id: "msg-1", proposal_id: "p-1" },
      } as Partial<InboxItem>),
    );

    expect(screen.getByText("Fix the sidecar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and create issue" }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("p-1", expect.anything()));
    expect(push).toHaveBeenCalledWith("/test/issues/MUL-9");
  });

  it("archives instead of navigating when approval returns no issue ref", async () => {
    approve.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) => {
      opts.onSuccess({ outcomes: [] });
    });
    const onArchive = vi.fn();
    renderPanel(
      item({
        type: "feishu_issue_proposal",
        details: { message_id: "msg-1", proposal_id: "p-1" },
      } as Partial<InboxItem>),
      onArchive,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve and create issue" }));
    await waitFor(() => expect(onArchive).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses to ignore a message without a reason", async () => {
    renderPanel(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>));

    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves a message as ignored with the typed reason", async () => {
    resolve.mockImplementation((_input: unknown, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    renderPanel(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>));

    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    fireEvent.change(screen.getByLabelText("Why are you ignoring this message?"), {
      target: { value: "spam" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        { messageId: "msg-1", outcome: "ignored", reason: "spam" },
        expect.anything(),
      ),
    );
  });

  it("marks a message processed with the dismissed outcome", async () => {
    resolve.mockImplementation((_input: unknown, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    renderPanel(item({ details: { message_id: "msg-1" } } as Partial<InboxItem>));

    fireEvent.click(screen.getByRole("button", { name: "Mark as processed" }));
    fireEvent.change(screen.getByLabelText("How was this message handled?"), {
      target: { value: "handled in chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        { messageId: "msg-1", outcome: "dismissed", reason: "handled in chat" },
        expect.anything(),
      ),
    );
  });

  it("never offers a send action on a reply draft", () => {
    renderPanel(
      item({ type: "feishu_reply_draft", details: { message_id: "msg-1" } } as Partial<InboxItem>),
    );

    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    expect(
      screen.getByText(
        "This draft has not been sent to Feishu. Replies are never sent automatically.",
      ),
    ).toBeTruthy();
  });

  it("links a connection alert to the settings tab and offers no decision", () => {
    renderPanel(
      item({
        type: "feishu_ingest_connection_alert",
        details: { source_id: "src-1", source_name: "personal", error_code: "unreachable" },
      } as Partial<InboxItem>),
    );

    expect(screen.queryByRole("button", { name: "Ignore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and create issue" })).toBeNull();
    expect(screen.getByText("Error code: unreachable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Open Feishu messages settings/ }));
    expect(push).toHaveBeenCalledWith("/test/settings?tab=feishu-messages");
  });

  it("renders the Feishu link only when it is an absolute https URL", () => {
    const { unmount } = renderPanel(
      item({
        details: { message_id: "msg-1", message_app_link: "javascript:alert(1)" },
      } as Partial<InboxItem>),
    );
    expect(screen.queryByRole("link", { name: /Open in Feishu/ })).toBeNull();
    unmount();

    renderPanel(
      item({
        details: { message_id: "msg-1", message_app_link: "https://applink.feishu.cn/x" },
      } as Partial<InboxItem>),
    );
    const link = screen.getByRole("link", { name: /Open in Feishu/ });
    expect(link.getAttribute("href")).toBe("https://applink.feishu.cn/x");
  });
});
