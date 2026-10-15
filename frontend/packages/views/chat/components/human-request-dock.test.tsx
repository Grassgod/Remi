import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ApiError } from "@multiremi/core/api";
import type { QuestionView } from "@multiremi/core/api/schemas";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enCommon from "../../locales/en/common.json";
import { HumanRequestDock } from "./human-request-dock";

const { listMessages, sendMessage, getQuestion, actOnQuestion, getIssue } = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendMessage: vi.fn(async () => ({})),
  getQuestion: vi.fn(), actOnQuestion: vi.fn(), getIssue: vi.fn(),
}));

vi.mock("@multiremi/core/api", async importOriginal => ({
  ApiError: (await importOriginal<typeof import("@multiremi/core/api")>()).ApiError,
  api: { listMessages, sendMessage, getQuestion, actOnQuestion, getIssue },
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspaceSlug: () => "ws", useWorkspacePaths: () => ({
  inboxItem: (id: string) => `/ws/inbox?item=${id}`, issueDetail: (id: string) => `/ws/issues/${id}`, squadDetail: (id: string) => `/ws/squads/${id}`,
}) }));
vi.mock("../../navigation", () => ({ AppLink: (props: { href: string; children: React.ReactNode }) => <a {...props} /> }));

const TEST_RESOURCES = { en: { chat: enChat, issues: enIssues, common: enCommon } };
const NAMES: Record<string, string> = { worker: "Worker", lead: "Lead", human: "Member One" };
const getActorName = (_type: string, id: string) => NAMES[id] ?? id;

const PERMISSION_REQUEST = {
  id: "hrq_perm",
  taskId: "tsk_1",
  kind: "permission",
  payload: {
    tool_call: { title: "Bash: rm -rf ./dist" },
    options: [
      { optionId: "opt-allow", kind: "allow_once", name: "Allow once" },
      { optionId: "opt-deny", kind: "reject_once", name: "Deny" },
    ],
  },
  status: "pending",
  response: null,
  respondedBy: null,
  createdAt: "2026-07-09T00:00:00Z",
  respondedAt: null,
};

const QUESTION_REQUEST = {
  id: "hrq_q",
  taskId: "tsk_1",
  kind: "question",
  payload: {
    message: "Which environment should I deploy to?",
    questions: [
      {
        fieldKey: "question_0",
        question: {
          question: "Which environment should I deploy to?",
          header: "Environment",
          options: [{ label: "staging" }, { label: "production" }],
          multiSelect: false,
        },
      },
    ],
  },
  status: "pending",
  response: null,
  respondedBy: null,
  createdAt: "2026-07-09T00:00:00Z",
  respondedAt: null,
};

type Request = typeof PERMISSION_REQUEST & typeof QUESTION_REQUEST & { payload: { context?: { text: string } } };

/** The Issue human stage by default: nobody is named and this member may answer. */
function questionView(request: Request, patch: Partial<QuestionView> = {}): QuestionView {
  return { id: request.id, kind: request.kind, session_id: "session_1", workspace_id: "ws", source_issue_id: "issue", source_agent_id: "worker", source_turn_id: "turn_1", source_attempt_id: null,
    original_questions: request.payload.questions ?? [], original_context: request.payload.context ?? null, original_message: request.payload.message ?? request.payload.tool_call?.title ?? "",
    options: request.kind === "permission" ? request.payload.options.map(option => ({ label: option.name, value: option.optionId })) : null,
    summary: null, current_handler: null, stage: "human", route_revision: 1, answer_revision: 0, status: "pending", wait_status: "waiting", wait_reason: null, answer: null, history: [], actions: { allowed: ["answer", "close"] }, ...patch };
}

function renderDock(requests: unknown[], views: Record<string, Partial<QuestionView>> = {}, props: { getActorName?: typeof getActorName } = { getActorName }) {
  getQuestion.mockImplementation(async (id: string) => {
    const request = requests.find(value => (value as { id: string }).id === id) as Request;
    return questionView(request, views[id]);
  });
  listMessages.mockResolvedValue({ messages: requests.map(value => {
    const request = value as typeof PERMISSION_REQUEST;
    return { id: request.id, task_id: "turn_1", created_at: request.createdAt,
      resolved_at: request.status === "pending" ? null : request.createdAt,
      metadata: { human_request: request } };
  }), next_cursor: null });
  return mountDock(props);
}

/** Opens the drawer from a summary line; the drawer reuses the full question card. */
async function openQuestion(action = "Answer") {
  fireEvent.click(await screen.findByRole("button", { name: action }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.querySelector("[data-question-id]")).not.toBeNull());
  return within(dialog);
}

