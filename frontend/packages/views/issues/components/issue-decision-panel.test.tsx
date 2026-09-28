import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MultiremiIssueDecisionEntry, MultiremiIssueDecisionList } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

const mockApi = vi.hoisted(() => ({
  listIssueDecisions: vi.fn(),
  answerIssueDecision: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/api")>()),
  api: mockApi,
  getApi: () => mockApi,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

import { IssueDecisionBanner, IssueDecisionPanel } from "./issue-decision-panel";

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
    expect(screen.getByText("Waiting for your decision · 1")).toBeInTheDocument();

    rerender(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueDecisionBanner count={27} onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-issue-decision-banner]")).toBe(first);
    expect(screen.getByText("Waiting for your decision · 27")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Owner decisions" })).toHaveClass("h-10");
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

const baseEntry: MultiremiIssueDecisionEntry = {
  id: "decision-1",
  bucket: "waiting_on_human",
  type: "decision",
  kind: "merge",
  title: "Merge after QA?",
  body: "Choose whether this change can merge.",
  status: "escalated",
  issueId: "issue-1",
  sourceIssueId: "child-1",
  sourceTaskId: "task-1",
  options: ["Wait", "Merge"],
  answer: null,
  history: [],
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

const decisionList: MultiremiIssueDecisionList = {
  waiting_on_human: [baseEntry, {
    ...baseEntry,
    id: "request-1",
    type: "human_request",
    kind: "question",
    title: "Choose a window",
    body: "Choose a window",
    options: null,
    history: undefined,
    payload: {
      message: "Choose a window",
      questions: [{
        fieldKey: "window",
        question: {
          question: "When should this run?",
          options: [{ label: "Tonight" }, { label: "Tomorrow" }],
          multiSelect: false,
        },
      }],
    },
  }],
  owner_and_answered: {
    pending: [{ ...baseEntry, id: "decision-2", bucket: "pending_owner", title: "Owner pending" }],
    answered: [{
      ...baseEntry,
      id: "decision-3",
      bucket: "answered",
      title: "Owner answered",
      status: "answered",
      answer: {
        answererType: "agent",
        answererId: "agent-1",
        answer: "Merge",
        reason: "Checks passed",
        overturn: "Reopen if CI regresses",
        answeredAt: "2026-09-28T01:00:00.000Z",
      },
      history: [{
        answererType: "agent",
        answererId: "agent-1",
        answer: "Merge",
        reason: "Checks passed",
        overturn: "Reopen if CI regresses",
        answeredAt: "2026-09-28T01:00:00.000Z",
      }],
    }],
  },
  count: 2,
};

function renderPanel(canAnswer: boolean) {
  mockApi.listIssueDecisions.mockResolvedValue(decisionList);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat } }}>
        <IssueDecisionPanel
          issueId="issue-1"
          pendingCount={2}
          canAnswer={canAnswer}
          getActorName={(_type, id) => id === "agent-1" ? "Owner Agent" : id}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("IssueDecisionPanel", () => {
  it("shows owner decisions and history without answer controls to an agent", async () => {
    renderPanel(false);
    fireEvent.click(screen.getByRole("button", { name: "Waiting for your decision · 2" }));

    expect(await screen.findByText("Owner decisions")).toBeInTheDocument();
    expect(screen.getByText("Owner Agent")).toBeInTheDocument();
    expect(screen.getByText("Reopen if CI regresses")).toBeInTheDocument();
    expect(screen.getByText("Tonight")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tonight" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Answer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change answer" })).not.toBeInTheDocument();
  });

  it("offers answer and re-answer controls to a member", async () => {
    renderPanel(true);
    fireEvent.click(screen.getByRole("button", { name: "Waiting for your decision · 2" }));

    expect(await screen.findByRole("button", { name: "Change answer" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Answer" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Tonight" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tonight" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    const waitOption = screen.getAllByRole("button", { name: "Wait" })[0]!;
    expect(waitOption).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(waitOption);
    expect(waitOption).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores a malformed human-request payload without crashing the overlay", async () => {
    mockApi.listIssueDecisions.mockResolvedValue({
      ...decisionList,
      waiting_on_human: [{
        ...baseEntry,
        id: "request-broken",
        type: "human_request",
        kind: "permission",
        payload: { options: "not-an-array" },
      }],
      count: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat } }}>
          <IssueDecisionPanel
            issueId="issue-1"
            pendingCount={1}
            canAnswer
            getActorName={(_type, id) => id}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Waiting for your decision · 1" }));
    expect(await screen.findByText("Owner decisions")).toBeInTheDocument();
    expect(screen.queryByText("request-broken")).not.toBeInTheDocument();
  });
});
