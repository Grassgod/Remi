import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { renderWithI18n } from "../../test/i18n";
import enIssues from "../../locales/en/issues.json";
import zhIssues from "../../locales/zh-Hans/issues.json";
import jaIssues from "../../locales/ja/issues.json";
import koIssues from "../../locales/ko/issues.json";
import { IssueTaskPromptDialog } from "./issue-task-prompt-dialog";

const listTasks = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { listTasksByIssue: listTasks } }));
vi.mock("../../common/task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task, initialView, headerSlot, promptFallback, onOpenChange }: any) =>
  <div role="dialog" data-task={task.id} data-initial-view={initialView}>{headerSlot}<div data-testid="prompt-fallback">{promptFallback}</div><button onClick={() => onOpenChange(false)}>Close</button></div> }));

const row = SessionLogEntrySchema.parse({ session_id: "s", seq: 1, id: "assignment", revision: 1, kind: "turn", task_id: "task",
  body_md: "# Assignment", body_html: null, render_version: null, author_type: "system",
  metadata: { delegated_by_agent_id: "lead" } });
const localizedIssues = { en: enIssues, "zh-Hans": zhIssues, ja: jaIssues, ko: koIssues };
function Trigger({ assignment = row }: { assignment?: typeof row }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Assignment</button>
    {open && <IssueTaskPromptDialog issueId="issue" row={assignment} getActorName={(_type, id) => id === "lead" ? "Lead" : "QA"} onClose={() => setOpen(false)} />}</>;
}
function renderTrigger(assignment = row, locale: keyof typeof localizedIssues = "en") {
  return renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Trigger assignment={assignment} /></QueryClientProvider>, { locale });
}

beforeEach(() => listTasks.mockReset());

describe("assignment task prompt entry", () => {
  it.each(["queued", "dispatched", "waiting_local_directory"])("uses turn status %s for the not-started notice even if task status differs", async (status) => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa", status: "completed" }]);
    renderTrigger({ ...row, metadata: { ...row.metadata, status } });
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(await screen.findByTestId("prompt-fallback")).toHaveTextContent("This task has not started yet.");
  });

  it.each(["running", "awaiting_human", "completed", "failed", "cancelled", "unknown", undefined])("uses a neutral unrecorded notice for turn status %s", async (status) => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa", status: "queued" }]);
    renderTrigger({ ...row, metadata: { ...row.metadata, status } });
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(await screen.findByTestId("prompt-fallback")).toHaveTextContent("The execution input was not recorded.");
    expect(screen.queryByText(/This task has not started yet/)).toBeNull();
  });

  it.each(["en", "zh-Hans", "ja", "ko"] as const)("provides both notices in %s", async (locale) => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa" }]);
    const pending = renderTrigger({ ...row, metadata: { ...row.metadata, status: "queued" } }, locale);
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(await screen.findByTestId("prompt-fallback")).toHaveTextContent(localizedIssues[locale].log_event.task_prompt_pending);
    pending.unmount();
    renderTrigger({ ...row, metadata: { ...row.metadata, status: "completed" } }, locale);
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(await screen.findByTestId("prompt-fallback")).toHaveTextContent(localizedIssues[locale].log_event.task_prompt_unrecorded);
  });

  it("renders the complete Markdown assignment with bounded headings when HTML is absent", async () => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa" }]);
    const body = "# Long assignment\n\n" + Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}: **Do this step.**`).join("\n\n");
    renderTrigger({ ...row, body_md: body });
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    expect(await screen.findByRole("heading", { name: "Long assignment" })).toBeInTheDocument();
    expect(screen.getByText(/Paragraph 20:/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Long assignment" }).closest(".rich-text-editor--compact")).not.toBeNull();
    expect(screen.getAllByText("Do this step.", { selector: "strong" })).toHaveLength(20);
  });

  it("prefers the pre-rendered assignment HTML and keeps its headings compact", async () => {
    listTasks.mockResolvedValue([{ id: "task", agent_id: "qa" }]);
    renderTrigger({ ...row, body_md: "Markdown must not replace the stored HTML", body_html: "<h1>Stored assignment</h1><p>Complete HTML instructions</p>" });
    fireEvent.click(screen.getByRole("button", { name: "Assignment" }));
    const heading = await screen.findByRole("heading", { name: "Stored assignment" });
    expect(heading.closest("[data-entry-html]")).toHaveClass("rich-text-editor--compact");
    expect(screen.getByText("Complete HTML instructions")).toBeInTheDocument();
    expect(screen.queryByText(/Markdown must not replace/)).toBeNull();
  });

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
