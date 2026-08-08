import { getCurrentWsId } from "../../platform/workspace-storage";
import {
  onIssueCreated,
  onIssueUpdated,
  onIssueDeleted,
  onIssueLabelsChanged,
  onIssueMetadataChanged,
} from "../../issues/ws-updaters";
import { onInboxIssueStatusChanged, onInboxIssueDeleted } from "../../inbox/ws-updaters";
import type {
  IssueUpdatedPayload,
  IssueCreatedPayload,
  IssueDeletedPayload,
  IssueLabelsChangedPayload,
  IssueMetadataChangedPayload,
} from "../../types";
import type { SyncContext, SyncModule } from "./types";

/**
 * Issue-level granular cache updates.
 *
 * No self-event filtering: actor_id identifies the USER, not the TAB.
 * Filtering by actor_id would block other tabs of the same user.
 * Instead, both mutations and WS handlers use dedup checks to be idempotent.
 */
export function createIssueHandlers({ qc }: SyncContext): SyncModule {
  return {
    handlers: {
      "issue:updated": (p) => {
        const { issue } = p as IssueUpdatedPayload;
        if (!issue?.id) return;
        const wsId = getCurrentWsId();
        if (wsId) {
          onIssueUpdated(qc, wsId, issue);
          if (issue.status) {
            onInboxIssueStatusChanged(qc, wsId, issue.id, issue.status);
          }
        }
      },

      "issue:created": (p) => {
        const { issue } = p as IssueCreatedPayload;
        if (!issue) return;
        const wsId = getCurrentWsId();
        if (wsId) onIssueCreated(qc, wsId, issue);
      },

      "issue:deleted": (p) => {
        const { issue_id } = p as IssueDeletedPayload;
        if (!issue_id) return;
        const wsId = getCurrentWsId();
        if (wsId) {
          onIssueDeleted(qc, wsId, issue_id);
          onInboxIssueDeleted(qc, wsId, issue_id);
        }
      },

      "issue_labels:changed": (p) => {
        const { issue_id, labels } = p as IssueLabelsChangedPayload;
        if (!issue_id) return;
        const wsId = getCurrentWsId();
        if (wsId) onIssueLabelsChanged(qc, wsId, issue_id, labels ?? []);
      },

      "issue_metadata:changed": (p) => {
        const { issue_id, metadata } = p as IssueMetadataChangedPayload;
        if (!issue_id) return;
        const wsId = getCurrentWsId();
        if (wsId) onIssueMetadataChanged(qc, wsId, issue_id, metadata ?? {});
      },
    },
  };
}
