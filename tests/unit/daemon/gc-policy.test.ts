import { describe, expect, it } from "bun:test";
import { resolveWorkspaceGcPolicy } from "@daemon/agent-runtime/workspace/gc-policy.js";

describe("workspace GC policy", () => {
  const fallback = { ttlMs: 72 * 60 * 60 * 1000, intervalMs: 15 * 60 * 1000 };

  it("uses the persisted Session archive settings", () => {
    expect(resolveWorkspaceGcPolicy({
      session_archive: {
        workspace_ttl_ms: 7 * 24 * 60 * 60 * 1000,
        gc_interval_ms: 30 * 60 * 1000,
      },
    }, fallback)).toEqual({
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 30 * 60 * 1000,
    });
  });

  it("rejects values outside the server-enforced bounds", () => {
    expect(resolveWorkspaceGcPolicy({
      session_archive: {
        workspace_ttl_ms: 1,
        gc_interval_ms: 0,
      },
    }, fallback)).toEqual(fallback);
  });

  it("never accepts an interval longer than the effective TTL", () => {
    expect(resolveWorkspaceGcPolicy({
      session_archive: {
        workspace_ttl_ms: 2 * 60 * 60 * 1000,
        gc_interval_ms: 3 * 60 * 60 * 1000,
      },
    }, fallback)).toEqual({
      ttlMs: 2 * 60 * 60 * 1000,
      intervalMs: 15 * 60 * 1000,
    });
  });
});
