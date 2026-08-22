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
  });
});
