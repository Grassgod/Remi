import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../types";
import { deriveRuntimeHealth } from "./derive-health";

const FIXED_NOW = new Date("2026-04-27T12:00:00Z").getTime();

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-1",
    name: "Test Runtime",
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "",
    metadata: {},
    owner_id: null,
    visibility: "private",
    last_seen_at: new Date(FIXED_NOW - 10_000).toISOString(),
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("deriveRuntimeHealth", () => {
  it("returns online when status is online and the heartbeat is fresh", () => {
    expect(
      deriveRuntimeHealth(makeRuntime({ status: "online" }), FIXED_NOW),
    ).toBe("online");
  });

  it("does not return online when status is online but the heartbeat is stale", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({
          status: "online",
          last_seen_at: new Date(FIXED_NOW - 10 * 60_000).toISOString(),
        }),
        FIXED_NOW,
      ),
    ).toBe("offline");
  });

  it("returns recently_lost when offline less than 5 minutes", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({
          status: "offline",
          last_seen_at: new Date(FIXED_NOW - 2 * 60_000).toISOString(),
        }),
        FIXED_NOW,
      ),
    ).toBe("recently_lost");
  });

  it("returns offline when offline between 5 minutes and 6 days", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({
          status: "offline",
          last_seen_at: new Date(FIXED_NOW - 60 * 60_000).toISOString(), // 1 hour
        }),
        FIXED_NOW,
      ),
    ).toBe("offline");
  });

  it("returns about_to_gc when offline beyond 6 days (within 1 day of GC)", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({
          status: "offline",
          last_seen_at: new Date(FIXED_NOW - 6.5 * 24 * 3600_000).toISOString(),
        }),
        FIXED_NOW,
      ),
    ).toBe("about_to_gc");
  });

  it("treats a missing last_seen_at as offline", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({ status: "online", last_seen_at: null }),
        FIXED_NOW,
      ),
    ).toBe("offline");
  });

  it.each([
    { ageMs: 5 * 60_000 - 1_000, expected: "online" },
    { ageMs: 5 * 60_000, expected: "online" },
    { ageMs: 5 * 60_000 + 1_000, expected: "offline" },
  ] as const)(
    "returns $expected for an online status with a heartbeat age of $ageMs ms",
    ({ ageMs, expected }) => {
      expect(
        deriveRuntimeHealth(
          makeRuntime({
            status: "online",
            last_seen_at: new Date(FIXED_NOW - ageMs).toISOString(),
          }),
          FIXED_NOW,
        ),
      ).toBe(expected);
    },
  );

  it("returns recently_lost for an offline status with a heartbeat just inside the threshold", () => {
    expect(
      deriveRuntimeHealth(
        makeRuntime({
          status: "offline",
          last_seen_at: new Date(FIXED_NOW - (5 * 60_000 - 1_000)).toISOString(),
        }),
        FIXED_NOW,
      ),
    ).toBe("recently_lost");
  });
});