function mountDock(props: { getActorName?: typeof getActorName } = { getActorName }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <HumanRequestDock taskId="tsk_1" sessionId="session_1" turnId="turn_1" {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const line = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-question-summary="${id}"]`)!;

beforeEach(() => {
  listMessages.mockReset();
  sendMessage.mockClear();
  getIssue.mockReset(); getIssue.mockRejectedValue(new Error("not loaded"));
  getQuestion.mockReset(); actOnQuestion.mockReset(); actOnQuestion.mockImplementation(async (id: string) => getQuestion(id));
});

describe("HumanRequestDock", () => {
  it("renders nothing when the turn asked nothing", async () => {
    const view = renderDock([]);
    await waitFor(() => expect(listMessages).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows one summary line per question with its status, title and a way into the drawer", async () => {
    const view = renderDock([PERMISSION_REQUEST, QUESTION_REQUEST], {
      hrq_q: { stage: "parent_owner", current_handler: { type: "agent", id: "lead" }, actions: { allowed: [] } },
    });
    await waitFor(() => expect(line(view.container, "hrq_q")).toHaveTextContent("Waiting for Lead"));
    const permission = line(view.container, "hrq_perm");
    expect(permission).toHaveTextContent("Awaiting answer");
    expect(permission).toHaveTextContent("Bash: rm -rf ./dist");
    expect(within(permission).getByRole("button", { name: "Answer" })).toHaveAttribute("aria-haspopup", "dialog");
    const agentHeld = line(view.container, "hrq_q");
    expect(agentHeld).toHaveTextContent("Which environment should I deploy to?");
    expect(within(agentHeld).getByRole("button", { name: "View" })).toHaveAttribute("aria-haspopup", "dialog");
    // Lines load their Q on mount; the questions themselves stay in the drawer.
    expect(getQuestion).toHaveBeenCalledWith("hrq_perm");
    expect(getQuestion).toHaveBeenCalledWith("hrq_q");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("staging")).toBeNull();
  });

  it("keeps the turn's answered question as a line with its answerer and answer", async () => {
    const answer = { response: { answers: { "Which environment should I deploy to?": "staging" } }, body_md: "", actor: { type: "member", id: "human" }, at: "now", reply_message_id: "reply" };
    const view = renderDock([{ ...QUESTION_REQUEST, status: "responded" }], {
      hrq_q: { status: "answered", wait_status: "consumed", answer, actions: { allowed: [] } },
    });
    await waitFor(() => expect(line(view.container, "hrq_q")).toHaveTextContent("Answered"));
    expect(line(view.container, "hrq_q")).toHaveTextContent("Member One: staging");
    const drawer = await openQuestion("View");
    expect(drawer.getByRole("region", { name: "Answered and closed" })).toBeInTheDocument();
    expect(drawer.getByText("Answered · execution resumed")).toBeInTheDocument();
  });

  it("opens the right-side drawer titled for the question and its asker", async () => {
    renderDock([QUESTION_REQUEST]);
    const drawer = await openQuestion();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "right");
    expect(drawer.getByText("Questions")).toBeInTheDocument();
    expect(drawer.getByText("Asked by Worker", { selector: "p" })).toBeInTheDocument();
    expect(drawer.getByRole("region", { name: "Awaiting answers" })).toBeInTheDocument();
  });

  it("names the subagent whose child session asked, on the line and in the drawer", async () => {
    const view = renderDock([PERMISSION_REQUEST], { hrq_perm: { source_subagent: { item_id: "sa:agent-1", name: "Count files" } } });
    await waitFor(() => expect(line(view.container, "hrq_perm")).toHaveTextContent("From subagent Count files"));
    const drawer = await openQuestion();
    expect(drawer.getByText("From subagent Count files")).toHaveAttribute("data-question-subagent", "sa:agent-1");
  });

  it("labels an unnamed subagent generically and the root session not at all", async () => {
    const view = renderDock([PERMISSION_REQUEST, QUESTION_REQUEST], { hrq_q: { source_subagent: { item_id: "sa:agent-2", name: " " } } });
    await waitFor(() => expect(line(view.container, "hrq_q")).toHaveTextContent("From a subagent"));
    await waitFor(() => expect(line(view.container, "hrq_perm")).toHaveTextContent("Bash: rm -rf ./dist"));
    expect(line(view.container, "hrq_perm").querySelector("[data-question-subagent]")).toBeNull();
  });

  it("responds to a permission request with the clicked option", async () => {
    renderDock([PERMISSION_REQUEST]);
    const drawer = await openQuestion();
    expect(drawer.getByText("Bash: rm -rf ./dist")).toBeTruthy();

    fireEvent.click(drawer.getByText("Allow once"));
    fireEvent.click(drawer.getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(actOnQuestion).toHaveBeenCalledWith("hrq_perm", "answer", expect.objectContaining({ expected_route_revision: 1, response: { option_id: "opt-allow" } })),
    );
  });

  it("submits question answers keyed by question text and keeps the line and drawer on the result", async () => {
    const view = renderDock([QUESTION_REQUEST]);
    await screen.findByRole("button", { name: "Answer" });
    actOnQuestion.mockImplementationOnce(async (id: string, _action: string, input: { response: Record<string, unknown> }) => ({
      ...await getQuestion(id), status: "answered", wait_status: "consumed", actions: { allowed: [] },
      answer: { response: input.response, body_md: JSON.stringify(input.response), actor: { type: "member", id: "human" }, at: "now", reply_message_id: "reply" },
    }));
    const drawer = await openQuestion();

    const submit = drawer.getByText("Submit").closest("button")!;
    expect(submit.disabled).toBe(true);

    fireEvent.click(drawer.getByText("staging"));
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.click(submit);
    await waitFor(() =>
      expect(actOnQuestion).toHaveBeenCalledWith("hrq_q", "answer", expect.objectContaining({ expected_route_revision: 1, response: { answers: { "Which environment should I deploy to?": "staging" } } })),
    );
    await drawer.findByText("Answered · execution resumed");
    expect(drawer.queryByText("Answer consumed by original call")).toBeNull();
    expect(drawer.queryByRole("button", { name: "staging" })).toBeNull();
    expect(drawer.queryByText("production")).toBeNull();
    expect(drawer.getByText("staging")).toBeInTheDocument();
    expect(line(view.container, "hrq_q")).toHaveTextContent("Answered");
    expect(line(view.container, "hrq_q")).toHaveTextContent("Member One: staging");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders markdown context and hides a message that duplicates the first question", async () => {
    renderDock([{
      ...QUESTION_REQUEST,
      payload: {
        ...QUESTION_REQUEST.payload,
        context: { text: "Review the **deployment tradeoffs** before choosing." },
      },
    }]);

    const drawer = await openQuestion();
    const emphasized = await drawer.findByText("deployment tradeoffs");
    expect(emphasized.tagName).toBe("STRONG");
    expect(drawer.getAllByText("Which environment should I deploy to?")).toHaveLength(1);
  });

  it("renders an old question payload without context", async () => {
    renderDock([QUESTION_REQUEST]);

    const drawer = await openQuestion();
    expect(drawer.queryByText("Earlier context omitted")).toBeNull();
    expect(drawer.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(drawer.getAllByText("Which environment should I deploy to?")).toHaveLength(1);
  });

  it("collapses overflowing context and toggles it open", async () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(256);
    try {
      renderDock([{
        ...QUESTION_REQUEST,
        payload: {
          ...QUESTION_REQUEST.payload,
          context: { text: Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n") },
        },
      }]);

      const drawer = await openQuestion();
      const expand = await drawer.findByRole("button", { name: "Expand" });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(expand);
      expect(drawer.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it("allows long answer labels to wrap within a narrow request card", async () => {
    const longLabel = "Keep the Issue version after reviewing every conflicting paragraph";
    renderDock([{
      ...QUESTION_REQUEST,
      payload: {
        ...QUESTION_REQUEST.payload,
        questions: [{
          ...QUESTION_REQUEST.payload.questions[0],
          question: {
            ...QUESTION_REQUEST.payload.questions[0]!.question,
            options: [{ label: longLabel }],
          },
        }],
      },
    }]);

    const drawer = await openQuestion();
    const option = await drawer.findByRole("button", { name: longLabel });
    expect(option).toHaveClass("max-w-full", "whitespace-normal", "break-words");
  });

  it("shows a retry action when the request cannot be loaded", async () => {
    listMessages.mockRejectedValueOnce(new Error("forbidden"));
    mountDock();

    expect(await screen.findByText("Could not load this request.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("marks a question that can no longer be read without offering a retry", async () => {
    const view = renderDock([QUESTION_REQUEST]);
    getQuestion.mockRejectedValue(new ApiError("gone", 404, "Not Found"));
    await waitFor(() => expect(line(view.container, "hrq_q")).toHaveTextContent("This question is no longer available"));
    expect(getQuestion).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries a question that failed to load for another reason", async () => {
    const view = renderDock([QUESTION_REQUEST]);
    getQuestion.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(line(view.container, "hrq_q")).toHaveTextContent("Awaiting answer"));
    expect(screen.getByRole("button", { name: "Answer" })).toBeInTheDocument();
  });

  it("keeps the request actionable and shows feedback after a response failure", async () => {
    actOnQuestion.mockRejectedValueOnce(new Error("network down"));
    renderDock([PERMISSION_REQUEST]);
    const drawer = await openQuestion();

    fireEvent.click(drawer.getByText("Allow once"));
    fireEvent.click(drawer.getByRole("button", { name: "Answer" }));

    expect(await drawer.findByRole("alert")).toHaveTextContent("network down");
    expect(drawer.getByText("Allow once").closest("button")?.disabled).toBe(false);
  });
});
