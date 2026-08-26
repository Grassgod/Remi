import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enChat from "../../locales/en/chat.json";
import { HumanRequestDock } from "./human-request-dock";

const { listTaskHumanRequests, respondTaskHumanRequest } = vi.hoisted(() => ({
  listTaskHumanRequests: vi.fn(),
  respondTaskHumanRequest: vi.fn(async () => ({})),
}));

vi.mock("@multiremi/core/api", () => ({
  api: { listTaskHumanRequests, respondTaskHumanRequest },
}));

const TEST_RESOURCES = { en: { chat: enChat } };

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

function renderDock(requests: unknown[]) {
  listTaskHumanRequests.mockResolvedValue({ requests });
  mountDock();
}

function mountDock() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <HumanRequestDock taskId="tsk_1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listTaskHumanRequests.mockReset();
  respondTaskHumanRequest.mockClear();
});

describe("HumanRequestDock", () => {
  it("renders nothing when there are no pending requests", async () => {
    renderDock([{ ...PERMISSION_REQUEST, status: "responded", response: { option_id: "opt-allow" } }]);
    await waitFor(() => expect(listTaskHumanRequests).toHaveBeenCalled());
    expect(screen.queryByText("Permission required")).toBeNull();
  });

  it("responds to a permission request with the clicked option", async () => {
    renderDock([PERMISSION_REQUEST]);
    await screen.findByText("Permission required");
    expect(screen.getByText("Bash: rm -rf ./dist")).toBeTruthy();

    fireEvent.click(screen.getByText("Allow once"));
    await waitFor(() =>
      expect(respondTaskHumanRequest).toHaveBeenCalledWith("tsk_1", "hrq_perm", { option_id: "opt-allow" }),
    );
  });

  it("submits question answers keyed by question text", async () => {
    renderDock([QUESTION_REQUEST]);
    await screen.findByText("Agent question");

    const submit = screen.getByText("Submit").closest("button")!;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByText("staging"));
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.click(submit);
    await waitFor(() =>
      expect(respondTaskHumanRequest).toHaveBeenCalledWith("tsk_1", "hrq_q", {
        answers: { "Which environment should I deploy to?": "staging" },
      }),
    );
  });

  it("renders markdown context and hides a message that duplicates the first question", async () => {
    renderDock([{
      ...QUESTION_REQUEST,
      payload: {
        ...QUESTION_REQUEST.payload,
        context: { text: "Review the **deployment tradeoffs** before choosing." },
      },
    }]);

    const emphasized = await screen.findByText("deployment tradeoffs");
    expect(emphasized.tagName).toBe("STRONG");
    expect(screen.getAllByText("Which environment should I deploy to?")).toHaveLength(1);
  });

  it("renders an old question payload without context", async () => {
    renderDock([QUESTION_REQUEST]);

    await screen.findByText("Agent question");
    expect(screen.queryByText("Earlier context omitted")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.getAllByText("Which environment should I deploy to?")).toHaveLength(1);
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

      const expand = await screen.findByRole("button", { name: "Expand" });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(expand);
      expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");
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

    const option = await screen.findByRole("button", { name: longLabel });
    expect(option).toHaveClass("max-w-full", "whitespace-normal", "break-words");
  });

  it("shows a retry action when the request cannot be loaded", async () => {
    listTaskHumanRequests.mockRejectedValueOnce(new Error("forbidden"));
    mountDock();

    expect(await screen.findByText("Could not load this request.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the request actionable and shows feedback after a response failure", async () => {
    respondTaskHumanRequest.mockRejectedValueOnce(new Error("network down"));
    renderDock([PERMISSION_REQUEST]);
    await screen.findByText("Permission required");

    fireEvent.click(screen.getByText("Allow once"));

    expect(await screen.findByText("Response failed. Try again.")).toBeTruthy();
    expect(screen.getByText("Allow once").closest("button")?.disabled).toBe(false);
  });
});
