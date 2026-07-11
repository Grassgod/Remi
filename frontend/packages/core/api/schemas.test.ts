import { describe, expect, it } from "vitest";
import {
  CliLatestVersionResponseSchema,
  DashboardAgentRunTimeListSchema,
  DashboardUsageByAgentListSchema,
  DashboardUsageDailyListSchema,
  DuplicateIssueErrorBodySchema,
  EMPTY_CLI_LATEST_VERSION,
  EMPTY_FLEET_MODELS,
  FleetModelsResponseSchema,
  EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
  EMPTY_TIMELINE_ENTRIES,
  EMPTY_USER,
  ListIssuesResponseSchema,
  RuntimeDirectoryScanRequestSchema,
  RuntimeHourlyActivityListSchema,
  RuntimeUsageByAgentListSchema,
  RuntimeUsageByHourListSchema,
  RuntimeUsageListSchema,
  SquadListSchema,
  SquadSchema,
  TimelineEntriesSchema,
  UserSchema,
} from "./schemas";
import { parseWithFallback } from "./schema";

const baseIssue = {
  id: "11111111-1111-1111-1111-111111111111",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "Test",
  description: null,
  status: "todo",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 0,
  start_date: null,
  due_date: null,
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("IssueSchema (via ListIssuesResponseSchema)", () => {
  it("accepts a primitive metadata KV map", () => {
    const payload = {
      issues: [
        {
          ...baseIssue,
          metadata: { pipeline_status: "waiting", pr_number: 3, is_blocked: true },
        },
      ],
      total: 1,
    };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.metadata).toEqual({
      pipeline_status: "waiting",
      pr_number: 3,
      is_blocked: true,
    });
  });

  it("defaults metadata to {} when the server omits it (older backend)", () => {
    const { metadata: _omit, ...issueWithoutMetadata } = baseIssue;
    const payload = { issues: [issueWithoutMetadata], total: 1 };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.metadata).toEqual({});
  });

  it("rejects metadata with non-primitive values (nested object)", () => {
    const payload = {
      issues: [{ ...baseIssue, metadata: { nested: { x: 1 } } }],
      total: 1,
    };
    expect(ListIssuesResponseSchema.safeParse(payload).success).toBe(false);
  });
});

// The duplicate-issue branch in create-issue.tsx feeds ApiError.body
// (typed as `unknown`) through this schema. Any future server drift that
// loses the contract MUST fail the parse so the UI falls back to a normal
// error toast instead of rendering an empty / partial duplicate card.
describe("DuplicateIssueErrorBodySchema", () => {
  const valid = {
    code: "active_duplicate_issue",
    error: "An active issue with this title already exists: MUL-12 – Login bug",
    issue: {
      id: "11111111-1111-1111-1111-111111111111",
      identifier: "MUL-12",
      title: "Login bug",
    },
  };

  it("accepts a well-formed body", () => {
    expect(DuplicateIssueErrorBodySchema.safeParse(valid).success).toBe(true);
  });

  it("accepts unknown extra fields via .loose()", () => {
    const forwardCompat = {
      ...valid,
      hint: "Try a different title",
      issue: { ...valid.issue, workspace_id: "ws-1", status: "todo" },
    };
    expect(DuplicateIssueErrorBodySchema.safeParse(forwardCompat).success).toBe(true);
  });

  it("rejects a renamed code (so renames degrade to the generic toast)", () => {
    const renamed = { ...valid, code: "duplicate_issue" };
    expect(DuplicateIssueErrorBodySchema.safeParse(renamed).success).toBe(false);
  });

  it("rejects a missing issue object", () => {
    const { issue: _omit, ...without } = valid;
    expect(DuplicateIssueErrorBodySchema.safeParse(without).success).toBe(false);
  });

  it("rejects a non-string issue.id", () => {
    const broken = { ...valid, issue: { ...valid.issue, id: 42 } };
    expect(DuplicateIssueErrorBodySchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a missing error field (it is optional)", () => {
    const { error: _omit, ...without } = valid;
    expect(DuplicateIssueErrorBodySchema.safeParse(without).success).toBe(true);
  });
});

// `user.timezone` (Viewing tz) was added in the timezone-architecture RFC.
// A desktop build older than the server — or a server predating the
// `user.timezone` migration — will return a `/api/me` body with no
// `timezone` key. The schema must not fail closed on that: the field
// defaults to `null`, which the frontend resolves to the browser-detected
// tz at render time.
describe("UserSchema timezone drift", () => {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Ada",
    email: "ada@example.com",
  };

  it("defaults timezone to null when the field is absent", () => {
    const parsed = UserSchema.parse(base);
    expect(parsed.timezone).toBe(null);
  });

  it("preserves an explicit IANA timezone", () => {
    const parsed = UserSchema.parse({ ...base, timezone: "Asia/Tokyo" });
    expect(parsed.timezone).toBe("Asia/Tokyo");
  });

  it("accepts an explicit null timezone", () => {
    const parsed = UserSchema.parse({ ...base, timezone: null });
    expect(parsed.timezone).toBe(null);
  });

  // Wrong-type drift: a future server bug sending `timezone` as a number
  // must not throw into the UI. parseWithFallback degrades the whole user
  // object to the explicit fallback (EMPTY_USER) so /api/me callers keep a
  // valid shape instead of white-screening.
  it("falls back to EMPTY_USER when timezone is the wrong type", () => {
    const parsed = parseWithFallback(
      { ...base, timezone: 42 },
      UserSchema,
      EMPTY_USER,
      { endpoint: "GET /api/me" },
    );
    expect(parsed).toBe(EMPTY_USER);
  });
});

