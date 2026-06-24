import type { Workspace } from "../types";
import { useAuthStore } from "../auth";
import { paths } from "./paths";

/**
 * Destination after auth:
 *   workspace[0] → /<first.slug>/issues
 *   no workspace → /workspaces/new
 *
 * NOTE (self-host customization): the consumer onboarding funnel is disabled
 * here — we never route to the /onboarding wizard. `hasOnboarded` is kept for
 * signature/call-site compatibility but no longer gates anything (the matching
 * workspace-layout gate is also relaxed). Brand-new users land on the simple
 * create-workspace page instead of the 5-step questionnaire/runtime wizard.
 *
 * Callers that need invitation-aware routing (callback / login) handle the
 * pending-invites branch themselves before calling this resolver.
 */
export function resolvePostAuthDestination(
  workspaces: Workspace[],
  hasOnboarded: boolean,
): string {
  void hasOnboarded; // onboarding funnel disabled; param retained for compat
  const first = workspaces[0];
  if (first) {
    return paths.workspace(first.slug).issues();
  }
  return paths.newWorkspace();
}

/**
 * Single source of truth: backed by `users.onboarded_at`, which
 * arrives with the user object on every auth response.
 */
export function useHasOnboarded(): boolean {
  return useAuthStore((s) => s.user?.onboarded_at != null);
}
