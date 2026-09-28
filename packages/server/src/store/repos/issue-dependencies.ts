// MUL-400 E3: sibling dependency semantics, kept out of the (already large)
// IssuesRepo so the rules can be read and tested on their own. Everything here
// is pure: the caller supplies issue lookups, and the repo owns all writes.
//
// One direction is stored: `(issue_id = A, depends_on_issue_id = B,
// type = 'blocked_by')` means A waits on B. `blocks` is only a view of the
// reverse relation, so `type: blocks` writes are flipped before they are
// stored and pre-existing `blocks` rows are flipped when they are read. That
// keeps the table single-directional without a migration.

/** Statuses that count as a satisfied prerequisite. Only `done` does. */
export function isPrerequisiteSatisfied(status: string): boolean {
  return status === "done";
}

/**
 * MUL-400 E3 kill switch. The dependency gate ships enabled; a false-y value
 * restores the pre-MUL-400 passthrough (no gate, no automatic start) for an
 * emergency without redeploying an older image.
 */
export function dependencyGateEnabled(): boolean {
  const raw = (process.env.MULTIREMI_DEPENDENCY_GATE ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "disabled";
}

/** Why a dependency write or a status transition was refused. */
export type IssueDependencyErrorCode =
  | "dependencies_unmet"
  | "dependency_cycle"
  | "dependency_on_ancestor";

export interface IssueDependencyUnmetRef {
  issueId: string;
  dependsOnIssueId: string;
  key: string;
  title: string;
  status: string;
  dependencyId: string;
}

export class IssueDependencyError extends Error {
  constructor(
    readonly code: IssueDependencyErrorCode,
    message: string,
    readonly details: {
      unmet?: IssueDependencyUnmetRef[];
      /** Keys along the offending path, oldest prerequisite first. */
      path?: string[];
    } = {},
  ) {
    super(message);
  }
}

/**
 * Bounded depth-first search over the "waits for" graph.
 *
 * `waitersOf(id)` returns the issues that wait on `id`, i.e. the successors of
 * `id` when walking from a prerequisite towards its dependents. Adding the edge
 * `target waits for start` closes a cycle exactly when `target` is reachable
 * from `start`.
 *
 * The bound exists because the graph is user-authored: a long chain must stop
 * at a known cost instead of walking forever.
 */
export function findDependencyCyclePath(
  startId: string,
  targetId: string,
  waitersOf: (issueId: string) => string[],
  limit = 200,
): string[] | null {
  const visited = new Set<string>([startId]);
  const path: string[] = [startId];
  const walk = (current: string, depth: number): string[] | null => {
    if (depth >= limit) return null;
    if (current === targetId && depth > 0) return [...path];
    for (const next of waitersOf(current)) {
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      const found = walk(next, depth + 1);
      path.pop();
      if (found) return found;
    }
    return null;
  };
  // The walk starts at the proposed prerequisite: the chain is only a cycle if
  // it comes back to the dependent, so the start itself is not a hit.
  return startId === targetId ? null : walk(startId, 0);
}

/** The three concrete ways out of a failed prerequisite, in one place. */
export function dependencyFailureCommands(input: {
  dependentKey: string;
  prerequisiteKey: string;
  dependencyId: string;
}): string[] {
  return [
    `Re-plan: create a replacement sub-issue for ${input.prerequisiteKey} and point ${input.dependentKey} at it`
      + ` (remi issue create ... && remi issue dependency add ${input.dependentKey} <new-issue> --type blocked_by).`,
    `Cancel the dependent issue: remi issue update ${input.dependentKey} --status cancelled.`,
    `Drop this dependency so ${input.dependentKey} can be picked up: remi issue dependency remove ${input.dependentKey} ${input.dependencyId}.`,
  ];
}
