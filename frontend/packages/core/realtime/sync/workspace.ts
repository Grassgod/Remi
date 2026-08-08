import type { QueryClient } from "@tanstack/react-query";
import { createLogger } from "../../logger";
import { clearWorkspaceStorage } from "../../platform/storage-cleanup";
import { defaultStorage } from "../../platform/storage";
import { getCurrentWsId, getCurrentSlug } from "../../platform/workspace-storage";
import { issueKeys } from "../../issues/queries";
import { workspaceKeys, workspaceListOptions } from "../../workspace/queries";
import { resolvePostAuthDestination } from "../../paths";
import type { Workspace } from "../../types/workspace";
import type {
  MemberAddedPayload,
  WorkspaceDeletedPayload,
  WorkspaceUpdatedPayload,
  MemberRemovedPayload,
  InvitationCreatedPayload,
} from "../../types";
import type { SyncContext, SyncModule } from "./types";

const logger = createLogger("realtime-sync");

/**
 * Apply a workspace:updated event to the cache. Always refreshes the
 * workspace list. If the incoming `issue_prefix` differs from what's
 * currently cached, also invalidates issueKeys.all for that workspace,
 * since every issue's rendered identifier (`MUL-123`) is recomputed from
 * the workspace prefix at read time. Without this, the UI keeps showing
 * the old `OLD-N` keys until the next hard refresh.
 *
 * If the workspace isn't in the cached list (first observation), we
 * conservatively invalidate — the prefix is effectively "new" relative to
 * what's cached, so any issues already loaded under the old prefix would
 * be stale anyway.
 */
export function applyWorkspaceUpdatedToCache(
  qc: QueryClient,
  payload: WorkspaceUpdatedPayload,
): void {
  const next = payload.workspace;
  if (next?.id) {
    const cached =
      qc
        .getQueryData<Workspace[]>(workspaceKeys.list())
        ?.find((w) => w.id === next.id) ?? null;
    if (!cached || cached.issue_prefix !== next.issue_prefix) {
      qc.invalidateQueries({ queryKey: issueKeys.all(next.id) });
    }
  }
  qc.invalidateQueries({ queryKey: workspaceKeys.list() });
}

/** Side-effect handlers (toast, navigation) for workspace / member /
 *  invitation events. */
export function createWorkspaceHandlers({
  qc,
  authStore,
  onToast,
  hasOnboardedRef,
}: SyncContext): SyncModule {
  // After the current workspace disappears (deleted or we were kicked out),
  // navigate to another workspace the user still has access to, or to the
  // create-workspace page. We use a full-page navigation: this reliably
  // tears down any in-flight queries / subscriptions tied to the dead
  // workspace without relying on framework-specific routers from here in
  // core.
  const relocateAfterWorkspaceLoss = async (lostWsId: string) => {
    const wsList = await qc.fetchQuery({
      ...workspaceListOptions(),
      staleTime: 0,
    });
    const remaining = wsList.filter((w) => w.id !== lostWsId);
    const target = resolvePostAuthDestination(
      remaining,
      hasOnboardedRef.current,
    );
    if (typeof window !== "undefined") {
      window.location.assign(target);
    }
  };

  return {
    handlers: {
      "workspace:updated": (p) => {
        applyWorkspaceUpdatedToCache(qc, p as WorkspaceUpdatedPayload);
      },

      "workspace:deleted": (p) => {
        const { workspace_id } = p as WorkspaceDeletedPayload;
        // Event payload has UUID; look up slug from cached workspace list
        // since clearWorkspaceStorage keys are namespaced by slug.
        const wsList = qc.getQueryData<{ id: string; slug: string }[]>(workspaceKeys.list()) ?? [];
        const deletedSlug = wsList.find((w) => w.id === workspace_id)?.slug;
        if (deletedSlug) clearWorkspaceStorage(defaultStorage, deletedSlug);
        if (getCurrentWsId() === workspace_id) {
          logger.warn("current workspace deleted, switching");
          onToast?.("This workspace was deleted", "info");
          relocateAfterWorkspaceLoss(workspace_id);
        }
      },

      "member:removed": (p) => {
        const { user_id } = p as MemberRemovedPayload;
        const myUserId = authStore.getState().user?.id;
        if (user_id === myUserId) {
          const slug = getCurrentSlug();
          const wsId = getCurrentWsId();
          if (slug && wsId) {
            clearWorkspaceStorage(defaultStorage, slug);
            logger.warn("removed from workspace, switching");
            onToast?.("You were removed from this workspace", "info");
            relocateAfterWorkspaceLoss(wsId);
          }
        }
      },

      "member:added": (p) => {
        const { member, workspace_name } = p as MemberAddedPayload;
        const myUserId = authStore.getState().user?.id;
        if (member.user_id === myUserId) {
          qc.invalidateQueries({ queryKey: workspaceKeys.list() });
          qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
          onToast?.(
            `You joined ${workspace_name ?? "a workspace"}`,
            "info",
          );
        }
      },

      // invitation:created — notify the invitee of a new pending invitation
      "invitation:created": (p) => {
        const { workspace_name } = p as InvitationCreatedPayload;
        qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
        onToast?.(
          `You were invited to ${workspace_name ?? "a workspace"}`,
          "info",
        );
      },

      // invitation:accepted / declined / revoked — refresh invitation lists
      "invitation:accepted": () => {
        const currentWsId = getCurrentWsId();
        if (currentWsId) {
          qc.invalidateQueries({ queryKey: workspaceKeys.invitations(currentWsId) });
          qc.invalidateQueries({ queryKey: workspaceKeys.members(currentWsId) });
        }
      },
      "invitation:declined": () => {
        const currentWsId = getCurrentWsId();
        if (currentWsId) {
          qc.invalidateQueries({ queryKey: workspaceKeys.invitations(currentWsId) });
        }
      },
      "invitation:revoked": () => {
        qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
      },
    },
  };
}