describe("SquadListSchema member preview drift", () => {
  const baseSquad = {
    id: "squad-1",
    workspace_id: "ws-1",
    name: "Frontend Squad",
    description: "",
    instructions: "",
    avatar_url: null,
    leader_id: "agent-1",
    creator_id: "user-1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
  };

  it("defaults preview fields when an older backend omits them", () => {
    const parsed = SquadListSchema.parse([baseSquad]);
    expect(parsed[0]?.member_count).toBe(0);
    expect(parsed[0]?.member_preview).toEqual([]);
  });

  it("defaults preview fields on a single squad response", () => {
    const parsed = SquadSchema.parse(baseSquad);
    expect(parsed.member_count).toBe(0);
    expect(parsed.member_preview).toEqual([]);
  });

  it("preserves lightweight member preview rows", () => {
    const parsed = SquadListSchema.parse([
      {
        ...baseSquad,
        member_count: 2,
        member_preview: [
          { member_type: "agent", member_id: "agent-1", role: "leader" },
          { member_type: "member", member_id: "user-2", role: "member" },
        ],
      },
    ]);
    expect(parsed[0]?.member_count).toBe(2);
    expect(parsed[0]?.member_preview).toHaveLength(2);
    expect(parsed[0]?.member_preview?.[0]?.role).toBe("leader");
  });
});

