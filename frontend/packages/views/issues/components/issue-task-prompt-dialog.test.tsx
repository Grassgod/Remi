import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { renderWithI18n } from "../../test/i18n";
import { IssueTaskPromptDialog } from "./issue-task-prompt-dialog";

const listTasks = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { listTasksByIssue: listTasks } }));
vi.mock("../../common/task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task, initialView, headerSlot, onOpenChange }: any) =>
  <div role="dialog" data-task={task.id} data-initial-view={initialView}>{headerSlot}<button onClick={() => onOpenChange(false)}>Close</button></div> }));

const row = SessionLogEntrySchema.parse({ session_id: "s", seq: 1, id: "assignment", revision: 1, kind: "turn", task_id: "task",
  body_md: "# Assignment", body_html: null, render_version: null, author_type: "system",
  metadata: { delegated_by_agent_id: "lead" } });
function Trigger() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Assignment</button>
    {open && <IssueTaskPromptDialog issueId="issue" row={row} getActorName={(_type, id) => id === "lead" ? "Lead" : "QA"} onClose={() => setOpen(false)} />}</>;
}
function renderTrigger() {
  return renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Trigger /></QueryClientProvider>);
}

beforeEach(() => listTasks.mockReset());

describe("assignment task prompt entry", () => {
  it("fetches only after activation, reuses the task cache and opens Prompt on every new visit", async () => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa" }, { id: "other" }]);
    renderTrigger();
    expect(listTasks).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("data-task", "task"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-initial-view", "prompt");
    expect(dialog).toHaveTextContent("Assigned by: Lead");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-initial-view", "prompt");
    expect(listTasks).toHaveBeenCalledOnce();
  });

  it("shows loading then an unavailable task instead of guessing a different task", async () => {
    let complete!: (value: unknown[]) => void;
    listTasks.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    renderTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(screen.getByLabelText("Loading task")).toBeInTheDocument();
    complete([{ id: "different" }]);
    expect(await screen.findByText("This task could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-task");
  });

  it("offers a retry after a failed task lookup", async () => {
    listTasks.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce([{ id: "task", agent_id: "qa" }]);
    renderTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("data-task", "task"));
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});
