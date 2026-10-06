import { describe, expect, it } from "vitest";
import { formatDeviceInfo, isVersionNewer, isSelfHealingRuntime } from "./utils";
import type { AgentRuntime } from "@multiremi/core/types";

describe("isSelfHealingRuntime", () => {
  const NOW = new Date("2026-01-01T00:10:00Z").getTime();

  function makeRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
    return {
      id: "rt-1",
      workspace_id: "ws-1",
      daemon_id: null,
      name: "rt",
      runtime_mode: "local",
      provider: "claude",
      launch_header: "",
      status: "online",
      device_info: "",
      metadata: {},
      owner_id: null,
      visibility: "private",
      last_seen_at: new Date(NOW - 10_000).toISOString(),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("flags an online local runtime as self-healing", () => {
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "local", status: "online" }),
        NOW,
      ),
    ).toBe(true);
  });

  it("treats an offline local runtime as safe to delete", () => {
    // Daemon isn't running, so the server-side delete is final — no
    // re-registration race to worry about.
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "local", status: "offline" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("treats cloud runtimes as safe to delete regardless of status", () => {
    // Cloud workers are managed by Fleet, not a self-restarting local daemon.
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "cloud", status: "online" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "cloud", status: "offline" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a stale online local runtime as safe to delete", () => {
    expect(
      isSelfHealingRuntime(
        makeRuntime({
          runtime_mode: "local",
          status: "online",
          last_seen_at: new Date(NOW - 10 * 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("Runtime display helpers", () => {
  it("keeps machine names while formatting OS and architecture", () => {
    expect(formatDeviceInfo("my-laptop · darwin-arm64")).toBe("my-laptop · macOS (arm64)");
    expect(formatDeviceInfo(null)).toBeNull();
  });
  it("normalizes release prefixes and compares numeric version components", () => {
    expect(isVersionNewer("v0.3.10", "0.3.9")).toBe(true);
    expect(isVersionNewer("0.3.0", "v0.3.0")).toBe(false);
  });
});
