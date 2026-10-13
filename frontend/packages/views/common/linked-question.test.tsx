import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { QuestionView } from "@multiremi/core/api/schemas";
import enIssues from "../locales/en/issues.json";
import enChat from "../locales/en/chat.json";
import enCommon from "../locales/en/common.json";
import zhIssues from "../locales/zh-Hans/issues.json";
const mocks = vi.hoisted(() => ({ getQuestion: vi.fn(), actOnQuestion: vi.fn(), getIssue: vi.fn(), getTask: vi.fn() }));
vi.mock("@multiremi/core/api", async importOriginal => ({ ApiError: (await importOriginal<typeof import("@multiremi/core/api")>()).ApiError, api: mocks }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, squadDetail: (id: string) => `/ws/squads/${id}`, inboxItem: (id: string) => `/ws/inbox?item=${id}` }) }));
vi.mock("../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));
import { ApiError } from "@multiremi/core/api";
import { isMemberQuestionReminder, isOthersQuestionReminder, isRedundantQuestionReminder, LinkedQuestion, linkedQuestionId, QuestionSummaryLine } from "./linked-question";

const names: Record<string, string> = { worker: "Worker", lead: "Lead", "member-1": "Member One" };
const getActorName = (_type: string, id: string) => names[id] ?? id;
const question: QuestionView = { kind: "question", id: "q1", session_id: "session", workspace_id: "ws", source_issue_id: "issue", source_agent_id: "worker", source_turn_id: null, source_attempt_id: null,
  original_questions: [{ question: "Retire the v1 endpoint now?\nIt still serves two clients.", options: [{ label: "Retire" }, { label: "Keep" }] }], original_message: "Retire the v1 endpoint now?", options: null, summary: null,
  current_handler: null, stage: "human", route_revision: 2, route_reason: null, answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null,
  history: [{ type: "created", at: "2026-10-01T00:00:00Z", actor: { type: "agent", id: "worker" }, route_revision: 1 }], actions: { allowed: ["answer", "close"] } };
const answered: Partial<QuestionView> = { status: "answered", wait_status: "consumed", actions: { allowed: ["revise"] },
  answer: { response: { answers: { "Retire the v1 endpoint now?": "Retire" } }, body_md: "", actor: { type: "member", id: "member-1" }, at: "now", reply_message_id: "reply" } };
const agentHeld: Partial<QuestionView> = { stage: "parent_owner", current_handler: { type: "agent", id: "lead" }, actions: { allowed: [] } };

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat, common: enCommon } }}>{children}</I18nProvider></QueryClientProvider>);
}
const summary = (view: ReturnType<typeof wrap>) => view.container.querySelector<HTMLElement>("[data-question-summary]")!;

beforeEach(() => {
  mocks.getQuestion.mockReset(); mocks.actOnQuestion.mockReset();
  mocks.getIssue.mockReset(); mocks.getIssue.mockRejectedValue(new Error("not loaded"));
});

describe("question references on message surfaces", () => {
  it("uses the original Q for explicit route and presentation notifications", () => {
    expect(linkedQuestionId("notification", { root_question_id: "original", question_notification: true })).toBe("original");
    expect(linkedQuestionId("presentation", { root_question_id: "original", question_present_request: true })).toBe("original");
  });
  it("leaves answer, revision and status bodies visible without duplicating the original Q", () => {
    expect(linkedQuestionId("answer", { root_question_id: "original", human_response: { answers: { question: "Continue" } }, question_route_revision: 1 })).toBeNull();
    expect(linkedQuestionId("revision", { root_question_id: "original", question_answer_revision: true })).toBeNull();
    expect(linkedQuestionId("status", { root_question_id: "original", question_closed: true })).toBeNull();
  });
  it.each(["question", "human_request"])("recognizes retained %s records without migrating them", key => {
    const metadata = { [key]: { status: "pending" } };
    expect(linkedQuestionId("original", metadata)).toBe("original");
    expect(metadata).toEqual({ [key]: { status: "pending" } });
  });
  it.each(["issue_id", "source_issue_id"])("recognizes actual historical Issue questions by %s without migrating them", key => {
    const record = { status: "pending", [key]: "iss_source" };
    expect(linkedQuestionId("original", { decision_record: record })).toBe("original");
    expect(record).toEqual({ status: "pending", [key]: "iss_source" });
  });
  it.each([undefined, null, false, [], { status: "pending" }, { issue_id: "  " }, { source_issue_id: 42 }])("keeps ordinary or malformed decision state outside the Q projection (%j)", record => {
    expect(linkedQuestionId("ordinary", { decision_record: record })).toBeNull();
  });
  it("keeps new ordinary choices outside the Q projection", () => {
    expect(linkedQuestionId("ordinary", { message_choice: { status: "pending" } })).toBeNull();
  });
  it("leaves ordinary messages and unstructured decisions outside the Q projection", () => {
    expect(linkedQuestionId("ordinary", undefined)).toBeNull();
    expect(linkedQuestionId("ordinary", { kind: "decision" })).toBeNull();
  });
});

