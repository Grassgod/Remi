import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { messageFixture } from "../../test/messages";
import enMessages from "../../locales/en/messages.json";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

const mockApi = vi.hoisted(() => ({
  listIssueSessions: vi.fn(), listMessages: vi.fn(), sendMessage: vi.fn(), getQuestion: vi.fn(), listIssueQuestions: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/api")>()),
  api: mockApi,
  getApi: () => mockApi,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../common/question-card", () => ({ UnifiedQuestionCard: ({ question }: { question: { original_message: string; route_revision: number; wait_status: string } }) => <div>{question.original_message} · revision {question.route_revision} · {question.wait_status}</div> }));

import { IssueDecisionBanner, IssueDecisionPanel, MessageDecisionCard } from "./issue-decision-panel";

function renderBanner(count: number) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      <IssueDecisionBanner count={count} onOpen={vi.fn()} />
    </I18nProvider>,
  );
}

describe("IssueDecisionBanner", () => {
  it("loads runtime questions only inside the existing right-side decision panel", async () => {
    mockApi.listIssueQuestions.mockClear(); mockApi.listIssueSessions.mockClear(); mockApi.listMessages.mockClear();
    mockApi.listIssueQuestions.mockResolvedValue([
      { id: "native", status: "pending", original_message: "Runtime question", route_revision: 2, wait_status: "waiting" },
      { id: "answered", status: "answered", original_message: "Previous question", route_revision: 1, wait_status: "consumed" },
      { id: "closed", status: "closed", original_message: "Cancelled question", route_revision: 1, wait_status: "detached" },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      <IssueDecisionPanel issueId="issue-runtime" pendingCount={1} canAnswer getActorName={(_type, id) => id} />
    </I18nProvider></QueryClientProvider>);
    expect(mockApi.listIssueQuestions).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pending questions · 1" }));
    expect(await screen.findByText("Runtime question · revision 2 · waiting")).toBeInTheDocument();
    const pending = screen.getByRole("region", { name: "Awaiting answers" });
    const history = screen.getByRole("region", { name: "Answered and closed" });
    expect(within(pending).getByText("Runtime question · revision 2 · waiting")).toBeInTheDocument();
    expect(within(history).getByText("Previous question · revision 1 · consumed")).toBeInTheDocument();
    expect(within(history).getByText("Cancelled question · revision 1 · detached")).toBeInTheDocument();
    expect(within(pending).queryByText(/Previous question|Cancelled question/)).toBeNull();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "right");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-issue-decision-overlay");
    expect(mockApi.listIssueQuestions).toHaveBeenCalledWith("issue-runtime");
    expect(mockApi.listIssueSessions).not.toHaveBeenCalled();
    expect(mockApi.listMessages).not.toHaveBeenCalled();
  });
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
function mountPanel(message = decision) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApi.listIssueSessions.mockResolvedValue([{ id: "sess_1" }]);
  mockApi.listMessages.mockResolvedValue({ messages: [decision], next_cursor: null });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat, messages: enMessages } }}>
    <MessageDecisionCard message={message} canAnswer getActorName={(_type, id) => id} />
  </I18nProvider></QueryClientProvider>);
}
describe("decision message replies", () => {
  it.each(["human_request", "decision_record"])("reads historical %s through the original Q projection without the retired reply path", async metadataKey => {
    mockApi.sendMessage.mockClear(); mockApi.getQuestion.mockClear();
    mockApi.getQuestion.mockResolvedValue({ original_message: "Historical original question", route_revision: 9, wait_status: "detached" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const metadata = metadataKey === "decision_record"
      ? { decision_record: { status: "pending", issue_id: "iss_actual_source" } }
      : { human_request: { status: "pending" } };
    render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><MessageDecisionCard message={{ ...decision, metadata }} canAnswer /></I18nProvider></QueryClientProvider>);
    expect(await screen.findByText("Historical original question · revision 9 · detached")).toBeInTheDocument();
    expect(mockApi.getQuestion).toHaveBeenCalledWith(decision.id);
    expect(mockApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });
  it.each([{}, { decision_record: { status: "pending" } }, { message_choice: { status: "pending" } }])("posts an ordinary choice exactly once with its original option and reply reference (%j)", async metadata => {
    mockApi.listMessages.mockClear(); mockApi.getQuestion.mockClear(); mockApi.sendMessage.mockClear();
    mockApi.sendMessage.mockResolvedValue({ message: {} }); mountPanel({ ...decision, metadata });
    expect(mockApi.listMessages).not.toHaveBeenCalled();
    expect(screen.getByText("Merge after QA?")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("button", { name: "Resolved" });
    expect(mockApi.sendMessage).toHaveBeenCalledWith("sess_1", expect.objectContaining({
      body_md: "Merge", message_kind: "reply", reply_to_id: "msg_1", metadata: { selected_options: ["approve"] },
    }));
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.getQuestion).not.toHaveBeenCalled();
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
