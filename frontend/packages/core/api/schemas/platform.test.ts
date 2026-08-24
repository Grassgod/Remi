import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../schema";
import { EMPTY_PLATFORM_STATUS, PlatformStatusSchema } from "./platform";

describe("PlatformStatusSchema", () => {
  it("falls back when a newer or broken server returns an invalid collection", () => {
    const result = parseWithFallback(
      { canManage: true, services: null, recentReleases: "broken" },
      PlatformStatusSchema,
      EMPTY_PLATFORM_STATUS,
      { endpoint: "GET /api/multiremi/platform/status" },
    );
    expect(result).toEqual(EMPTY_PLATFORM_STATUS);
  });

  it("defaults missing optional fields without throwing", () => {
    const result = parseWithFallback(
      { canManage: true },
      PlatformStatusSchema,
      EMPTY_PLATFORM_STATUS,
      { endpoint: "GET /api/multiremi/platform/status" },
    );
    expect(result.canManage).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.activeOperation).toBeNull();
    expect(result.lastOperation).toBeNull();
    expect(result.maintenance).toEqual({
      mode: "normal",
      generation: 0,
      operationId: null,
      startedAt: null,
      expiresAt: null,
      reason: null,
    });
  });

  it("parses maintenance state and structured drain operation progress", () => {
    const result = parseWithFallback(
      {
        canManage: true,
        maintenance: {
          mode: "draining",
          generation: 3,
          operationId: "pop-1",
          startedAt: "2026-08-23T01:00:00.000Z",
          expiresAt: "2026-08-23T01:02:00.000Z",
          reason: "platform update to v0.2.47",
        },
        lastOperation: {
          id: "pop-1",
          status: "draining",
          cancelRequested: true,
          progress: {
            drain: {
              generation: 3,
              online_daemons: 5,
              acked_daemons: 3,
              active_tasks: 2,
              waited_ms: 45_000,
              timeout_ms: 900_000,
              state: "waiting",
            },
          },
        },
      },
      PlatformStatusSchema,
      EMPTY_PLATFORM_STATUS,
      { endpoint: "GET /api/multiremi/platform/status" },
    );

    expect(result.maintenance).toMatchObject({
      mode: "draining",
      generation: 3,
      operationId: "pop-1",
    });
    expect(result.lastOperation?.cancelRequested).toBe(true);
    expect(result.lastOperation?.progress).toEqual({
      message: "",
      drain: {
        generation: 3,
        online_daemons: 5,
        acked_daemons: 3,
        active_tasks: 2,
        waited_ms: 45_000,
        timeout_ms: 900_000,
        state: "waiting",
      },
    });
  });
});