// The workspace dashboard and runtime-detail pages were re-pointed at the
// unified `task_usage_hourly` rollup. Every numeric field drives chart /
// KPI math, and string keys (date / agent_id / model) bucket the series.
// The contract these schemas must hold: a row missing a field degrades
// that field to a sane default rather than dropping the WHOLE array to
// the `[]` fallback — one drifted row must not blank the entire chart.
describe("dashboard + runtime usage schema drift", () => {
  it("coerces a missing numeric field to 0 instead of dropping the array", () => {
    const parsed = DashboardUsageDailyListSchema.parse([
      { date: "2026-05-19", model: "claude-opus-4-7", input_tokens: 100 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.output_tokens).toBe(0);
    expect(parsed[0]?.cache_read_tokens).toBe(0);
    expect(parsed[0]?.cache_write_tokens).toBe(0);
  });

  it("coerces a missing date key to \"\" so the rest of the series survives", () => {
    const parsed = DashboardUsageDailyListSchema.parse([
      { model: "claude-opus-4-7", input_tokens: 5 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.date).toBe("");
  });

  it("coerces a missing agent_id key to \"\" for the agent-runtime panel", () => {
    const parsed = DashboardAgentRunTimeListSchema.parse([
      { total_seconds: 42, task_count: 3, failed_count: 0 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.agent_id).toBe("");
  });

  it("coerces a missing agent_id key to \"\" for the usage-by-agent panel", () => {
    const parsed = DashboardUsageByAgentListSchema.parse([
      { model: "claude-opus-4-7", input_tokens: 7 },
    ]);
    expect(parsed[0]?.agent_id).toBe("");
  });

  it("coerces missing fields on every runtime usage schema", () => {
    expect(RuntimeUsageListSchema.parse([{ date: "2026-05-19" }])[0]?.input_tokens).toBe(0);
    expect(RuntimeHourlyActivityListSchema.parse([{ hour: 9 }])[0]?.count).toBe(0);
    expect(RuntimeUsageByAgentListSchema.parse([{ model: "x" }])[0]?.agent_id).toBe("");
    expect(RuntimeUsageByHourListSchema.parse([{ hour: 9 }])[0]?.model).toBe("");
  });

  it("rejects a non-array body so parseWithFallback can return its fallback", () => {
    expect(DashboardUsageDailyListSchema.safeParse(null).success).toBe(false);
    expect(RuntimeUsageListSchema.safeParse({ rows: [] }).success).toBe(false);
  });

  it("keeps unknown server-side fields via .loose()", () => {
    const parsed = RuntimeUsageListSchema.parse([
      { date: "2026-05-19", region: "us-east" },
    ]);
    expect((parsed[0] as Record<string, unknown>).region).toBe("us-east");
  });
});

// The activity feed renders whatever /timeline validates; a single bad entry
// used to blank the ENTIRE feed via the array-level fallback. System
// activities (issue_assigned, issue_updated) legitimately carry
// actor_id: null — this is the production shape that hid comments for days.
describe("TimelineEntriesSchema null actor_id", () => {
  const opts = { endpoint: "GET /api/issues/:id/timeline" };
  const productionShape = [
    {
      type: "activity",
      id: "act_1",
      actor_type: "system",
      actor_id: "local",
      created_at: "2026-07-11T16:28:35.517Z",
      action: "issue_created",
      details: { priority: "none" },
    },
    {
      type: "activity",
      id: "act_2",
      actor_type: "system",
      actor_id: null,
      created_at: "2026-07-11T16:28:35.547Z",
      action: "issue_assigned",
      details: { assignee_type: "agent", assignee_id: "agt_1" },
    },
    {
      type: "comment",
      id: "cmt_1",
      actor_type: "agent",
      actor_id: "agt_1",
      created_at: "2026-07-11T16:41:14.000Z",
      content: "Remi 是一个 AI 消息路由器。",
      parent_id: null,
      updated_at: "2026-07-11T16:41:14.000Z",
      comment_type: "comment",
      reactions: [],
      attachments: [],
      resolved_at: null,
      resolved_by_type: null,
      resolved_by_id: null,
    },
  ];

  it("keeps the feed when a system activity has actor_id null", () => {
    const parsed = parseWithFallback(productionShape, TimelineEntriesSchema, EMPTY_TIMELINE_ENTRIES, opts);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toMatchObject({ action: "issue_assigned", actor_id: "" });
    expect(parsed[2]).toMatchObject({ type: "comment", content: "Remi 是一个 AI 消息路由器。" });
  });
});

describe("CliLatestVersionResponseSchema", () => {
  it("parses a valid version payload", () => {
    const parsed = parseWithFallback(
      { version: "v0.2.3" },
      CliLatestVersionResponseSchema,
      EMPTY_CLI_LATEST_VERSION,
      { endpoint: "test" },
    );
    expect(parsed.version).toBe("v0.2.3");
  });

  it("parses an explicit null version (repo not configured)", () => {
    const parsed = parseWithFallback(
      { version: null },
      CliLatestVersionResponseSchema,
      EMPTY_CLI_LATEST_VERSION,
      { endpoint: "test" },
    );
    expect(parsed.version).toBeNull();
  });

  it("falls back on malformed bodies (missing field, wrong type, array)", () => {
    for (const bad of [{}, { version: 7 }, [], "v1", null]) {
      const parsed = parseWithFallback(
        bad,
        CliLatestVersionResponseSchema,
        EMPTY_CLI_LATEST_VERSION,
        { endpoint: "test" },
      );
      expect(parsed.version).toBeNull();
    }
  });
});

// The runtime directory-scan row is polled by resolveRuntimeDirectoryScan
// until it terminates. A malformed row must degrade — either to a graceful
// default (empty candidates) or to the explicit failed fallback — but never
// throw into the poll loop, and unknown terminal states must survive so the
// loop's default branch can stop instead of spinning forever.
describe("RuntimeDirectoryScanRequestSchema", () => {
  const opts = { endpoint: "GET /api/runtimes/:id/directory-scans/:requestId" };
  const valid = {
    id: "rds-1",
    runtime_id: "runtime-1",
    status: "completed",
    params: { root: "~", max_depth: 3 },
    candidates: [
      {
        path: "/home/dev/repo",
        name: "repo",
        remote_url: "git@github.com:org/repo.git",
        current_branch: "main",
        is_dirty: null,
      },
    ],
    supported: true,
    error: null,
    run_started_at: "2026-04-16T00:00:00Z",
    created_at: "2026-04-16T00:00:00Z",
    updated_at: "2026-04-16T00:00:01Z",
  };

  it("parses a well-formed row and preserves candidates", () => {
    const parsed = parseWithFallback(
      valid,
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.path).toBe("/home/dev/repo");
    expect(parsed.candidates[0]?.remote_url).toBe("git@github.com:org/repo.git");
  });

  it("defaults candidates to [] when the field is missing (older daemon)", () => {
    const { candidates: _omit, ...withoutCandidates } = valid;
    const parsed = parseWithFallback(
      withoutCandidates,
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed.candidates).toEqual([]);
    expect(parsed.status).toBe("completed");
  });

  it("tolerates null metadata fields on a candidate", () => {
    const parsed = parseWithFallback(
      {
        ...valid,
        candidates: [
          {
            path: "/home/dev/plain",
            name: "plain",
            remote_url: null,
            current_branch: null,
            is_dirty: null,
          },
        ],
      },
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed.candidates[0]?.remote_url).toBeNull();
    expect(parsed.candidates[0]?.current_branch).toBeNull();
    expect(parsed.candidates[0]?.is_dirty).toBeNull();
  });

  it("keeps an unknown terminal status so the poll loop can stop", () => {
    const parsed = parseWithFallback(
      { ...valid, status: "cancelled" },
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    // status stays z.string(): enum drift degrades, it does not fall back.
    expect(parsed.status).toBe("cancelled");
  });

  it("falls back to the failed shape when status is the wrong type", () => {
    const parsed = parseWithFallback(
      { ...valid, status: 7 },
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed).toBe(EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST);
    expect(parsed.status).toBe("failed");
  });

  it("falls back when candidates is not an array", () => {
    const parsed = parseWithFallback(
      { ...valid, candidates: null },
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed).toBe(EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST);
  });

  it("falls back when a candidate is missing its required path", () => {
    const parsed = parseWithFallback(
      { ...valid, candidates: [{ name: "no-path" }] },
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      opts,
    );
    expect(parsed).toBe(EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST);
  });

  it("falls back when id is missing or malformed", () => {
    for (const bad of [{}, null, { ...valid, id: 42 }]) {
      const parsed = parseWithFallback(
        bad,
        RuntimeDirectoryScanRequestSchema,
        EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
        opts,
      );
      expect(parsed).toBe(EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST);
    }
  });
});

describe("FleetModelsResponseSchema", () => {
  const opts = { endpoint: "GET /api/models (test)" };

  it("parses a well-formed catalog and defaults missing counts / models", () => {
    const parsed = parseWithFallback(
      {
        providers: [
          {
            provider: "claude",
            online_runtime_count: 2,
            models: [{ id: "claude-opus-4-8", label: "Opus 4.8", default: true }],
          },
          // Missing count + models: engine still surfaces with 0 capacity.
          { provider: "codex" },
        ],
      },
      FleetModelsResponseSchema,
      EMPTY_FLEET_MODELS,
      opts,
    );
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers[0]?.models[0]?.id).toBe("claude-opus-4-8");
    expect(parsed.providers[1]?.online_runtime_count).toBe(0);
    expect(parsed.providers[1]?.models).toEqual([]);
  });

  it("defaults a missing providers array instead of crashing the create dialog", () => {
    const parsed = parseWithFallback({}, FleetModelsResponseSchema, EMPTY_FLEET_MODELS, opts);
    expect(parsed.providers).toEqual([]);
  });

  it("falls back to EMPTY_FLEET_MODELS on a wrong-typed payload", () => {
    const parsed = parseWithFallback(
      { providers: [{ provider: 42 }] },
      FleetModelsResponseSchema,
      EMPTY_FLEET_MODELS,
      opts,
    );
    expect(parsed).toBe(EMPTY_FLEET_MODELS);
  });
});
