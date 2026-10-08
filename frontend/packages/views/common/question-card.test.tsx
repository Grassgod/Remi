import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { QuestionView } from "@multiremi/core/api/schemas";
import enIssues from "../locales/en/issues.json";
import enChat from "../locales/en/chat.json";
const mocks = vi.hoisted(() => ({ actOnQuestion: vi.fn(), getQuestion: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mocks }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, inboxItem: (id: string) => `/ws/inbox?item=${id}` }) }));
vi.mock("../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));
import { UnifiedQuestionCard } from "./question-card";
const base: QuestionView = { kind: "question", id: "q1", session_id: "original-session", workspace_id: "ws", source_issue_id: "child", source_agent_id: "worker", source_turn_id: null, source_attempt_id: null, original_questions: [], original_message: "Original exact question?", options: [{ label: "Approve", value: "approve" }], summary: { body_md: "Separate Remi recommendation", agent_id: "remi", at: "now" }, current_handler: { type: "agent", id: "parent-owner" }, stage: "parent_owner", route_revision: 7, answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null, history: [{ type: "created", actor: null, at: "now", route_revision: 1 }], actions: { allowed: ["answer", "escalate"] } };
function mount(question = base) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat } }}><UnifiedQuestionCard question={question} /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => { mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockResolvedValue(base); });
describe("one Q on every surface", () => {
  it("keeps permission choices single-select and sends the original option ID", async () => {
    mount({ ...base, kind: "permission", options: [{ label: "Allow once", value: "option-allow" }, { label: "Deny", value: "option-deny" }] });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("textbox", { name: "Answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ response: { option_id: "option-deny" }, expected_route_revision: 7 })));
  });
  it("closes the same business question explicitly with a reason and retained history", async () => {
    mount({ ...base, actions: { allowed: ["close"] } });
    expect(screen.getByRole("button", { name: "Close question" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason / review feedback" }), { target: { value: "No longer needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Close question" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "close", expect.objectContaining({ expected_route_revision: 7, reason: "No longer needed" })));
    expect(screen.getByRole("button", { name: /Transfer and answer history/ })).toBeInTheDocument();
  });
  it("separates original from summary and routes answers with the current revision", async () => {
    mount();
    expect(screen.getByText("Waiting for parent issue coordinator")).toBeInTheDocument();
    expect(screen.getByText("Original exact question?")).toBeInTheDocument();
    expect(screen.getByText("Separate Remi recommendation")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/ws/issues/child?comment=q1");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ expected_route_revision: 7, response: { selected_options: ["approve"] } })));
  });
  it("supports multi-question, multi-select, comma labels and custom answers with failure retention", async () => {
    mocks.actOnQuestion.mockRejectedValue(new Error("Stale route revision"));
    mount({ ...base, original_questions: [
      { fieldKey: "a", otherFieldKey: "a-other", question: { question: "Which?", options: [{ label: "A, B", description: "combined" }, { label: "C", description: "single" }], multiSelect: true } },
      { fieldKey: "b", otherFieldKey: "b-other", question: { question: "Why?", options: [], multiSelect: false } },
    ] });
    fireEvent.click(screen.getByRole("button", { name: "A, B" }));
    fireEvent.click(screen.getByRole("button", { name: "C" }));
    expect(screen.getByRole("button", { name: "A, B" })).toHaveAttribute("aria-pressed", "true");
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "Custom pick" } });
    fireEvent.change(inputs[1]!, { target: { value: "Because evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ response: { answers: { "Which?": "Custom pick", "Why?": "Because evidence" } } })));
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Stale route revision");
    expect(inputs[0]).toHaveValue("Custom pick");
  });
  it("keeps answered history and detached call state visible without claiming recovery", () => {
    mount({ ...base, status: "answered", wait_status: "detached", wait_reason: "Timed out", answer: { response: { answer: "Parent answer" }, body_md: "Parent answer", actor: { type: "agent", id: "parent-owner" }, at: "now", reply_message_id: "reply1" }, actions: { allowed: [] } });
    expect(screen.getByText("Answer saved")).toBeInTheDocument();
    expect(screen.getByText(/Original call ended; answer remains available/)).toBeInTheDocument();
    expect(screen.getByText("Parent answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Transfer and answer history/ }));
    expect(screen.getByText(/created/)).toBeInTheDocument();
  });
  it("requires an explicit reason and answer revision when the human revises", async () => {
    mount({ ...base, status: "answered", answer_revision: 2, actions: { allowed: ["revise"] } });
    fireEvent.click(screen.getByRole("button", { name: "Revise answer" }));
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason / review feedback" }), { target: { value: "Correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ revise: true, expected_route_revision: 7, expected_answer_revision: 2, reason: "Correction" })));
  });
  it("renders SDK direct AUQ payloads with multi-select and free answers", async () => {
    const original = [{ question: "Which SDK options?", options: [{ label: "One" }, { label: "Two" }], multiSelect: true }, { question: "SDK reason?", options: [] }];
    mount({ ...base, original_questions: original });
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "Custom SDK choice" } });
    fireEvent.change(inputs[1]!, { target: { value: "SDK evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ response: { answers: { "Which SDK options?": "Custom SDK choice", "SDK reason?": "SDK evidence" } } })));
    expect(original[0]).not.toHaveProperty("fieldKey");
  });
});
