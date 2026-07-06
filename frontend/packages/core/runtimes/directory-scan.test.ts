import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDirectoryScanRequest } from "../types";

const mockInitiate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  api: {
    initiateDirectoryScan: (...args: unknown[]) => mockInitiate(...args),
    getDirectoryScanResult: (...args: unknown[]) => mockGet(...args),
  },
}));

import { resolveRuntimeDirectoryScan } from "./directory-scan";

function req(
  overrides: Partial<RuntimeDirectoryScanRequest> = {},
): RuntimeDirectoryScanRequest {
  return {
    id: "rds-1",
    runtime_id: "runtime-1",
    status: "pending",
    params: {},
    candidates: [],
    supported: true,
    error: null,
    run_started_at: null,
    created_at: "2026-04-16T00:00:00Z",
    updated_at: "2026-04-16T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("resolveRuntimeDirectoryScan", () => {
  it("resolves without polling when the initiate call is already terminal", async () => {
    const candidate = {
      path: "/home/dev/repo",
      name: "repo",
      remote_url: "git@github.com:org/repo.git",
      current_branch: "main",
      is_dirty: null,
    };
    mockInitiate.mockResolvedValueOnce(
      req({ status: "completed", candidates: [candidate] }),
    );

    const result = await resolveRuntimeDirectoryScan("runtime-1", { root: "~" });

    expect(mockInitiate).toHaveBeenCalledWith("runtime-1", { root: "~" });
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.candidates).toEqual([candidate]);
  });

  it("polls through pending/running until the request completes", async () => {
    mockInitiate.mockResolvedValueOnce(req({ status: "pending" }));
    mockGet
      .mockResolvedValueOnce(req({ status: "running" }))
      .mockResolvedValueOnce(req({ status: "completed" }));

    const result = await resolveRuntimeDirectoryScan("runtime-1");

    expect(result.status).toBe("completed");
    // Polled twice (running, then completed) — the poll loop keeps going
    // while the status is non-terminal and stops the moment it terminates.
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledWith("runtime-1", "rds-1");
  });

  it("throws the server error and stops polling when the request fails", async () => {
    mockInitiate.mockResolvedValueOnce(req({ status: "pending" }));
    mockGet.mockResolvedValueOnce(
      req({ status: "failed", error: "root does not exist" }),
    );

    await expect(resolveRuntimeDirectoryScan("runtime-1")).rejects.toThrow(
      "root does not exist",
    );
    // Terminal on the first poll — no further requests are issued.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("throws on a server-set timeout status so its update-daemon message surfaces", async () => {
    mockInitiate.mockResolvedValueOnce(req({ status: "pending" }));
    mockGet.mockResolvedValueOnce(
      req({
        status: "timeout",
        error: "scan did not start; the runtime daemon may need updating",
      }),
    );

    await expect(resolveRuntimeDirectoryScan("runtime-1")).rejects.toThrow(
      /daemon may need updating/,
    );
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  // Client-side ceiling. It must exceed the server's own pending (180s) +
  // running (60s) budgets so the server's timeout status/message wins the
  // race in the common case; this test only asserts the client eventually
  // gives up if the request never terminates at all.
  it("gives up with a timeout error if the request never terminates", async () => {
    vi.useFakeTimers();
    mockInitiate.mockResolvedValueOnce(req({ status: "pending" }));
    mockGet.mockResolvedValue(req({ status: "pending" }));

    const promise = resolveRuntimeDirectoryScan("runtime-1");
    // Fail the assertion path if the promise rejects for another reason.
    const settled = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(280_000);
    await settled;
  });
});
