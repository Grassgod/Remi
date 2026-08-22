import { describe, expect, it } from "vitest";
import {
  deriveChangeRequestProgressSegments,
  deriveChangeRequestStatusKind,
  shouldShowChangeRequestStats,
} from "./change-request-status";

describe("deriveChangeRequestStatusKind", () => {
  it("prioritizes terminal states over transient provider signals", () => {
    expect(deriveChangeRequestStatusKind({
      state: "merged",
      mergeableState: "dirty",
      checksFailed: 2,
    })).toBe("merged");
    expect(deriveChangeRequestStatusKind({
      state: "closed",
      mergeableState: "dirty",
      checksFailed: 2,
    })).toBe("closed");
  });

  it("prioritizes conflicts, failed checks, pending checks, then passed checks", () => {
    expect(deriveChangeRequestStatusKind({
      state: "open",
      mergeableState: "dirty",
      checksPassed: 2,
    })).toBe("conflicts");
    expect(deriveChangeRequestStatusKind({
      state: "open",
      checksFailed: 1,
      checksPending: 1,
    })).toBe("checks_failed");
    expect(deriveChangeRequestStatusKind({
      state: "open",
      checksPending: 1,
      checksPassed: 1,
    })).toBe("checks_pending");
    expect(deriveChangeRequestStatusKind({ state: "open", checksPassed: 1 })).toBe("checks_passed");
  });
});

describe("deriveChangeRequestProgressSegments", () => {
  it("builds ordered proportional segments", () => {
    expect(deriveChangeRequestProgressSegments({
      state: "open",
      checksFailed: 1,
      checksPending: 2,
      checksPassed: 1,
    })).toEqual([
      { kind: "failed", ratio: 0.25 },
      { kind: "pending", ratio: 0.5 },
      { kind: "passed", ratio: 0.25 },
    ]);
  });

  it("hides progress for terminal or unobserved checks", () => {
    expect(deriveChangeRequestProgressSegments({ state: "merged", checksPassed: 1 })).toBeNull();
    expect(deriveChangeRequestProgressSegments({ state: "open" })).toBeNull();
  });
});

describe("shouldShowChangeRequestStats", () => {
  it("only shows stats after the provider reports a non-zero value", () => {
    expect(shouldShowChangeRequestStats({})).toBe(false);
    expect(shouldShowChangeRequestStats({ changedFiles: 1 })).toBe(true);
  });
});
