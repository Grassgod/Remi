import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  EMPTY_LIST_AUTOPILOT_RUNS_RESPONSE,
  ListAutopilotRunsResponseSchema,
} from "../api/schemas/autopilots";
import type { AutopilotRun, ListAutopilotRunsResponse } from "../types";
import {
  ACTIVE_RUN_POLL_INTERVAL_MS,
  autopilotRunsRefetchInterval,
  EMPTY_RUNS_POLL_INTERVAL_MS,
} from "./queries";

function run(overrides: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    id: "run-1",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "manual",
    status: "completed",
    issue_id: null,
    issue_session_id: null,
    task_id: null,
    triggered_at: "2026-08-24T00:00:00Z",
    completed_at: null,
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-08-24T00:00:00Z",
    ...overrides,
  };
}

function response(runs: AutopilotRun[]): ListAutopilotRunsResponse {
  return { runs, total: runs.length };
}

describe("autopilotRunsRefetchInterval", () => {
  it("does not poll before the first response arrives", () => {
    expect(autopilotRunsRefetchInterval(undefined)).toBe(false);
  });

  it("polls slowly while the list is empty, waiting for the first run", () => {
    expect(autopilotRunsRefetchInterval(response([]))).toBe(EMPTY_RUNS_POLL_INTERVAL_MS);
  });

  it("polls fast while any run is still active", () => {
    expect(autopilotRunsRefetchInterval(response([
      run({ status: "completed" }),
      run({ id: "run-2", status: "running" }),
    ]))).toBe(ACTIVE_RUN_POLL_INTERVAL_MS);
  });

  it("treats an unknown (future) status as still active", () => {
    expect(autopilotRunsRefetchInterval(response([
      run({ status: "queued" as AutopilotRun["status"] }),
    ]))).toBe(ACTIVE_RUN_POLL_INTERVAL_MS);
  });

  it("stops polling once every run is terminal", () => {
    expect(autopilotRunsRefetchInterval(response([
      run({ status: "completed" }),
      run({ id: "run-2", status: "failed" }),
      run({ id: "run-3", status: "skipped" }),
      run({ id: "run-4", status: "issue_created" }),
    ]))).toBe(false);
  });
});

describe("autopilot run trigger_summary schema", () => {
  const parse = (raw: unknown) =>
    parseWithFallback(raw, ListAutopilotRunsResponseSchema, EMPTY_LIST_AUTOPILOT_RUNS_RESPONSE, {
      endpoint: "test autopilot runs",
    });

  const baseRun = {
    id: "run-1",
    autopilot_id: "ap-1",
    source: "scm_event",
    status: "completed",
    issue_id: null,
    issue_session_id: null,
    task_id: "task-1",
    triggered_at: "2026-08-24T00:00:00Z",
    completed_at: null,
    failure_reason: null,
    created_at: "2026-08-24T00:00:00Z",
  };

  it("parses the slim trigger summary", () => {
    const parsed = parse({
      runs: [{
        ...baseRun,
        trigger_summary: {
          event_type: "change.merged",
          repository_id: "repo-1",
          repository_name: "web",
          change_number: 42,
          change_title: "Fix login flow",
          target_branch: "main",
          source_revision: "abc1234def5678",
          occurred_at: "2026-08-24T00:00:00Z",
          wiki_build: false,
        },
      }],
      total: 1,
    });
    const summary = parsed.runs[0]?.trigger_summary;
    expect(summary?.event_type).toBe("change.merged");
    expect(summary?.change_number).toBe(42);
    expect(summary?.wiki_build).toBe(false);
  });

  it("defaults trigger_summary to null for older servers", () => {
    const parsed = parse({ runs: [baseRun], total: 1 });
    expect(parsed.runs[0]?.trigger_summary).toBeNull();
  });

  it("degrades a malformed trigger_summary to null without dropping the run", () => {
    const parsed = parse({
      runs: [{ ...baseRun, trigger_summary: 42 }],
      total: 1,
    });
    expect(parsed.runs[0]?.id).toBe("run-1");
    expect(parsed.runs[0]?.trigger_summary).toBeNull();
  });
});
