import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { IssuesEndpoints } from "./issues";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const workspace = {
  issue_id: "issue-1",
  workspace_id: "ws-1",
  issue_key: "MUL-1",
  runtime_id: "runtime-1",
  runtime_name: "claude (legacy-host)",
  runtime_status: "online",
  root_path: "/tmp/MUL-1",
  branch_name: "agent/MUL-1",
  status: "ready",
  repos: [],
  last_task_id: null,
  cleaned_at: null,
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

const parentDoneGrant = {
  granted_at: "2026-09-28T08:00:00.000Z",
  granted_by: "member-1",
  agent_id: "agent-1",
  effective: true,
  ineffective_reason: null,
};

const issue = {
  id: "issue-1",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "Parent issue",
  description: "Detail",
  status: "in_progress",
  priority: "medium",
  assignee_type: "agent",
  assignee_id: "agent-1",
  creator_type: "member",
  creator_id: "member-1",
  parent_issue_id: null,
  parent_done_grant_at: parentDoneGrant.granted_at,
  parent_done_grant_by: parentDoneGrant.granted_by,
  parent_done_grant_agent_id: parentDoneGrant.agent_id,
  parent_done_grant: parentDoneGrant,
  pending_decision_count: 1,
  project_id: null,
  position: 0,
  start_date: null,
  due_date: null,
  metadata: {},
  created_at: "2026-09-28T07:00:00.000Z",
  updated_at: "2026-09-28T08:00:00.000Z",
};

const decisionAnswer = {
  answererType: "member",
  answererId: "member-1",
  answer: "Ship it",
  reason: "Checks passed",
  overturn: null,
  answeredAt: "2026-09-28T08:05:00.000Z",
};

const decision = {
  id: "decision-1",
  workspaceId: "ws-1",
  issueId: "issue-1",
  sourceIssueId: "issue-child",
  sourceTaskId: "task-1",
  kind: "merge",
  title: "Merge the change",
  body: "All checks passed.",
  options: ["Ship it", "Wait"],
  status: "answered",
  answer: decisionAnswer,
  answeredByMemberId: "member-1",
  answeredAt: decisionAnswer.answeredAt,
  history: [decisionAnswer],
  ownerAgentId: "agent-1",
  createdByAgentId: "agent-child",
  createdAt: "2026-09-28T07:30:00.000Z",
  updatedAt: decisionAnswer.answeredAt,
};

const decisionEntry = {
  id: decision.id,
  bucket: "answered",
  type: "decision",
  kind: decision.kind,
  title: decision.title,
  body: decision.body,
  status: decision.status,
  issueId: decision.issueId,
  sourceIssueId: decision.sourceIssueId,
  sourceTaskId: decision.sourceTaskId,
  options: decision.options,
  answer: decisionAnswer,
  history: [decisionAnswer],
  createdAt: decision.createdAt,
  updatedAt: decision.updatedAt,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssuesEndpoints issue workspace response schema", () => {
  it("defaults machine metadata from an older server to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ workspace })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({
      workspace: {
        ...workspace,
        runtime_provider: null,
        runtime_mode: null,
        runtime_device_info: null,
        runtime_daemon_id: null,
        runtime_machine_name: null,
      },
    });
  });

  it("falls back without throwing when machine metadata is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      workspace: { ...workspace, runtime_machine_name: 42 },
    })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({ workspace: null });
  });
});

describe("IssuesEndpoints batch updates", () => {
  it("accepts both the legacy success body and per-row dependency skips", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ updated: 2 }))
      .mockResolvedValueOnce(jsonResponse({ updated: 1, skipped: [{ issueId: "issue-2", error: "waiting", code: "dependencies_unmet" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.batchUpdateIssues(["issue-1", "issue-2"], { status: "todo" }))
      .resolves.toEqual({ updated: 2, skipped: [] });
    await expect(endpoints.batchUpdateIssues(["issue-1", "issue-2"], { status: "todo" }))
      .resolves.toEqual({ updated: 1, skipped: [{ issueId: "issue-2", error: "waiting", code: "dependencies_unmet" }] });
  });
});

describe("IssuesEndpoints decision and parent-done detail contracts", () => {
  it("parses the detail-only decision count and derived parent-done grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(issue)));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssue("issue-1")).resolves.toMatchObject({
      pending_decision_count: 1,
      parent_done_grant: parentDoneGrant,
      parent_done_grant_at: parentDoneGrant.granted_at,
      parent_done_grant_by: parentDoneGrant.granted_by,
      parent_done_grant_agent_id: parentDoneGrant.agent_id,
    });
  });

  it("lists decisions and posts the complete member answer body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        waiting_on_human: [],
        owner_and_answered: { pending: [], answered: [decisionEntry] },
        count: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({ decision }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.listIssueDecisions("issue-1")).resolves.toMatchObject({
      count: 0,
      owner_and_answered: { answered: [decisionEntry] },
    });
    await expect(endpoints.answerIssueDecision("issue-1", "decision-1", {
      answer: "Ship it",
      reason: "Checks passed",
      overturn: null,
    })).resolves.toEqual(decision);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/issues/issue-1/decisions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example.test/api/issues/issue-1/decisions/decision-1/answer");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ answer: "Ship it", reason: "Checks passed", overturn: null }),
    });
  });

  it("uses the native empty-body grant routes and returns their derived state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ issue: {}, parent_done_grant: parentDoneGrant }))
      .mockResolvedValueOnce(jsonResponse({ issue: {}, parent_done_grant: null }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.grantParentDone("issue-1")).resolves.toEqual(parentDoneGrant);
    await expect(endpoints.revokeParentDone("issue-1")).resolves.toBeNull();

    expect(fetchMock.mock.calls.map(([url, init]) => [
      url,
      (init as RequestInit).method,
      (init as RequestInit).body,
    ])).toEqual([
      ["https://api.example.test/api/multiremi/issues/issue-1/parent-done-grant", "POST", undefined],
      ["https://api.example.test/api/multiremi/issues/issue-1/parent-done-grant", "DELETE", undefined],
    ]);
  });
});
