import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const sendMessage = vi.hoisted(() => vi.fn());
const controlTurn = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@multiremi/core/api", () => ({ api: { sendMessage, controlTurn } }));
vi.mock("sonner", () => ({ toast }));

import { TaskSteerActions } from "./task-steer-actions";

const resources = { en: { common: enCommon, issues: enIssues } };

function renderActions(status: AgentTask["status"] = "running") {
  return render(
    <I18nProvider locale="en" resources={resources}>
      <TaskSteerActions task={{ id: "attempt-1", turn_id: "turn-1", issue_session_id: "sess-1", agent_id: "agt-1", status }} showLabels />
    </I18nProvider>,
  );
}

beforeEach(() => {
  sendMessage.mockReset();
  controlTurn.mockReset().mockResolvedValue({});
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("TaskSteerActions", () => {
  it("submits a trimmed steer instruction", async () => {
    sendMessage.mockResolvedValue({ message: {} });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.change(screen.getByLabelText("New instruction"), {
      target: { value: "  Switch to Chinese  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith("sess-1", expect.objectContaining({ body_md: "Switch to Chinese", to: { type: "agent", ref: "agt-1" }, dedupe_key: expect.any(String) }));
      expect(toast.success).toHaveBeenCalledWith("Instruction sent");
    });
  });

  it("submits force answer with an optional note", async () => {
    sendMessage.mockResolvedValue({ message: {} });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "Lead with the conclusion" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request delivery" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith("sess-1", expect.objectContaining({ body_md: "Lead with the conclusion" }));
      expect(controlTurn).toHaveBeenCalledWith("turn-1", "wrap-up");
      expect(toast.success).toHaveBeenCalledWith("Delivery requested");
    });
  });

  it("shows the API error and keeps the dialog available for retry", async () => {
    sendMessage.mockRejectedValue(
      new Error("task is already completed: steer messages can only target a live task"),
    );
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.change(screen.getByLabelText("New instruction"), {
      target: { value: "Change direction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "task is already completed: steer messages can only target a live task",
      );
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "hides interventions for a %s task",
    (status) => {
      renderActions(status);
      expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Deliver now" })).toBeNull();
    },
  );
});
