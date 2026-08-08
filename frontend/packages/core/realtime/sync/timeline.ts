import { issueKeys } from "../../issues/queries";
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
 * IssueDetail is mounted. This global handler exists to mark the
 * timeline cache stale for issues whose IssueDetail is *not* mounted,
 * so stale data isn't served on next mount (staleTime: Infinity, set on
 * the QueryClient default, relies on this).
 *
 * `refetchType: "none"` is the load-bearing detail: without it, an
 * active IssueDetail observer would refetch the entire timeline on
 * every comment / activity / reaction event. The refetch replaces
 * every entry's reference and busts React.memo on every CommentCard
 * subtree (visible during AI streaming as a flash across all sibling
 * threads, MUL-1941). Inactive observers don't refetch either way;
 * when IssueDetail mounts later, the stale flag triggers the refetch
 * through `refetchOnMount`. Active observers stay fresh via the
 * granular setQueryData handlers in `useIssueTimeline`.
 */
export function createTimelineHandlers({ qc }: SyncContext): SyncModule {
  const invalidateTimeline = (issueId: string) => {
    qc.invalidateQueries({
      queryKey: issueKeys.timeline(issueId),
      refetchType: "none",
    });
  };

  return {
    handlers: {
      "comment:created": (p) => {
        const { comment } = p as CommentCreatedPayload;
        if (comment?.issue_id) invalidateTimeline(comment.issue_id);
      },

      "comment:updated": (p) => {
        const { comment } = p as CommentUpdatedPayload;
        if (comment?.issue_id) invalidateTimeline(comment.issue_id);
      },

      "comment:deleted": (p) => {
        const { issue_id } = p as CommentDeletedPayload;
        if (issue_id) invalidateTimeline(issue_id);
      },

      "comment:resolved": (p) => {
        const { comment } = p as CommentResolvedPayload;
        if (comment?.issue_id) invalidateTimeline(comment.issue_id);
      },

      "comment:unresolved": (p) => {
        const { comment } = p as CommentUnresolvedPayload;
        if (comment?.issue_id) invalidateTimeline(comment.issue_id);
      },

      "activity:created": (p) => {
        const { issue_id } = p as ActivityCreatedPayload;
        if (issue_id) invalidateTimeline(issue_id);
      },

      "reaction:added": (p) => {
        const { issue_id } = p as ReactionAddedPayload;
        if (issue_id) invalidateTimeline(issue_id);
      },

      "reaction:removed": (p) => {
        const { issue_id } = p as ReactionRemovedPayload;
        if (issue_id) invalidateTimeline(issue_id);
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
