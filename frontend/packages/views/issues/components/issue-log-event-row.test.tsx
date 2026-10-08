import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueLogEventRow } from "./issue-log-event-row";
import { firstTaskResponses, isSystemDetail, assignmentAuthor } from "./issue-log-presentation";

// This suite asserts the event summary row. Turn controls have their own
// QueryClient-backed component suite in common/turn-controls.test.tsx.
vi.mock("../../common/turn-controls", () => ({ TurnControls: () => null }));

const getActorName = (type: string, id: string) => ({ "agent:qa": "QA", "agent:lead": "Lead", "member:user": "User" })[type + ":" + id as "agent:qa"] ?? "";
function row(extra: Partial<SessionLogRow> = {}): SessionLogRow {
  return SessionLogEntrySchema.parse({ session_id: "s", seq: 1, id: "r", revision: 1, kind: "turn", task_id: "task",
    body_md: "# **Task**\n\nFull assignment", body_html: "<h1>Task</h1><p>Full assignment</p>", render_version: "v",
    author_type: "agent", author_id: "lead", metadata: { assignee_agent_id: "qa", status: "completed", elapsed_ms: 42100 }, ...extra });
}
function Event({ entry = row(), results = new Map(), onShowKeyResults = vi.fn(), onOpenTask = vi.fn(), taskAgents = new Map() }: {
  entry?: SessionLogRow; results?: Map<string, SessionResult>; onShowKeyResults?: () => void;
  onOpenTask?: (row: SessionLogRow) => void; taskAgents?: Map<string, string>;
}) {
  return <IssueLogEventRow row={entry} onOpenTask={onOpenTask} taskAgents={taskAgents}
    results={results} getActorName={getActorName} onShowKeyResults={onShowKeyResults} />;
}

describe("Issue log presentation", () => {
  it.each(["reply", "request", "report", "status", "final", "decision"])(
    "keeps canonical %s messages in the default conversation despite legacy envelopes", messageKind => {
      const entry = row({ kind: "message", sender_type: "member", sender_id: "user",
        message_kind: messageKind, body_md: "中文 **正文** 🧪", metadata: { envelope: { kind: "notification" } } });
      expect(isSystemDetail(entry)).toBe(false);
      expect(isSystemDetail(row({ ...entry, sender_type: "agent", sender_id: "qa" }))).toBe(false);
      expect(isSystemDetail(row({ ...entry, sender_type: undefined }))).toBe(false);
    },
  );

  it("routes internal types before rendering, preserving assignments and comments", () => {
    const hidden = [
      row({ kind: "result_published" }),
      row({ body_md: "读收件箱 ises_123 cmt_env_456" }),
      row({ kind: "system", metadata: { envelope: { kind: "report" } } }),
      row({ kind: "message", author_type: "system" }),
      row({ kind: "follow_frozen" }),
      row({ kind: "new_kind" }),
      row({ kind: "message", author_type: "agent", metadata: { envelope: { kind: "unknown" } } }),
      row({ kind: "system", metadata: { type: "workspace_move_cleared" } }),
    ];
    const shown = [row(), row({ seq: 0, kind: "head" }), row({ kind: "message", author_type: "member" }),
      row({ kind: "message", author_type: "agent" })];
    expect(hidden.every(isSystemDetail)).toBe(true);
    expect(shown.some(isSystemDetail)).toBe(false);
    expect([...shown, ...hidden].filter(entry => !isSystemDetail(entry))).toEqual(shown);
  });

  it("hides canonical platform reports and English wake turns without a precomputed layer", () => {
    expect(isSystemDetail(row({ kind: "message", sender_type: "platform", message_kind: "report",
      body_md: "QA completed a task. Read the latest Session Updates.",
      metadata: { envelope: { kind: "report", to: { role: "delegator" } } } }))).toBe(true);
    expect(isSystemDetail(row({ body_md: "QA completed a task. Read the latest Session Updates.",
      metadata: { wake_source: "platform_to_owner", assignee_agent_id: "lead" } }))).toBe(true);
  });

  it("preserves the wire layer through parsing and prefers it to the cached-row fallback", () => {
    const system = row({ layer: "system", body_md: "Ordinary looking prompt" });
    expect(system.layer).toBe("system");
    expect(isSystemDetail(system)).toBe(true);
    expect(isSystemDetail(row({ layer: "conversation", metadata: { wake_source: "platform_to_owner" } }))).toBe(false);
  });

  it.each(["future_layer", null, 7])("falls back to the shared rule for an invalid wire layer %s", layer => {
    const entry = SessionLogEntrySchema.parse({ ...row({ kind: "message", sender_type: "platform" }), layer });
    expect(entry.layer).toBeUndefined();
    expect(isSystemDetail(entry)).toBe(true);
  });

  it("uses delegated_by before the author, and does not invent a system delegator", () => {
    expect(assignmentAuthor(row({ author_type: "system", metadata: { delegated_by_agent_id: "lead" } }))).toEqual({ type: "agent", id: "lead" });
    expect(assignmentAuthor(row({ author_type: "member", author_id: "user" }))).toEqual({ type: "member", id: "user" });
    expect(assignmentAuthor(row({ author_type: "system" }))).toBeNull();
  });

  it("links only the first assignee comment after a unique loaded assignment", () => {
    const turn = row();
    const reply = row({ seq: 2, id: "reply", kind: "message", author_id: "qa", metadata: {} });
    const later = { ...reply, seq: 3, id: "later" };
    expect([...firstTaskResponses([turn, reply, later])]).toEqual([["reply", turn]]);
    expect(firstTaskResponses([reply, later]).size).toBe(0);
    expect(firstTaskResponses([turn, { ...reply, author_id: "someone" }]).size).toBe(0);
    expect(firstTaskResponses([turn, { ...reply, task_id: "other" }]).size).toBe(0);
    expect(firstTaskResponses([turn, { ...turn, id: "ambiguous", seq: 2 }, later]).size).toBe(0);
    expect(firstTaskResponses([row({ body_md: "读收件箱" }), reply]).size).toBe(0);
  });
});

