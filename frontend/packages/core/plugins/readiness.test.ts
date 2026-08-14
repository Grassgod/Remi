import { describe, expect, it } from "vitest";
import {
  deriveAgentPluginReadiness,
  summarizeAgentPluginReadiness,
} from "./readiness";

describe("agent plugin readiness", () => {
  it("reports unknown when no desired runtime is available", () => {
    expect(deriveAgentPluginReadiness([])).toBe("unknown");
    expect(
      deriveAgentPluginReadiness([{ status: "ready", desired: false }]),
    ).toBe("unknown");
  });

  it("reports ready when all desired runtimes are ready", () => {
    expect(
      summarizeAgentPluginReadiness([
        { status: "ready" },
        { status: "ready", desired: true },
      ]),
    ).toEqual({
      status: "ready",
      total: 2,
      ready: 2,
      checking: 0,
      setupRequired: 0,
      blocked: 0,
      unknown: 0,
    });
  });

  it("reports partial as soon as at least one desired runtime is ready", () => {
    expect(
      deriveAgentPluginReadiness([
        { status: "ready" },
        { status: "preflight" },
        { status: "setup_required" },
      ]),
    ).toBe("partial");
  });

  it("distinguishes checking, setup, incompatibility, and generic errors", () => {
    expect(deriveAgentPluginReadiness([{ status: "retry_scheduled" }])).toBe(
      "checking",
    );
    expect(deriveAgentPluginReadiness([{ status: "setup_required" }])).toBe(
      "setup_required",
    );
    expect(
      deriveAgentPluginReadiness([
        { status: "blocked", lastErrorCode: "unsupported_runtime" },
      ]),
    ).toBe("incompatible");
    expect(
      deriveAgentPluginReadiness([
        { status: "blocked", lastErrorCode: "download_failed" },
      ]),
    ).toBe("error");
  });

  it("maps future runtime statuses to unknown", () => {
    expect(deriveAgentPluginReadiness([{ status: "future_status" }])).toBe(
      "unknown",
    );
  });
});
