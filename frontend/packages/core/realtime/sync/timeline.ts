import { issueKeys } from "../../issues/queries";
import {
  markIssueTimelineDirty,
  refreshActiveIssueTimelineLatestPages,
} from "../../issues/timeline-cache";
import type {
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  CommentResolvedPayload,
  CommentUnresolvedPayload,
  ActivityCreatedPayload,
  ReactionAddedPayload,
  ReactionRemovedPayload,
  IssueReactionAddedPayload,
  IssueReactionRemovedPayload,
  SubscriberAddedPayload,
  SubscriberRemovedPayload,
} from "../../types";
import type { SyncContext, SyncModule } from "./types";

/**
 * Timeline event handlers (global fallback).
 *
 * These events are also handled granularly by useIssueTimeline when
 * IssueDetail is mounted. This global handler records a separate dirty
 * generation for issues whose IssueDetail is not mounted. The local hook
 * reconciles that generation by fetching only page zero on its next mount.
 *
 * The timeline query itself must not be invalidated. TanStack v5 refetches
 * every cached page when an invalidated infinite query mounts, even when the
 * original invalidation used `refetchType: "none"`. It also replaces every
 * entry reference and busts React.memo across all CommentCard subtrees during
 * AI streaming (MUL-1941). Active observers stay fresh via granular
 * setQueryData handlers in `useIssueTimeline`; the generation covers the gap
 * before those handlers mount.
 */
export function createTimelineHandlers({ qc }: SyncContext): SyncModule {
  const markTimelineForSync = (issueId: string) => {
    // An Issue can have multiple Product Session timelines. Using the concrete
    // "all" key here misses every session-scoped cache and leaves staleTime:
    // Infinity data permanently fresh when its event arrived before
    // IssueDetail mounted.
    const queryKey = issueKeys.timelineAll(issueId);
    const hadInFlightRequest = qc.isFetching({ queryKey }) > 0;
    markIssueTimelineDirty(qc, issueId);

    if (hadInFlightRequest) {
      // An initial request may have captured the database just before this WS
      // event was persisted. Letting that response finish would overwrite the
      // granular cache append performed by useIssueTimeline. Cancel it, then
      // reconcile only page zero: refetchQueries on an infinite query would
      // reload every history page the user has already fetched.
      void qc
        .cancelQueries({ queryKey }, { revert: false })
        .then(() => refreshActiveIssueTimelineLatestPages(qc, issueId))
        .catch(() => {
          // The dirty generation remains unapplied, so the next mount retries.
        });
    }
  };

  return {
    handlers: {
      "comment:created": (p) => {
        const { comment } = p as CommentCreatedPayload;
        if (comment?.issue_id) markTimelineForSync(comment.issue_id);
      },

      "comment:updated": (p) => {
        const { comment } = p as CommentUpdatedPayload;
        if (comment?.issue_id) markTimelineForSync(comment.issue_id);
      },

      "comment:deleted": (p) => {
        const { issue_id } = p as CommentDeletedPayload;
        if (issue_id) markTimelineForSync(issue_id);
      },

      "comment:resolved": (p) => {
        const { comment } = p as CommentResolvedPayload;
        if (comment?.issue_id) markTimelineForSync(comment.issue_id);
      },

      "comment:unresolved": (p) => {
        const { comment } = p as CommentUnresolvedPayload;
        if (comment?.issue_id) markTimelineForSync(comment.issue_id);
      },

      "activity:created": (p) => {
        const { issue_id } = p as ActivityCreatedPayload;
        if (issue_id) markTimelineForSync(issue_id);
      },

      "reaction:added": (p) => {
        const { issue_id } = p as ReactionAddedPayload;
        if (issue_id) markTimelineForSync(issue_id);
      },

      "reaction:removed": (p) => {
        const { issue_id } = p as ReactionRemovedPayload;
        if (issue_id) markTimelineForSync(issue_id);
      },

      // --- Issue-level reactions & subscribers (global fallback) ---

      "issue_reaction:added": (p) => {
        const { issue_id } = p as IssueReactionAddedPayload;
        if (issue_id) qc.invalidateQueries({ queryKey: issueKeys.reactions(issue_id) });
      },

      "issue_reaction:removed": (p) => {
        const { issue_id } = p as IssueReactionRemovedPayload;
        if (issue_id) qc.invalidateQueries({ queryKey: issueKeys.reactions(issue_id) });
      },

      "subscriber:added": (p) => {
        const { issue_id } = p as SubscriberAddedPayload;
        if (issue_id) qc.invalidateQueries({ queryKey: issueKeys.subscribers(issue_id) });
      },

      "subscriber:removed": (p) => {
        const { issue_id } = p as SubscriberRemovedPayload;
        if (issue_id) qc.invalidateQueries({ queryKey: issueKeys.subscribers(issue_id) });
      },
    },
  };
}
