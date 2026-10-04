import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueLogEventRow } from "./issue-log-event-row";

vi.mock("../../editor", () => ({ ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div> }));

const getActorName = (type: string, id: string) => ({ "agent:qa": "QA", "agent:lead": "Lead", "member:user": "User" })[`${type}:${id}` as "agent:qa"] ?? "";
function row(extra: Partial<SessionLogRow> = {}): SessionLogRow {
  return SessionLogEntrySchema.parse({ session_id: "s", seq: 1, id: "r", revision: 1, kind: "turn",
    body_md: "# **Task**\n\nFull assignment", body_html: "<h1>Task</h1><p>Full assignment</p>", render_version: "v",
    author_type: "agent", author_id: "lead", metadata: { assignee_agent_id: "qa", status: "completed" }, ...extra });
}
function Event({ entry = row(), results = new Map(), onShowKeyResults = vi.fn() }: {
  entry?: SessionLogRow; results?: Map<string, SessionResult>; onShowKeyResults?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <IssueLogEventRow row={entry} expanded={expanded} onToggle={() => setExpanded(value => !value)}
    results={results} getActorName={getActorName} onShowKeyResults={onShowKeyResults} />;
}

describe("Issue log event rows", () => {
  it("renders a single plain assignment then mounts the full body only after a click", () => {
    const view = renderWithI18n(<Event />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("Lead → QA assigned a task: Task");
    expect(toggle).toHaveTextContent("Completed");
    expect(view.container.querySelector("[data-entry-html]")).toBeNull();
    expect(screen.queryByText("Full assignment")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { expanded: true })).toBe(toggle);
    expect(screen.getByRole("heading", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByText("Full assignment")).toBeInTheDocument();
    expect(view.container.querySelector("[data-entry-html]")?.parentElement).toHaveClass("text-sm");
    fireEvent.click(toggle);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows system assignments without a fabricated sender and keeps name resolution in the same fixed line", () => {
    const view = renderWithI18n(<Event entry={row({ author_type: "system", author_id: null, metadata: {} })} />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveTextContent("Agent received a task: Task");
    expect(toggle).toHaveClass("h-8");
    view.rerender(<Event entry={row({ author_type: "system", metadata: { assignee_agent_id: "qa" } })} />);
    expect(toggle).toHaveTextContent("QA received a task: Task");
    expect(toggle).toHaveClass("h-8");
  });

  it("never expands an inbox turn or exposes its raw prompt", () => {
    renderWithI18n(<Event entry={row({ body_md: "读收件箱\n\nises_123:82 (cmt_env_456)", body_html: "<h1>Internal prompt</h1>" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("QA processed new messages");
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).not.toHaveTextContent(/ises_|cmt_env_|Internal prompt/);
  });

  it.each([
    ["done", "QA completed a task you delegated.", "QA completed a task delegated by Lead"],
    ["failed", "QA could not complete a task you delegated.", "QA could not complete a task delegated by Lead"],
    ["cancelled", "A task you delegated to QA was cancelled.", "A task delegated by Lead to QA was cancelled"],
  ])("summarizes a %s delegation report without agent instructions", (outcome, firstLine, expected) => {
    renderWithI18n(<Event entry={row({ kind: "system", body_md: `${firstLine}\nRead the latest Session Updates.\nSource task: tsk_123`,
      metadata: { envelope: { kind: "report", outcome, recipient_agent_id: "lead", source: { taskId: "tsk_123" } } } })} />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).not.toHaveTextContent(/Read the latest|tsk_/);
  });

  it("uses an unnamed report when the reporter cannot be parsed", () => {
    renderWithI18n(<Event entry={row({ kind: "system", body_md: "Unknown internal protocol", metadata: { envelope: { kind: "report", outcome: "done" } } })} />);
    expect(screen.getByRole("status")).toHaveTextContent("The delegated task is complete");
  });

  it.each([
    ["QA completed a task you delegated.", "The delegated task is complete"],
    ["QA could not complete a task you delegated.", "The delegated task failed"],
    ["A task you delegated to QA was cancelled.", "The delegated task was cancelled"],
    ["Unknown protocol\nStatus: failed", "The delegated task failed"],
    ["Unknown protocol with tsk_123", "The delegated task has an update"],
  ])("keeps old envelopes without metadata readable: %s", (body_md, expected) => {
    renderWithI18n(<Event entry={row({ id: "cmt_env_old", kind: "system", body_md, metadata: {} })} />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(document.body).not.toHaveTextContent(/Unknown protocol|tsk_|a task you delegated/);
  });

  it.each([true, false])("opens the result panel with publisher matched: %s", (matched) => {
    const result = { id: "res_123", title: "Report", published_by_type: "agent", published_by_id: "qa" } as SessionResult;
    const show = vi.fn();
    renderWithI18n(<Event entry={row({ kind: "result_published", body_md: "# Duplicate report body", metadata: { result_id: result.id, title: result.title } })}
      results={new Map(matched ? [[result.id, result]] : [])} onShowKeyResults={show} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe(`${matched ? "QA " : ""}published the result "Report"`);
    expect(document.body).not.toHaveTextContent("Duplicate report body");
    fireEvent.click(button);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown kinds plain, short and free of internal IDs", () => {
    renderWithI18n(<Event entry={row({ kind: "follow_frozen", body_md: "# **Frozen** ises_123 cmt_456 sevt_789 chat_abc\nLong internal body" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Frozen");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body).not.toHaveTextContent(/ises_|cmt_|sevt_|chat_|Long internal body/);
  });

  it.each(["en", "zh-Hans", "ja", "ko"] as const)("has localized event labels in %s", locale => {
    renderWithI18n(<Event />, { locale });
    expect(screen.getByRole("button")).toHaveTextContent("QA");
    expect(document.body).not.toHaveTextContent("log_event.");
  });
});
