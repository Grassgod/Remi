import type { ProjectDocRef, SessionResult } from "../types";

// A published Session result carries an open `metadata` bag. Two keys inside
// it are a convention the CLI writes (`remi issue session result publish
// --type … --ref …`) and the issue page reads — the server persists whatever
// arrives, so both readers below degrade instead of trusting the shape.
//
// See docs/issue-key-results.md for the contract.

export const SESSION_RESULT_KINDS = [
  "mr",
  "report",
  "deploy",
  "decision",
  "doc",
  "other",
] as const;

export type SessionResultKind = (typeof SESSION_RESULT_KINDS)[number];

/**
 * The result's kind, or `"other"` when it is absent, not a string, or a value
 * this build doesn't know — a newer server (or a hand-written metadata bag)
 * must render generically, never blank.
 */
export function sessionResultKind(result: SessionResult): SessionResultKind {
  const raw = result.metadata?.kind;
  return typeof raw === "string" && (SESSION_RESULT_KINDS as readonly string[]).includes(raw)
    ? (raw as SessionResultKind)
    : "other";
}

/**
 * What the result points at, in the same `{type, value}` shape as project-doc
 * refs. Anything that isn't an array yields no refs; a non-object entry, or an
 * entry without a value, is dropped rather than failing the whole result.
 */
export function sessionResultRefs(result: SessionResult): ProjectDocRef[] {
  const raw = result.metadata?.refs;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      type: typeof entry.type === "string" ? entry.type : "",
      value: typeof entry.value === "string" ? entry.value : "",
    }))
    .filter((ref) => ref.value.length > 0);
}
