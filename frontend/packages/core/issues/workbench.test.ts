import { describe, it, expect } from "vitest";
import { partitionReviewIssues } from "./workbench";
import type { AgentTask, Issue } from "../types";

function issue(id: string): Issue {
  return {
    id,
    workspace_id: "ws1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    description: null,
    status: "in_review",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    start_date: null,
    due_date: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function task(issueId: string, status: AgentTask["status"]): AgentTask {
  return {
    id: `task-${issueId}-${status}`,
    agent_id: "agent1",
    issue_id: issueId,
    status,
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
  } as AgentTask;
}

describe("partitionReviewIssues", () => {
  it("splits issues with an awaiting_human task from plain review issues", () => {
    const issues = [issue("a"), issue("b"), issue("c")];
    const snapshot = [task("b", "awaiting_human"), task("c", "completed")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput.map((i) => i.id)).toEqual(["b"]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("ignores non-awaiting task statuses", () => {
    const issues = [issue("a")];
    const snapshot = [task("a", "running"), task("a", "queued"), task("a", "completed")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a"]);
  });

  it("preserves input order within each bucket", () => {
    const issues = [issue("a"), issue("b"), issue("c"), issue("d")];
    const snapshot = [task("d", "awaiting_human"), task("a", "awaiting_human")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput.map((i) => i.id)).toEqual(["a", "d"]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("handles an empty snapshot", () => {
    const { awaitingInput, awaitingReview } = partitionReviewIssues([issue("a")], []);
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview).toHaveLength(1);
  });
});
