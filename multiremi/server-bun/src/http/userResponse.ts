/**
 * Shared user-response mapping — the Go auth.go userToResponse shape (snake_case).
 * Used by GET/PATCH /api/me and the onboarding endpoint so they return an
 * identical, frontend-schema-compatible user object.
 */

import type { User } from "../db/schema.js";

/**
 * Normalize a Postgres timestamp string (e.g. "2026-06-08 14:45:17.5+00") into
 * RFC3339 / ISO-8601 UTC ("2026-06-08T14:45:17Z"), matching Go's timestampToPtr.
 * Returns null for absent timestamps; truncates sub-second precision.
 */
export function tsToRfc3339(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Build the Go UserResponse shape from a user row. */
export function userToResponse(u: User) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatar_url: u.avatarUrl ?? null,
    language: u.language ?? null,
    timezone: u.timezone ?? null,
    onboarded_at: tsToRfc3339(u.onboardedAt),
    onboarding_questionnaire: u.onboardingQuestionnaire ?? {},
    starter_content_state: u.starterContentState ?? null,
    profile_description: u.profileDescription ?? "",
    created_at: tsToRfc3339(u.createdAt),
    updated_at: tsToRfc3339(u.updatedAt),
  };
}
