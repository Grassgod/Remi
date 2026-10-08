import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { messageFixture } from "../../test/messages";
import enMessages from "../../locales/en/messages.json";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

const mockApi = vi.hoisted(() => ({
  listIssueSessions: vi.fn(), listMessages: vi.fn(), sendMessage: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/api")>()),
  api: mockApi,
  getApi: () => mockApi,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

import { IssueDecisionBanner, MessageDecisionCard } from "./issue-decision-panel";

function renderBanner(count: number) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      <IssueDecisionBanner count={count} onOpen={vi.fn()} />
    </I18nProvider>,
  );
}

describe("IssueDecisionBanner", () => {
  it("keeps the same fixed-height element when the count changes", () => {
    const { rerender } = renderBanner(1);
    const first = document.querySelector("[data-issue-decision-banner]");
    expect(first).toHaveClass("h-10");
    expect(screen.getByText("Pending questions · 1")).toBeInTheDocument();

    rerender(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={27} onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-issue-decision-banner]")).toBe(first);
    expect(screen.getByText("Pending questions · 27")).toBeInTheDocument();
    expect(first).toHaveClass("h-10");
  });

  it("does not render when there is nothing waiting on a member", () => {
    renderBanner(0);
    expect(document.querySelector("[data-issue-decision-banner]")).toBeNull();
  });

  it("keeps owner decisions accessible without counting them as waiting on a member", () => {
    render(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={0} showOwnerOnly onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Questions and history" })).toHaveClass("h-10");
    expect(screen.queryByText(/Waiting for your decision/)).not.toBeInTheDocument();
  });

  it("opens from the whole banner button", () => {
    const onOpen = vi.fn();
    render(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={2} onOpen={onOpen} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

const decision = messageFixture({ message_kind: "decision", body_md: "Merge after QA?", options: [{ label: "Merge", value: "approve" }] });
function mountPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApi.listIssueSessions.mockResolvedValue([{ id: "sess_1" }]);
  mockApi.listMessages.mockResolvedValue({ messages: [decision], next_cursor: null });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat, messages: enMessages } }}>
    <MessageDecisionCard message={decision} canAnswer getActorName={(_type, id) => id} />
  </I18nProvider></QueryClientProvider>);
}
describe("decision message replies", () => {
  it("posts historical decision replies with the option value and original reply_to_id", async () => {
    mockApi.listMessages.mockClear(); mockApi.sendMessage.mockResolvedValue({ message: {} }); mountPanel();
    expect(mockApi.listMessages).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("button", { name: "Resolved" });
    expect(mockApi.sendMessage).toHaveBeenCalledWith("sess_1", expect.objectContaining({
      message_kind: "reply", reply_to_id: "msg_1", metadata: { selected_options: ["approve"] },
    }));
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });
  it("shows a duplicate-answer conflict without marking the reply successful", async () => {
    mockApi.sendMessage.mockRejectedValue(new Error("Decision is settled")); mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Decision is settled");
    expect(screen.getByRole("button", { name: "Merge" })).toHaveAttribute("aria-pressed", "true");
  });
});
