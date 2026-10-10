import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { QuestionView } from "@multiremi/core/api/schemas";
import enIssues from "../locales/en/issues.json";
import enChat from "../locales/en/chat.json";
const mocks = vi.hoisted(() => ({ actOnQuestion: vi.fn(), getQuestion: vi.fn(), getTask: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mocks }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, inboxItem: (id: string) => `/ws/inbox?item=${id}` }) }));
vi.mock("../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));
vi.mock("./task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task }: { task: { id: string } }) => <div role="dialog">{task.id}</div> }));
import { UnifiedQuestionCard } from "./question-card";
const base: QuestionView = { kind: "question", id: "q1", session_id: "original-session", workspace_id: "ws", source_issue_id: "child", source_agent_id: "worker", source_turn_id: null, source_attempt_id: null, original_questions: [], original_message: "Original exact question?", options: [{ label: "Approve", value: "approve" }], summary: { body_md: "Separate Remi recommendation", agent_id: "remi", at: "now" }, current_handler: { type: "agent", id: "parent-owner" }, stage: "parent_owner", route_revision: 7, answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null, history: [{ type: "created", actor: null, at: "now", route_revision: 1 }], actions: { allowed: ["answer", "escalate"] } };
function mount(question = base) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat } }}><UnifiedQuestionCard question={question} /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => { mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockResolvedValue(base); mocks.getTask.mockReset(); });
describe("one Q on every surface", () => {
  it("shows all answer versions and their authors without repeating the current answer", () => {
    const first = { response: { answer: "First answer" }, body_md: "First answer", actor: { type: "agent", id: "coordinator" }, at: "first", reply_message_id: "reply-first" };
    const current = { response: { answers: { "Continue?": "Revised answer" } }, body_md: '{"answers":{"Continue?":"Revised answer"}}', actor: { type: "member", id: "human" }, at: "second", reply_message_id: "reply-second" };
    mount({ ...base, status: "answered", answer: current, actions: { allowed: ["revise"] }, history: [
      { type: "answer", at: "first", actor: first.actor, route_revision: 1, answer: first },
      { type: "revise", at: "second", actor: current.actor, route_revision: 1, answer: current, reason: "New evidence", overturn: "Use the revised answer" },
    ] });
    expect(screen.getAllByText("First answer")).toHaveLength(1);
    expect(screen.getAllByText("Revised answer")).toHaveLength(1);
    expect(screen.getByText("coordinator")).toBeInTheDocument();
    expect(screen.getByText("human")).toBeInTheDocument();
    expect(screen.getByText(/New evidence/)).toBeInTheDocument();
    expect(screen.getByText(/Use the revised answer/)).toBeInTheDocument();
    expect(screen.queryByText("Route revision 7")).toBeNull();
  });
  it("answers native user questions without a designated handler and retains a draft after cancelling a secondary action", async () => {
    mount({ ...base, current_handler: null, stage: "human", original_message: "Continue?", original_questions: [
      { question: "Continue?", options: [{ label: "Continue" }, { label: "Stop" }] },
    ], actions: { allowed: ["answer", "transfer", "close"] } });
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
    expect(screen.queryByText("Original call is waiting")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Refresh responsible handler" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close question" }));
    expect(screen.getByRole("button", { name: "Close question" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({
      expected_route_revision: 7, response: { answers: { "Continue?": "Continue" } }, reason: "",
    })));
  });
  it("shows the settled native question once with a readable answer and no stale choices", () => {
    const response = { answers: { "Continue this task?": "Continue" } };
    const view = mount({ ...base, original_message: "Continue this task?\n\nContinue this task?", original_questions: [
      { question: "Continue this task?", header: "Next step", options: [{ label: "Continue" }, { label: "Stop" }] },
    ], status: "answered", wait_status: "consumed", actions: { allowed: ["revise"] }, answer: {
      response, body_md: JSON.stringify(response), actor: { type: "member", id: "reviewer" }, at: "now", reply_message_id: "reply",
    } });
    expect(screen.getAllByText("Continue this task?")).toHaveLength(1);
    expect(screen.getByText("Answered · execution resumed")).toBeInTheDocument();
    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(screen.queryByText("Stop")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(view.container.textContent).not.toContain('"answers"');
    expect(view.container.querySelectorAll("article")).toHaveLength(1);
    expect(screen.queryByText("Route revision 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByText("Route revision 7")).toBeInTheDocument();
  });
  it("shows ordinary historical source delivery and its actual surface without claiming native consumption", () => {
    mount({ ...base, status: "answered", wait_status: "none", actions: { allowed: [] }, history: [{ type: "notify", actor: { type: "member", id: "human" }, at: "now", route_revision: 7, reason: "historical_source_dispatch_failed:runtime_workspace_error", source_message_id: "readable-source-result", source_session_id: "source-session" }] });
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByText(/Result delivery to original source/)).toBeInTheDocument();
    expect(screen.getByText("historical_source_dispatch_failed:runtime_workspace_error")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source · readable-source-result" })).toHaveAttribute("href", "/ws/inbox?item=q1&question=q1&question_source=readable-source-result");
    expect(screen.getByText("Historical question; no original waiting call")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmed consumption attempt/ })).toBeNull();
  });
  it("retains original permission background separately from Remi advice", () => {
    mount({ ...base, kind: "permission", original_context: { text: "The exact operation requiring authorization", truncated: true } });
    expect(screen.getByText("The exact operation requiring authorization")).toBeInTheDocument();
    expect(screen.getByText("Separate Remi recommendation")).toBeInTheDocument();
    expect(screen.getByText(enChat.human_requests.context_truncated)).toBeInTheDocument();
  });
  it("links a transfer notification in its receiving session instead of the child issue timeline", () => {
    mount({ ...base, history: [{ type: "transfer", actor: null, at: "now", route_revision: 7, source_message_id: "parent-notification", source_session_id: "parent-session" }] });
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByRole("link", { name: "Source · parent-notification" })).toHaveAttribute("href", "/ws/inbox?item=q1&question=q1&question_source=parent-notification");
  });
  it("reads only the confirmed consumer attempt lazily and opens its actual execution", async () => {
    mocks.getTask.mockResolvedValue({ id: "consumer-attempt", turn_id: "consumer-turn", agent_id: "worker" });
    mount({ ...base, wait_status: "continuation_consumed", recovery: { consumer_turn_id: "consumer-turn", consumer_attempt_id: "consumer-attempt", reply_message_id: "reply", continuation_message_id: "continuation", consumed_at: "then" } });
    expect(mocks.getTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmed consumption attempt/ }));
    await waitFor(() => expect(mocks.getTask).toHaveBeenCalledWith("consumer-attempt", "consumer-turn"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("consumer-attempt");
  });
  it("links authorized continuation without inventing a consumed attempt before confirmation", () => {
    mount({ ...base, wait_status: "continuation_pending", recovery: { consumer_turn_id: "turn-new", consumer_attempt_id: null, reply_message_id: "reply", continuation_message_id: "continue-message", consumed_at: null } });
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByRole("link", { name: "Continuation instruction" })).toHaveAttribute("href", "/ws/inbox?item=q1&question=q1&question_source=continue-message");
    expect(screen.getByRole("link", { name: "Continuation instruction" })).toHaveAttribute("title", "continue-message");
    expect(screen.getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/ws/inbox?item=q1&question=q1&question_source=reply");
    expect(screen.getByText("Consuming turn · turn-new")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmed consumption attempt/ })).toBeNull();
    expect(screen.getByText("Continuation authorized; awaiting consumption")).toBeInTheDocument();
  });
  it("preserves historical answer, reason and overturn guidance without exposing raw response metadata", () => {
    mount({ ...base, actions: { allowed: [] }, history: [{ type: "answer", actor: { type: "agent", id: "parent-owner" }, at: "then", route_revision: 1, reason: "Checks passed", overturn: "Reconsider if QA finds regression", answer: { body_md: "Original parent reply", response: { internal_shape: "provider-field" } } }] });
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByText("Original parent reply")).toBeInTheDocument(); expect(screen.getByText("Checks passed")).toBeInTheDocument(); expect(screen.getByText("Reconsider if QA finds regression")).toBeInTheDocument();
    expect(screen.queryByText(/internal_shape/)).toBeNull();
  });
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
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close question" }));
    expect(screen.getByRole("button", { name: "Close question" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "No longer needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Close question" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "close", expect.objectContaining({ expected_route_revision: 7, reason: "No longer needed" })));
    expect(screen.getByRole("button", { name: /History and details/ })).toBeInTheDocument();
  });
  it("separates original from summary and routes answers with the current revision", async () => {
    mount();
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
    expect(screen.getByText("Original exact question?")).toBeInTheDocument();
    expect(screen.getByText("Separate Remi recommendation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByRole("link")).toHaveAttribute("href", "/ws/inbox?item=q1&question=q1");
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
    expect(screen.getByText("Answer saved · execution needs recovery")).toBeInTheDocument();
    expect(screen.queryByText(/Original call ended; answer remains available/)).toBeNull();
    expect(screen.getByText("Parent answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.getByText(/created/)).toBeInTheDocument();
    expect(screen.getByText(/Original call ended; answer remains available/)).toBeInTheDocument();
  });
  it("requires an explicit reason and answer revision when the human revises", async () => {
    mount({ ...base, status: "answered", answer_revision: 2, actions: { allowed: ["revise"] } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revise answer" }));
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for revising" }), { target: { value: "Correction" } });
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