describe("human-stage reminders on timelines", () => {
  const reminder = (to: { to_type?: string | null; to_member_id?: string | null; to_ref?: string | null }) => ({ metadata: { question_notification: true, root_question_id: "q1" }, ...to });
  it("recognizes only reminders addressed to one member", () => {
    expect(isMemberQuestionReminder(reminder({ to_type: "member", to_member_id: "member-1" }))).toBe(true);
    expect(isMemberQuestionReminder(reminder({ to_type: "agent", to_ref: "lead" }))).toBe(false);
    expect(isMemberQuestionReminder(reminder({}))).toBe(false);
    expect(isMemberQuestionReminder({ metadata: { question_present_request: true, root_question_id: "q1" }, to_type: "member" })).toBe(false);
  });
  it("hides the reminders other members received and keeps the reader's own", () => {
    expect(isOthersQuestionReminder(reminder({ to_type: "member", to_member_id: "member-1" }), "member-1")).toBe(false);
    expect(isOthersQuestionReminder(reminder({ to_type: "member", to_ref: "member-1" }), "member-1")).toBe(false);
    expect(isOthersQuestionReminder(reminder({ to_type: "member", to_member_id: "member-2" }), "member-1")).toBe(true);
    expect(isOthersQuestionReminder(reminder({ to_type: "member", to_member_id: "member-1" }), null)).toBe(true);
    // Agent notifications and the original Q row stay; the timeline renders them once.
    expect(isOthersQuestionReminder(reminder({ to_type: "agent", to_ref: "lead" }), "member-1")).toBe(false);
    expect(isOthersQuestionReminder({ metadata: { question: { status: "pending" } }, to_type: "member", to_member_id: "member-2" }, "member-1")).toBe(false);
  });
  it("also hides the reader's own reminder when the original Q row is in the same session", () => {
    const own = (metadata: Record<string, unknown>) => ({ metadata: { question_notification: true, root_question_id: "q1", ...metadata }, to_type: "member", to_member_id: "member-1" });
    expect(isRedundantQuestionReminder(own({ source_question_session_id: "main" }), "member-1", "main", new Set())).toBe(true);
    expect(isRedundantQuestionReminder(own({ source_question_session_id: "side" }), "member-1", "main", new Set())).toBe(false);
    // A recovery notice without its source session falls back to the loaded rows.
    expect(isRedundantQuestionReminder(own({}), "member-1", "main", new Set(["q1"]))).toBe(true);
    expect(isRedundantQuestionReminder(own({}), "member-1", "main", new Set())).toBe(false);
    expect(isRedundantQuestionReminder(own({ source_question_session_id: "side" }), "member-2", "main", new Set())).toBe(true);
    expect(isRedundantQuestionReminder({ metadata: { question_notification: true, root_question_id: "q1", source_question_session_id: "main" }, to_type: "agent", to_ref: "lead" }, "member-1", "main", new Set(["q1"]))).toBe(false);
  });
});