describe("Issue log event rows", () => {
  it("keeps assignment text, duration, status and icon in one fixed row; a click opens the task without rendering its body", () => {
    const open = vi.fn();
    const entry = row();
    const view = renderWithI18n(<Event entry={entry} onOpenTask={open} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Lead → QA assigned a task: Task");
    expect(button).toHaveTextContent("Completed · 42s");
    expect(button).toHaveClass("h-8", "text-xs");
    expect(button.querySelector("span.w-6")).not.toBeNull();
    expect(button).not.toHaveAttribute("aria-expanded");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(entry);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Full assignment")).toBeNull();
    expect(view.container.querySelector("[data-entry-html]")).toBeNull();
  });

  it("keeps late name changes inside the same fixed row and resolves system assignments from metadata", () => {
    const view = renderWithI18n(<Event entry={row({ author_type: "system", metadata: {}, task_id: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent received a task");
    view.rerender(<Event entry={row({ author_type: "system", metadata: { assignee_agent_id: "qa", delegated_by_agent_id: "lead" } })} />);
    expect(screen.getByRole("button")).toHaveTextContent("Lead → QA assigned a task");
    expect(screen.getByRole("button")).toHaveClass("h-8");
  });

  it("uses a tenseless inbox summary with no interaction or prompt", () => {
    renderWithI18n(<Event entry={row({ body_md: "读收件箱\nises_123:82 (cmt_env_456)" })} />, { locale: "zh-Hans" });
    expect(screen.getByRole("status")).toHaveTextContent("系统QA 查看新消息");
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).not.toHaveTextContent(/ises_|cmt_env_|Full assignment/);
  });

  it.each([undefined, "system"] as const)("summarizes an English platform wake turn by layer (%s)", layer => {
    renderWithI18n(<Event entry={row({ layer, body_md: "QA completed a task. Read ises_123 tsk_456.",
      metadata: { wake_source: "platform_to_owner", assignee_agent_id: "lead", delegated_by_agent_id: "lead" } })} />,
    { locale: "zh-Hans" });
    expect(screen.getByRole("status")).toHaveTextContent("系统Lead 查看新消息");
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).not.toHaveTextContent(/派活|QA completed|ises_|tsk_/);
  });

  it("summarizes a canonical platform envelope without exposing the English body", () => {
    renderWithI18n(<Event entry={row({ kind: "message", sender_type: "platform", message_kind: "report",
      body_md: "QA completed a task. Read ises_123 tsk_456.", metadata: { envelope: {
        kind: "report", dedupeKey: "delegation_terminal:x", outcome: "done", recipient_agent_id: "lead",
        to: { role: "delegator" }, source: { taskId: "task" },
      } } })} taskAgents={new Map([["task", "qa"]])} />);
    expect(screen.getByRole("status")).toHaveTextContent("Notified Lead: the task assigned to QA is complete");
    expect(document.body).not.toHaveTextContent(/QA completed|ises_|tsk_/);
  });

  it.each([
    ["delegation_terminal:x", "report", "done", "the task assigned to QA is complete"],
    ["delegation_terminal:x", "report", "failed", "the task assigned to QA failed"],
    ["delegation_terminal:x", "report", "cancelled", "the task assigned to QA was cancelled"],
    ["child_status:x", "report", "done", "a child issue is complete"],
    ["child_status:x", "report", "failed", "a child issue failed"],
    ["child_status:x", "report", "cancelled", "a child issue was cancelled"],
    ["dependency_failed:x", "report", "failed", "a prerequisite did not complete"],
    ["dependency_ready:x", "lifecycle", "", "dependencies are ready"],
    ["decision_request:x", "decision_needed", "", "a decision is needed"],
    ["decision_answer:x", "reply", "", "a decision has an answer"],
    ["decision_overturn:x", "reply", "", "a decision has an answer"],
    ["delegation_progress:x", "reply", "", "the delegated task has an update"],
    ["relay:x", "report", "done", "an issue has new progress"],
    ["new:x", "new_kind", "", "a new system message"],
  ])("never exposes the body of envelope %s", (dedupeKey, kind, outcome, text) => {
    renderWithI18n(<Event entry={row({ kind: "system", body_md: "INTERNAL INSTRUCTION dec_123 mem_456 usr_789 hrq_abc",
      metadata: { envelope: { dedupeKey, kind, outcome, recipient_agent_id: "lead", to: { role: "delegator" }, source: { taskId: "task" } } } })}
      taskAgents={new Map([["task", "qa"]])} />);
    expect(screen.getByRole("status")).toHaveTextContent("Notified Lead: " + text);
    expect(document.body).not.toHaveTextContent(/INTERNAL|dec_|mem_|usr_|hrq_/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses a generic system label for an unclassified report, never a delegation guess", () => {
    renderWithI18n(<Event entry={row({ kind: "system", body_md: "Read the latest Session Updates", metadata: { envelope: { kind: "report", outcome: "done", to: { role: "issue_owner" } } } })} />);
    expect(screen.getByRole("status")).toHaveTextContent("a new system message");
    expect(document.body).not.toHaveTextContent("Read the latest");
  });

  it.each([true, false])("opens the result panel with publisher matched: %s", matched => {
    const result = { id: "res_123", title: "Report", published_by_type: "agent", published_by_id: "qa" } as SessionResult;
    const show = vi.fn();
    renderWithI18n(<Event entry={row({ kind: "result_published", body_md: "# Duplicate report body", metadata: { result_id: result.id, title: result.title } })}
      results={new Map(matched ? [[result.id, result]] : [])} onShowKeyResults={show} />);
    expect(screen.getByRole("button")).toHaveTextContent((matched ? "QA " : "") + 'published the result "Report"');
    expect(document.body).not.toHaveTextContent("Duplicate report body");
    fireEvent.click(screen.getByRole("button"));
    expect(show).toHaveBeenCalledOnce();
  });

  it("keeps unknown kinds plain, short and free of internal IDs", () => {
    renderWithI18n(<Event entry={row({ kind: "follow_frozen", body_md: "# **Frozen** ises_123 cmt_456 sevt_789 chat_abc\nLong internal body" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Frozen");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body).not.toHaveTextContent(/ises_|cmt_|sevt_|chat_|Long internal body/);
  });

  it.each(["en", "zh-Hans", "ja", "ko"] as const)("has localized event labels in %s", locale => {
    renderWithI18n(<Event entry={row({ kind: "system", metadata: { envelope: { kind: "decision_needed", recipient_agent_id: "qa" } } })} />, { locale });
    expect(screen.getByRole("status")).toHaveTextContent("QA");
    expect(document.body).not.toHaveTextContent("log_event.");
  });
});
