import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { QuestionView } from "@multiremi/core/api/schemas";
import enIssues from "../locales/en/issues.json";
import enChat from "../locales/en/chat.json";
const mocks = vi.hoisted(() => ({ actOnQuestion: vi.fn(), getQuestion: vi.fn(), getTask: vi.fn(), getIssue: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mocks }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, squadDetail: (id: string) => `/ws/squads/${id}`, inboxItem: (id: string) => `/ws/inbox?item=${id}` }) }));
vi.mock("../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));
vi.mock("./task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task }: { task: { id: string } }) => <div role="dialog">{task.id}</div> }));
import { ApiError } from "@multiremi/core/api/client";
import { UnifiedQuestionCard } from "./question-card";
const base: QuestionView = { kind: "question", id: "q1", session_id: "original-session", workspace_id: "ws", source_issue_id: "child", source_agent_id: "worker", source_turn_id: null, source_attempt_id: null, original_questions: [], original_message: "Original exact question?", options: [{ label: "Approve", value: "approve" }], summary: { body_md: "Separate Remi recommendation", agent_id: "remi", at: "now" }, current_handler: { type: "agent", id: "parent-owner" }, stage: "parent_owner", route_revision: 7, answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null, history: [{ type: "created", actor: null, at: "now", route_revision: 1 }], actions: { allowed: ["answer", "escalate"] } };
// What a workspace member sees once the Q reached the Issue human stage: nobody is named.
const human: QuestionView = { ...base, current_handler: null, stage: "human", route_reason: null, actions: { allowed: ["answer", "close"] } };
const names: Record<string, string> = { "parent-owner": "Lead", worker: "Worker", "member-1": "Member One" };
function mount(question = base, getActorName?: (type: string, id: string) => string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat } }}><UnifiedQuestionCard question={question} getActorName={getActorName} /></I18nProvider></QueryClientProvider>);
}
const tag = (view: ReturnType<typeof mount>) => view.container.querySelector("[data-question-tag]");
beforeEach(() => {
  mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockResolvedValue(base); mocks.getTask.mockReset();
  mocks.getIssue.mockReset(); mocks.getIssue.mockRejectedValue(new Error("not loaded"));
});
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
  it("keeps management inputs out of native answers and retains a draft after cancelling a secondary action", async () => {
    mount({ ...human, original_message: "Continue?", original_questions: [
      { question: "Continue?", options: [{ label: "Continue" }, { label: "Stop" }] },
    ] });
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
    expect(screen.queryByText("Original call is waiting")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
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
  it("links a system re-route notification in its receiving session instead of the child issue timeline", () => {
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
  it("requires an explicit reason and answer revision when a member revises", async () => {
    mount({ ...human, status: "answered", answer_revision: 2, actions: { allowed: ["revise"] } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revise answer" }));
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for revising" }), { target: { value: "Correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ revise: true, expected_route_revision: 7, expected_answer_revision: 2, reason: "Correction" })));
  });
  it("submits once more after a stale revision re-routed the Q when this member may still answer it", async () => {
    // The first answer after an upgrade re-routes the stored Q in its own commit, then reports the old revision.
    const conflict = (code: string) => new ApiError(code, 409, "Conflict", { error: code, code });
    mocks.actOnQuestion.mockReset();
    mocks.actOnQuestion.mockRejectedValueOnce(conflict("question_route_changed")).mockResolvedValueOnce({ ...human, status: "answered", route_revision: 8, actions: { allowed: ["revise"] } });
    mocks.getQuestion.mockReset(); mocks.getQuestion.mockResolvedValue({ ...human, route_revision: 8 });
    mount(human);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledTimes(2));
    expect(mocks.actOnQuestion.mock.calls.map(([, action, body]) => [action, body.expected_route_revision, body.response])).toEqual([
      ["answer", 7, { selected_options: ["approve"] }], ["answer", 8, { selected_options: ["approve"] }]]);
    expect(screen.queryByText(/question_route_changed|re-routed/)).toBeNull();
  });
  it("explains a re-route or another answer in words instead of the server code, and never re-submits blindly", async () => {
    const conflict = (code: string) => new ApiError(code, 409, "Conflict", { error: code, code });
    mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockRejectedValue(conflict("question_route_changed"));
    // The re-route handed the Q to an Agent: this member may only read it now.
    mocks.getQuestion.mockReset(); mocks.getQuestion.mockResolvedValue({ ...base, route_revision: 8, actions: { allowed: [] } });
    const native = { ...human, original_message: "Continue?", original_questions: [{ question: "Continue?", options: [{ label: "Continue" }, { label: "Stop" }] }] };
    const view = mount(native);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(enIssues.responsibility.conflicts.route_changed)).toBeInTheDocument();
    expect(mocks.actOnQuestion).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).not.toContain("question_route_changed");
    view.unmount();
    mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockRejectedValue(conflict("question_already_settled"));
    mocks.getQuestion.mockReset();
    mount(human);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(await screen.findByText(enIssues.responsibility.conflicts.already_settled)).toBeInTheDocument();
    expect(mocks.getQuestion).not.toHaveBeenCalled();
  });
  it("names another member's answer when the re-read after a re-route finds the Q settled", async () => {
    const conflict = new ApiError("question_route_changed", 409, "Conflict", { error: "question_route_changed", code: "question_route_changed" });
    mocks.actOnQuestion.mockReset(); mocks.actOnQuestion.mockRejectedValue(conflict);
    mocks.getQuestion.mockReset(); mocks.getQuestion.mockResolvedValue({ ...human, status: "answered", route_revision: 8, answer_revision: 1, actions: { allowed: ["revise"] } });
    mount(human);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(await screen.findByText(enIssues.responsibility.conflicts.already_settled)).toBeInTheDocument();
    expect(mocks.actOnQuestion).toHaveBeenCalledTimes(1);
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

describe("who a Q waits on", () => {
  it("labels an Issue human-stage Q as awaiting an answer, names nobody and lets any member answer", async () => {
    const view = mount(human, (_type, id) => names[id] ?? id);
    expect(tag(view)).toHaveTextContent("Awaiting answer");
    expect(tag(view)).toHaveAttribute("data-question-tag", "human");
    expect(screen.getByText("Asked by Worker")).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect(screen.queryByText(enIssues.responsibility.agent_readonly)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History and details/ }));
    expect(screen.queryByText(/Current handler/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "answer", expect.objectContaining({ expected_route_revision: 7, response: { selected_options: ["approve"] } })));
  });
  it("shows an Agent-held Q read-only to a member, with the Agent it waits on", () => {
    const view = mount({ ...base, actions: { allowed: [] } }, (_type, id) => names[id] ?? id);
    expect(tag(view)).toHaveTextContent("Waiting for Lead");
    expect(tag(view)).toHaveAttribute("data-question-tag", "agent");
    expect(screen.getByText(enIssues.responsibility.agent_readonly)).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
  it("lets the Agent that holds the Q answer it or escalate it to the next owner", async () => {
    const view = mount(base, (_type, id) => names[id] ?? id);
    expect(tag(view)).toHaveTextContent("Waiting for Lead");
    expect(screen.queryByText(enIssues.responsibility.agent_readonly)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Escalate to next owner" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Needs a member" } });
    fireEvent.click(screen.getByRole("button", { name: "Escalate to next owner" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "escalate", expect.objectContaining({ expected_route_revision: 7, reason: "Needs a member" })));
  });
  it("labels a Chat Q for its own member as awaiting an answer and as waiting on that member for anyone else", () => {
    const chat: QuestionView = { ...base, source_issue_id: null, current_handler: { type: "member", id: "member-1" }, stage: "human" };
    const own = mount(chat, (_type, id) => names[id] ?? id);
    expect(tag(own)).toHaveTextContent("Awaiting answer");
    own.unmount();
    const other = mount({ ...chat, actions: { allowed: [] } }, (_type, id) => names[id] ?? id);
    expect(tag(other)).toHaveTextContent("Waiting for Member One");
  });
  it.each([
    [{ status: "answered" }, "Answered", "answered"],
    [{ status: "closed" }, "Closed", "muted"],
    [{ stage: "unavailable", current_handler: null }, "Cannot be handled now", "muted"],
  ] as const)("labels %j as %s", (patch, label, tone) => {
    const view = mount({ ...human, actions: { allowed: [] }, ...patch });
    expect(tag(view)).toHaveTextContent(label);
    expect(tag(view)).toHaveAttribute("data-question-tag", tone);
  });
  it("never offers a transfer, even when an older server still lists it", async () => {
    mount({ ...base, actions: { allowed: ["answer", "escalate", "transfer", "close"] } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menuitem", { name: "Escalate to next owner" });
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Escalate to next owner", "Close question"]);
  });
  it("offers revision only for answers the server lets this member revise", () => {
    const answer = { response: { answer: "Lead answer" }, body_md: "Lead answer", actor: { type: "agent", id: "parent-owner" }, at: "now", reply_message_id: "reply" };
    // An Agent-stage answer stays the Agent's; a member sees it but cannot revise it.
    mount({ ...base, status: "answered", answer, actions: { allowed: [] } }, (_type, id) => names[id] ?? id);
    expect(screen.getByText("Lead answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
  it("authorizes continuation of a detached answer when the server allows it", async () => {
    const answer = { response: { answer: "Lead answer" }, body_md: "Lead answer", actor: { type: "agent", id: "parent-owner" }, at: "now", reply_message_id: "reply" };
    mount({ ...base, status: "answered", wait_status: "detached", answer, actions: { allowed: ["continue"] } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize continuation" }));
    await waitFor(() => expect(mocks.actOnQuestion).toHaveBeenCalledWith("q1", "continue", expect.objectContaining({ expected_route_revision: 7 })));
  });
});

describe("why a Q reached members early", () => {
  const note = (view: ReturnType<typeof mount>) => view.container.querySelector("[data-question-route-note]");
  it("explains a missing upper Leader and links to that team", async () => {
    mocks.getIssue.mockResolvedValue({ id: "parent", identifier: "MUL-1", assignee_type: "squad", assignee_id: "squad-1" });
    mount({ ...human, route_reason: "parent:leader_missing" });
    expect(await screen.findByText("On the upper issue MUL-1, no Leader is available, so the question came here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure" })).toHaveAttribute("href", "/ws/squads/squad-1");
    expect(mocks.getIssue).toHaveBeenCalledWith("parent");
  });
  it("explains this issue's missing execution owner and links to the issue", async () => {
    mount({ ...human, original_questions: [{ question: "Continue?", options: [{ label: "Continue" }] }], route_reason: "child:execution_owner_missing" });
    expect(await screen.findByText("On this issue, no execution owner is assigned, so the question came here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure" })).toHaveAttribute("href", "/ws/issues/child");
  });
  it("reads structural failures as one broken parent chain per issue, before the upper issue loads", () => {
    const view = mount({ ...human, route_reason: "parent:parent_missing,parent:parent_cycle" });
    expect(view.container.querySelectorAll("[data-question-route-note]")).toHaveLength(1);
    expect(note(view)).toHaveTextContent("On an upper issue, the parent chain is broken, so the question came here");
    expect(screen.getByRole("link", { name: "Configure" })).toHaveAttribute("href", "/ws/issues/parent");
  });
  it.each([
    ["a frozen source", { route_reason: "source_workspace_changed" }],
    ["an older free-form reason", { route_reason: "upper_responsibility_unavailable" }],
    ["an Agent-stage Q", { stage: "parent_owner", current_handler: { type: "agent", id: "parent-owner" }, route_reason: "parent:leader_missing" }],
  ] as const)("adds no route note for %s", (_label, patch) => {
    const view = mount({ ...human, ...patch });
    expect(note(view)).toBeNull();
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });
});
