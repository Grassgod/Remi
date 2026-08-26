import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { DashboardEndpoints } from "./dashboard";
import { RuntimesEndpoints } from "./runtimes";

// ---------------------------------------------------------------------------
// MUL-93 — endpoint-level contract wiring. The schema tests prove the strict
// schemas reject drifted rows; these prove the endpoints actually THROW
// ApiContractError on a malformed 2xx body (→ TanStack Query `isError` → the
// pages' explicit unavailable states) instead of resolving to a fallback that
// the UI would render as fabricated zeros.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const http = () => new HttpClient("https://api.example.test");

// The drifted-wire shape from MUL-91/MUL-92: the server serialized store
// rows (camelCase) directly. Lenient schemas used to coerce this to all
// zeros; it must now fail the contract.
const CAMEL_CASE_DAILY_ROW = {
  date: "2026-05-19",
  model: "claude-opus-4-7",
  inputTokens: 100,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  taskCount: 1,
};

const VALID_DAILY_ROW = {
  date: "2026-05-19",
  model: "claude-opus-4-7",
  input_tokens: 100,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 105,
  task_count: 1,
};

describe("DashboardEndpoints strict contract (MUL-93)", () => {
  it("throws ApiContractError on a camelCase (drifted) usage/daily body", async () => {
    stubFetch([CAMEL_CASE_DAILY_ROW]);
    const endpoints = new DashboardEndpoints(http());
    await expect(
      endpoints.getDashboardUsageDaily({ days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("throws ApiContractError when a numeric field is missing", async () => {
    stubFetch([{ date: "2026-05-19", model: "m", input_tokens: 1 }]);
    const endpoints = new DashboardEndpoints(http());
    await expect(
      endpoints.getDashboardUsageDaily({ days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("throws ApiContractError on drifted by-agent / runtime rollups", async () => {
    const endpoints = new DashboardEndpoints(http());

    stubFetch([{ model: "m", input_tokens: 1 }]); // missing agent_id + fields
    await expect(
      endpoints.getDashboardUsageByAgent({ days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);

    // agent-runtime returning date-bucketed rows (the listRuntimeDaily
    // mix-up) has no agent_id — must fail, not collapse to agent_id "".
    stubFetch([{ date: "2026-05-19", totalSeconds: 42, taskCount: 3, failedCount: 0 }]);
    await expect(
      endpoints.getDashboardAgentRunTime({ days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);

    stubFetch([{ date: "2026-05-19", total_seconds: 42 }]); // missing counts
    await expect(
      endpoints.getDashboardRunTimeDaily({ days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("resolves a valid snake_case body and an empty array (real zero)", async () => {
    const endpoints = new DashboardEndpoints(http());

    stubFetch([VALID_DAILY_ROW]);
    await expect(
      endpoints.getDashboardUsageDaily({ days: 30 }),
    ).resolves.toEqual([VALID_DAILY_ROW]);

    stubFetch([]);
    await expect(
      endpoints.getDashboardUsageDaily({ days: 30 }),
    ).resolves.toEqual([]);
  });
});

describe("RuntimesEndpoints usage strict contract (MUL-93)", () => {
  it("throws ApiContractError when runtime usage rows miss token fields", async () => {
    stubFetch([{ date: "2026-05-19" }]);
    const endpoints = new RuntimesEndpoints(http());
    await expect(
      endpoints.getRuntimeUsage("r-1", { days: 180 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("throws ApiContractError on a non-array runtime usage body", async () => {
    stubFetch({ rows: [] });
    const endpoints = new RuntimesEndpoints(http());
    await expect(
      endpoints.getRuntimeUsage("r-1", { days: 180 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("throws ApiContractError when by-agent rows miss fields", async () => {
    stubFetch([{ model: "m" }]);
    const endpoints = new RuntimesEndpoints(http());
    await expect(
      endpoints.getRuntimeUsageByAgent("r-1", { days: 30 }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("resolves valid runtime usage rows and empty arrays", async () => {
    const endpoints = new RuntimesEndpoints(http());
    const row = {
      runtime_id: "r-1",
      date: "2026-05-19",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    stubFetch([row]);
    await expect(
      endpoints.getRuntimeUsage("r-1", { days: 180 }),
    ).resolves.toEqual([row]);

    stubFetch([]);
    await expect(
      endpoints.getRuntimeUsage("r-1", { days: 180 }),
    ).resolves.toEqual([]);
  });
});
