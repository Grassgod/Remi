import { describe, expect, it } from "vitest";
import type { User } from "../types";
import {
  needsSourceBackfill,
  SOURCE_BACKFILL_MAX_DISMISSALS,
} from "./needs-backfill";

// NOTE: the "where did you hear about us" source-backfill survey is DISABLED
// for this self-host build (see needs-backfill.ts — every path returns false so
// the modal never opens). These cases therefore assert `false` across every
// input shape; they pin the disabled contract so re-enabling the prompt (any
// path returning true) trips the suite. The early-exit guards (no user / not
// onboarded / dismiss cap) and the already-answered cases stay false for their
// original reasons.

const BASE_USER: User = {
  id: "u1",
  name: "User",
  email: "u@example.com",
  avatar_url: null,
  onboarded_at: "2025-01-01T00:00:00Z",
  onboarding_questionnaire: {},
  starter_content_state: "imported",
  language: null,
  profile_description: "",
  timezone: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

function makeUser(partial: Partial<User> = {}): User {
  return { ...BASE_USER, ...partial };
}

describe("needsSourceBackfill (disabled for self-host — always false)", () => {
  it("returns false when no user", () => {
    expect(needsSourceBackfill(null, 0)).toBe(false);
    expect(needsSourceBackfill(undefined, 0)).toBe(false);
  });

  it("returns false when user has not onboarded yet", () => {
    const user = makeUser({ onboarded_at: null });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false when onboarded with empty questionnaire (backfill disabled)", () => {
    const user = makeUser({ onboarding_questionnaire: {} });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false when onboarded with source missing (backfill disabled)", () => {
    const user = makeUser({
      onboarding_questionnaire: { role: "engineer" },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false when source is an empty array (backfill disabled)", () => {
    const user = makeUser({
      onboarding_questionnaire: { source: [] },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false when source has at least one entry", () => {
    const user = makeUser({
      onboarding_questionnaire: { source: ["search"] },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false when user previously skipped the source step", () => {
    const user = makeUser({
      onboarding_questionnaire: { source: [], source_skipped: true },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false once dismissCount hits the cap", () => {
    const user = makeUser({ onboarding_questionnaire: {} });
    expect(
      needsSourceBackfill(user, SOURCE_BACKFILL_MAX_DISMISSALS),
    ).toBe(false);
    expect(
      needsSourceBackfill(user, SOURCE_BACKFILL_MAX_DISMISSALS + 5),
    ).toBe(false);
  });

  it("returns false below the dismiss cap too (backfill disabled)", () => {
    const user = makeUser({ onboarding_questionnaire: {} });
    expect(
      needsSourceBackfill(user, SOURCE_BACKFILL_MAX_DISMISSALS - 1),
    ).toBe(false);
  });

  it("treats a legacy single-string source as already answered", () => {
    // Pre-multi-select rows wrote `source` as a bare string. The
    // backfill flow must NOT re-prompt these users — they did answer.
    // Mirrors the tolerance in `OnboardingFlow.mergeQuestionnaire`.
    const user = makeUser({
      onboarding_questionnaire: { source: "search" },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false for a legacy empty-string source (backfill disabled)", () => {
    const user = makeUser({
      onboarding_questionnaire: { source: "" },
    });
    expect(needsSourceBackfill(user, 0)).toBe(false);
  });

  it("returns false for malformed (number, null) source (backfill disabled)", () => {
    expect(
      needsSourceBackfill(
        makeUser({ onboarding_questionnaire: { source: 42 } }),
        0,
      ),
    ).toBe(false);
    expect(
      needsSourceBackfill(
        makeUser({ onboarding_questionnaire: { source: null } }),
        0,
      ),
    ).toBe(false);
  });
});