describe("question summary line", () => {
  it("asks this member to answer a human-stage question", () => {
    const onOpen = vi.fn();
    const view = wrap(<QuestionSummaryLine question={question} getActorName={getActorName} onOpen={onOpen} />);
    expect(summary(view)).toHaveTextContent("Awaiting answer");
    expect(summary(view)).toHaveClass("border-orange-300");
    expect(screen.getByTitle("Retire the v1 endpoint now?")).toHaveTextContent("Retire the v1 endpoint now?");
    expect(summary(view)).not.toHaveTextContent("It still serves two clients.");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("only offers a view of a question an Agent holds", () => {
    const view = wrap(<QuestionSummaryLine question={{ ...question, ...agentHeld }} getActorName={getActorName} onOpen={vi.fn()} />);
    expect(summary(view)).toHaveTextContent("Waiting for Lead");
    expect(summary(view)).not.toHaveClass("border-orange-300");
    expect(screen.getByRole("button", { name: "View" })).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });
  it("shows who answered and a one-line answer", () => {
    const view = wrap(<QuestionSummaryLine question={{ ...question, ...answered, answer: { ...answered.answer!, body_md: "Retire\nnow" } }} getActorName={getActorName} onOpen={vi.fn()} />);
    expect(summary(view)).toHaveTextContent("Answered");
    expect(screen.getByTitle("Member One: Retire now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  });
  it("shows a closed question without an answer", () => {
    const view = wrap(<QuestionSummaryLine question={{ ...question, status: "closed", actions: { allowed: [] } }} getActorName={getActorName} onOpen={vi.fn()} />);
    expect(summary(view)).toHaveTextContent("Closed");
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  });
  it.each([
    ["a human-stage question", {}, "待回答", "回答问题"],
    ["an Agent-held question", agentHeld, "等待 Lead 回答", "查看"],
    ["an answered question", answered, "已回答", "查看"],
  ] as const)("reads %s in Chinese", (_label, patch, tag, action) => {
    const qc = new QueryClient();
    const view = render(<QueryClientProvider client={qc}><I18nProvider locale="zh-Hans" resources={{ "zh-Hans": { issues: zhIssues } }}>
      <QuestionSummaryLine question={{ ...question, ...patch }} getActorName={getActorName} onOpen={vi.fn()} />
    </I18nProvider></QueryClientProvider>);
    expect(view.container.querySelector("[data-question-tag]")).toHaveTextContent(tag);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });
  it("keeps a permission request's tool title", () => {
    const view = wrap(<QuestionSummaryLine question={{ ...question, kind: "permission", original_questions: [], original_message: "Bash: rm -rf ./dist", options: [{ label: "Allow once", value: "allow" }] }} getActorName={getActorName} onOpen={vi.fn()} />);
    expect(summary(view)).toHaveTextContent("Bash: rm -rf ./dist");
  });
});

describe("linked question drawer", () => {
  async function open(view: Partial<QuestionView>, action: string) {
    mocks.getQuestion.mockResolvedValue({ ...question, ...view });
    const mounted = wrap(<LinkedQuestion id="q1" getActorName={getActorName} />);
    expect(summary(mounted).querySelector("[data-question-tag]")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: action }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-side", "right");
    expect(within(dialog).getByText("Questions")).toBeInTheDocument();
    return within(dialog);
  }
  it("loads the Q on mount and answers it in the drawer's pending section", async () => {
    const drawer = await open({}, "Answer");
    expect(mocks.getQuestion).toHaveBeenCalledWith("q1");
    expect(drawer.getByRole("region", { name: "Awaiting answers" })).toBeInTheDocument();
    expect(drawer.getByText(/^Asked by Worker · /, { selector: "p" })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: "Retire" })).toBeInTheDocument();
  });
  it("lists an Agent-held Q read-only under the Agent section", async () => {
    const drawer = await open(agentHeld, "View");
    expect(drawer.getByRole("region", { name: "Waiting for an Agent" })).toBeInTheDocument();
    expect(drawer.getByText(enIssues.responsibility.agent_readonly)).toBeInTheDocument();
    expect(drawer.queryByRole("button", { name: "Retire" })).toBeNull();
  });
  it("lists an answered Q under the history section", async () => {
    const drawer = await open(answered, "View");
    expect(drawer.getByRole("region", { name: "Answered and closed" })).toBeInTheDocument();
    expect(drawer.getByText("Answered · execution resumed")).toBeInTheDocument();
  });
  it("marks a question that is gone for good without retrying", async () => {
    mocks.getQuestion.mockRejectedValue(new ApiError("forbidden", 403, "Forbidden"));
    const view = wrap(<LinkedQuestion id="q1" getActorName={getActorName} />);
    await waitFor(() => expect(summary(view)).toHaveTextContent("This question is no longer available"));
    expect(mocks.getQuestion).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
