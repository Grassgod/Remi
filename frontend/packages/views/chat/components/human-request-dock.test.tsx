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
});
