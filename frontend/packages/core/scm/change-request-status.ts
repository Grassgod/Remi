import type { ScmChangeRequestState } from "../types";

export type ChangeRequestStatusKind =
  | "closed"
  | "merged"
  | "conflicts"
  | "checks_failed"
  | "checks_pending"
  | "checks_passed"
  | "ready"
  | "unknown";

export interface ChangeRequestStatusInput {
  state: ScmChangeRequestState;
  mergeableState?: string | null;
  checksFailed?: number;
  checksPending?: number;
  checksPassed?: number;
}

export function deriveChangeRequestStatusKind(
  input: ChangeRequestStatusInput,
): ChangeRequestStatusKind {
  if (input.state === "closed") return "closed";
  if (input.state === "merged") return "merged";
  if (input.mergeableState === "dirty") return "conflicts";
  if ((input.checksFailed ?? 0) > 0) return "checks_failed";
  if ((input.checksPending ?? 0) > 0) return "checks_pending";
  if ((input.checksPassed ?? 0) > 0) return "checks_passed";
  if (input.mergeableState === "clean") return "ready";
  return "unknown";
}

export interface ChangeRequestProgressSegment {
  kind: "failed" | "pending" | "passed";
  ratio: number;
}

export function deriveChangeRequestProgressSegments(
  input: ChangeRequestStatusInput,
): ChangeRequestProgressSegment[] | null {
  if (input.state === "closed" || input.state === "merged") return null;
  const failed = input.checksFailed ?? 0;
  const pending = input.checksPending ?? 0;
  const passed = input.checksPassed ?? 0;
  const total = failed + pending + passed;
  if (total === 0) return null;
  const segments: ChangeRequestProgressSegment[] = [];
  if (failed > 0) segments.push({ kind: "failed", ratio: failed / total });
  if (pending > 0) segments.push({ kind: "pending", ratio: pending / total });
  if (passed > 0) segments.push({ kind: "passed", ratio: passed / total });
  return segments;
}

export interface ChangeRequestStatsInput {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export function shouldShowChangeRequestStats(input: ChangeRequestStatsInput): boolean {
  return (input.additions ?? 0) + (input.deletions ?? 0) + (input.changedFiles ?? 0) > 0;
}
