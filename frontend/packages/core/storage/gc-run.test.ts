import { afterEach, describe, expect, it, vi } from "vitest";
import type { GcRunRequest } from "@multiremi/contracts/storage";

const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  api: {
    createRuntimeGcRun: (...args: unknown[]) => mockCreate(...args),
    getRuntimeGcRun: (...args: unknown[]) => mockGet(...args),
  },
}));

import { resolveRuntimeGcRun } from "./gc-run";

function run(overrides: Partial<GcRunRequest> = {}): GcRunRequest {
  return {
    id: "gcr_1", runtime_id: "runtime-1", daemon_id: "daemon-1", mode: "dry_run", status: "pending",
    requested_by: "user-1", created_at: "2026-10-13T00:00:00Z", completed_at: null, error: null, report: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("resolveRuntimeGcRun", () => {
  it("polls through pending, sent and running until the report arrives", async () => {
    vi.useFakeTimers();
    mockCreate.mockResolvedValueOnce(run({ status: "pending" }));
    mockGet
      .mockResolvedValueOnce(run({ status: "sent" }))
      .mockResolvedValueOnce(run({ status: "running" }))
      .mockResolvedValueOnce(run({ status: "completed" }));

    const promise = resolveRuntimeGcRun("runtime-1", "dry_run");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toMatchObject({ status: "completed" });

    expect(mockCreate).toHaveBeenCalledWith("runtime-1", { mode: "dry_run" });
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet).toHaveBeenCalledWith("runtime-1", "gcr_1");
  });

  it("returns an already finished run without polling", async () => {
    mockCreate.mockResolvedValueOnce(run({ status: "completed", mode: "run" }));
    await expect(resolveRuntimeGcRun("runtime-1", "run")).resolves.toMatchObject({ mode: "run" });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each(["failed", "timeout"] as const)("throws the server error when the run %s", async (status) => {
    vi.useFakeTimers();
    mockCreate.mockResolvedValueOnce(run());
    mockGet.mockResolvedValueOnce(run({ status, error: "daemon went away" }));

    const settled = expect(resolveRuntimeGcRun("runtime-1", "run")).rejects.toThrow("daemon went away");
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("gives up when the run never terminates", async () => {
    vi.useFakeTimers();
    mockCreate.mockResolvedValueOnce(run());
    mockGet.mockResolvedValue(run({ status: "running" }));

    const settled = expect(resolveRuntimeGcRun("runtime-1", "dry_run")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(22 * 60 * 1000);
    await settled;
  });
});
