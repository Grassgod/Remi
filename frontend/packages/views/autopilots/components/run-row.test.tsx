import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import type { AutopilotRun, AutopilotRunTriggerSummary } from "@multiremi/core/types";

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/issues/${id}`,
    issueSession: (id: string, sessionId: string) => `/issues/${id}/sessions/${sessionId}`,
  }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("../../common/task-transcript", () => ({
  TranscriptButton: ({ title }: { title?: string }) => (
    <button type="button" aria-label={title}>{title}</button>
  ),
}));

import { formatTriggerSummaryDetail, RunRow } from "./run-row";

function makeRun(overrides: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    id: "run-1",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "scm_event",
    status: "completed",
    issue_id: null,
    issue_session_id: null,
    task_id: null,
    triggered_at: "2026-08-24T10:00:00Z",
    completed_at: null,
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-08-24T10:00:00Z",
    trigger_summary: null,
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<AutopilotRunTriggerSummary> = {},
): AutopilotRunTriggerSummary {
  return {
    event_type: null,
    repository_id: null,
    repository_name: null,
    change_number: null,
    change_title: null,
    target_branch: null,
    source_revision: null,
    occurred_at: null,
    wiki_build: false,
    ...overrides,
  };
}

function renderRun(run: AutopilotRun, locale?: "zh-Hans") {
  return renderWithI18n(
    <RunRow run={run} agentId="agent-1" agentName="Atlas" />,
    locale ? { locale } : {},
  );
}

describe("RunRow source labels", () => {
  it("labels wiki builds as manual builds", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({ wiki_build: true, repository_name: "web" }),
    }));
    expect(screen.getByText("Manual Build")).toBeInTheDocument();
  });

  it("labels wiki builds as 手动构建 in Chinese", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({ wiki_build: true }),
    }), "zh-Hans");
    expect(screen.getByText("手动构建")).toBeInTheDocument();
  });

  it("labels merged change events", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({ event_type: "change.merged" }),
    }));
    expect(screen.getByText("PR/MR Merged")).toBeInTheDocument();
  });

  it("labels default-branch updates", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({ event_type: "default_branch.updated" }),
    }));
    expect(screen.getByText("Default Branch Updated")).toBeInTheDocument();
  });

  it("falls back to the generic code-event label without a trigger summary", () => {
    renderRun(makeRun({ trigger_summary: null }));
    expect(screen.getByText("Code Event")).toBeInTheDocument();
  });

  it("falls back to the generic code-event label for unknown event types", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({ event_type: "pipeline.exploded" }),
    }));
    expect(screen.getByText("Code Event")).toBeInTheDocument();
  });

  it("keeps the existing manual label for manual runs", () => {
    renderRun(makeRun({ source: "manual" }));
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });
});

describe("RunRow SCM details", () => {
  it("shows repository, change number + title, target branch and short SHA", () => {
    renderRun(makeRun({
      trigger_summary: makeSummary({
        event_type: "change.merged",
        repository_name: "web",
        change_number: 42,
        change_title: "Fix login flow",
        target_branch: "main",
        source_revision: "abc1234def5678",
      }),
    }));
    expect(
      screen.getByText("web · #42 Fix login flow · main · abc1234"),
    ).toBeInTheDocument();
  });

  it("keeps failure rows on a concise truncated summary with the full reason as title", () => {
    const reason = "atlas build failed: " + "x".repeat(300);
    renderRun(makeRun({
      status: "failed",
      failure_reason: reason,
      trigger_summary: makeSummary({ event_type: "change.merged", repository_name: "web" }),
    }));
    const failure = screen.getByText(reason);
    expect(failure).toHaveAttribute("title", reason);
    // Failure summary wins the middle column over SCM details.
    expect(screen.queryByText(/web ·/)).not.toBeInTheDocument();
  });

  it("shows the transcript entry for runs with a task", () => {
    renderRun(makeRun({
      task_id: "task-1",
      trigger_summary: makeSummary({ wiki_build: true }),
    }));
    expect(screen.getByRole("button", { name: "View execution log" })).toBeInTheDocument();
  });
});

describe("formatTriggerSummaryDetail", () => {
  it("skips missing pieces", () => {
    expect(formatTriggerSummaryDetail(makeSummary({
      repository_name: "web",
      source_revision: "deadbeef42",
    }))).toBe("web · deadbee");
    expect(formatTriggerSummaryDetail(makeSummary())).toBe("");
  });

  it("renders a change number without a title", () => {
    expect(formatTriggerSummaryDetail(makeSummary({
      change_number: 7,
      target_branch: "develop",
    }))).toBe("#7 · develop");
  });
});
