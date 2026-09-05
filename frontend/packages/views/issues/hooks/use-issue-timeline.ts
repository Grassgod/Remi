"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  useMutationState,
} from "@tanstack/react-query";
import type {
  Comment,
  TimelineEntry,
  TimelinePage,
  Reaction,
} from "@multiremi/core/types";
import type {
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  CommentResolvedPayload,
  CommentUnresolvedPayload,
  ActivityCreatedPayload,
  ReactionAddedPayload,
  ReactionRemovedPayload,
} from "@multiremi/core/types";
import {
  issueTimelinePageOptions,
  issueKeys,
} from "@multiremi/core/issues/queries";
import {
  appendTimelineEntry,
  isIssueTimelineDirty,
  markIssueTimelineDirty,
  mapTimelineEntries,
  refreshIssueTimelineLatestPage,
  removeTimelineCommentTree,
  timelineEntries,
  type IssueTimelineData,
} from "@multiremi/core/issues/timeline-cache";
import {
  useCreateComment,
  useUpdateComment,
  useDeleteComment,
  useResolveComment,
  useToggleCommentReaction,
  type ToggleCommentReactionVars,
} from "@multiremi/core/issues/comment-mutations";
import { useWSEvent, useWSReconnect } from "@multiremi/core/realtime";
import { toast } from "sonner";
import { useT } from "../../i18n";

function commentToTimelineEntry(c: Comment): TimelineEntry {
  return {
    type: "comment",
    id: c.id,
    issue_session_id: c.issue_session_id ?? null,
    actor_type: c.author_type,
    actor_id: c.author_id,
    // Links an agent reply to the run that wrote it, so CommentTranscriptButton
    // can offer the per-reply execution transcript after a plain refetch (the
    // WS-pushed entry carries it; the REST refetch must too).
    task_id: c.task_id ?? null,
    content: c.content,
    parent_id: c.parent_id,
    created_at: c.created_at,
    updated_at: c.updated_at,
    comment_type: c.type,
    reactions: c.reactions ?? [],
    attachments: c.attachments ?? [],
    resolved_at: c.resolved_at,
    resolved_by_type: c.resolved_by_type,
    resolved_by_id: c.resolved_by_id,
  };
}

export function useIssueTimeline(
  issueId: string,
  userId?: string,
  issueSessionId?: string,
  enabled = true,
) {
  const { t } = useT("issues");
  const qc = useQueryClient();

  const query = useInfiniteQuery<
    TimelinePage,
    Error,
    IssueTimelineData,
    ReturnType<typeof issueKeys.timeline>,
    string | null
  >({
    ...issueTimelinePageOptions(issueId, issueSessionId),
    enabled,
  });
  const {
    data,
    isLoading: loading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = query;

  const timeline = useMemo<TimelineEntry[]>(() => timelineEntries(data), [data]);
  const latestTimeline = useMemo<TimelineEntry[]>(
    () => data?.pages[0]?.entries ?? [],
    [data],
  );

  // Stable mutation handles. TanStack v5 returns a fresh result wrapper from
  // useMutation per render, but the inner mutateAsync / mutate functions are
  // stable. Pull just those so the useCallback identities downstream don't
  // flip on every parent re-render — listing the whole mutation object would
  // defeat React.memo on CommentCard.
  const { mutateAsync: createComment } = useCreateComment(issueId, issueSessionId);
  const { mutateAsync: updateComment } = useUpdateComment(issueId, issueSessionId);
  const { mutateAsync: deleteCommentAsync } = useDeleteComment(issueId, issueSessionId);
  const { mutateAsync: resolveCommentAsync } = useResolveComment(issueId, issueSessionId);
  const { mutate: toggleCommentReaction } = useToggleCommentReaction(issueId, issueSessionId);

  const refreshLatestPage = useCallback(() => {
    void refreshIssueTimelineLatestPage(qc, issueId, issueSessionId).catch(() => {
      // Leave a separate dirty marker so a later mount retries without making
      // TanStack refetch every loaded history page.
      markIssueTimelineDirty(qc, issueId);
    });
  }, [qc, issueId, issueSessionId]);

  // Reconnect recovery refreshes only the authoritative latest window and
  // merges it with already-loaded history.
  useWSReconnect(
    refreshLatestPage,
  );

  // --- WS event handlers ---

  useWSEvent(
    "comment:created",
    useCallback(
      (payload: unknown) => {
        const { comment } = payload as CommentCreatedPayload;
        if (comment.issue_id !== issueId) return;
        if (issueSessionId && comment.issue_session_id !== issueSessionId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => appendTimelineEntry(old, commentToTimelineEntry(comment)),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "comment:updated",
    useCallback(
      (payload: unknown) => {
        const { comment } = payload as CommentUpdatedPayload;
        if (comment.issue_id !== issueId) return;
        if (issueSessionId && comment.issue_session_id !== issueSessionId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => mapTimelineEntries(old, (entry) =>
            entry.id === comment.id ? commentToTimelineEntry(comment) : entry),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  // Granular handlers for comment:resolved / comment:unresolved. The payload
  // carries the full Comment with the new resolved_at/resolved_by_* fields,
  // which `commentToTimelineEntry` already preserves, so the existing
  // entry can simply be replaced in place. Without these handlers the only
  // fallback would be the next page-zero dirty-generation reconciliation,
  // leaving the current CommentCard stale until that refresh.
  useWSEvent(
    "comment:resolved",
    useCallback(
      (payload: unknown) => {
        const { comment } = payload as CommentResolvedPayload;
        if (comment.issue_id !== issueId) return;
        if (issueSessionId && comment.issue_session_id !== issueSessionId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => mapTimelineEntries(old, (entry) =>
            entry.id === comment.id ? commentToTimelineEntry(comment) : entry),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "comment:unresolved",
    useCallback(
      (payload: unknown) => {
        const { comment } = payload as CommentUnresolvedPayload;
        if (comment.issue_id !== issueId) return;
        if (issueSessionId && comment.issue_session_id !== issueSessionId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => mapTimelineEntries(old, (entry) =>
            entry.id === comment.id ? commentToTimelineEntry(comment) : entry),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "comment:deleted",
    useCallback(
      (payload: unknown) => {
        const { comment_id, issue_id } = payload as CommentDeletedPayload;
        if (issue_id !== issueId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => removeTimelineCommentTree(old, comment_id),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "activity:created",
    useCallback(
      (payload: unknown) => {
        const p = payload as ActivityCreatedPayload;
        if (p.issue_id !== issueId) return;
        if (issueSessionId) return;
        const entry = p.entry;
        if (!entry || !entry.id) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => appendTimelineEntry(old, entry),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "reaction:added",
    useCallback(
      (payload: unknown) => {
        const { reaction, issue_id } = payload as ReactionAddedPayload;
        if (issue_id !== issueId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => mapTimelineEntries(old, (entry) => {
            if (entry.id !== reaction.comment_id) return entry;
            const existing = entry.reactions ?? [];
            if (existing.some((r) => r.id === reaction.id)) return entry;
            return { ...entry, reactions: [...existing, reaction] };
          }),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  useWSEvent(
    "reaction:removed",
    useCallback(
      (payload: unknown) => {
        const p = payload as ReactionRemovedPayload;
        if (p.issue_id !== issueId) return;
        qc.setQueryData<IssueTimelineData>(
          issueKeys.timeline(issueId, issueSessionId),
          (old) => mapTimelineEntries(old, (entry) => {
            if (entry.id !== p.comment_id) return entry;
            return {
              ...entry,
              reactions: (entry.reactions ?? []).filter(
                (r) =>
                  !(
                    r.emoji === p.emoji &&
                    r.actor_type === p.actor_type &&
                    r.actor_id === p.actor_id
                  ),
              ),
            };
          }),
        );
      },
      [qc, issueId, issueSessionId],
    ),
  );

  const dirtyScopeCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !data) return;
    const scope = `${issueId}:${issueSessionId ?? "all"}`;
    if (dirtyScopeCheckedRef.current === scope) return;
    dirtyScopeCheckedRef.current = scope;
    const queryKey = issueKeys.timeline(issueId, issueSessionId);
    const state = qc.getQueryState(queryKey);
    if (
      state?.fetchStatus === "idle"
      && (state.isInvalidated || isIssueTimelineDirty(qc, issueId, issueSessionId))
    ) {
      // Reconcile once after local subscriptions register. Keeping this check
      // mount-scoped matters: a normal granular setQueryData update re-renders
      // the hook, but must not turn every WS event into a page-zero request.
      refreshLatestPage();
    }
  }, [qc, issueId, issueSessionId, enabled, data, refreshLatestPage]);

  // --- Mutation functions ---

  const submitComment = useCallback(
    async (content: string, attachmentIds?: string[]) => {
      if (!content.trim() || !userId) return;
      try {
        await createComment({ content, attachmentIds });
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.comment.send_failed),
        );
      }
    },
    [userId, createComment, t],
  );

  const submitReply = useCallback(
    async (parentId: string, content: string, attachmentIds?: string[]) => {
      if (!content.trim() || !userId) return;
      try {
        await createComment({
          content,
          type: "comment",
          parentId,
          attachmentIds,
        });
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.comment.send_reply_failed),
        );
      }
    },
    [userId, createComment, t],
  );

  const editComment = useCallback(
    async (commentId: string, content: string, attachmentIds: string[]) => {
      try {
        await updateComment({ commentId, content, attachmentIds });
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.comment.update_failed),
        );
      }
    },
    [updateComment, t],
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      try {
        await deleteCommentAsync(commentId);
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.comment.delete_failed),
        );
      }
    },
    [deleteCommentAsync, t],
  );

  const toggleResolveComment = useCallback(
    async (commentId: string, resolved: boolean) => {
      try {
        await resolveCommentAsync({ commentId, resolved });
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : resolved
              ? t(($) => $.comment.resolve.resolve_failed)
              : t(($) => $.comment.resolve.unresolve_failed),
        );
      }
    },
    [resolveCommentAsync, t],
  );

  // --- Optimistic UI for comment reactions ---
  // Derive at render time from pending mutation variables instead of writing
  // temp data into the cache (which would race with WS events).

  const pendingReactionVars = useMutationState({
    filters: {
      mutationKey: ["toggleCommentReaction", issueId, issueSessionId ?? "all"],
      status: "pending",
    },
    select: (m) =>
      m.state.variables as ToggleCommentReactionVars | undefined,
  });

  const optimisticTimeline = useMemo(() => {
    if (pendingReactionVars.length === 0) return timeline;

    return timeline.map((entry) => {
      const pendingForEntry = pendingReactionVars.filter(
        (v) => v && v.commentId === entry.id,
      );
      if (pendingForEntry.length === 0) return entry;

      let reactions = entry.reactions ?? [];
      for (const vars of pendingForEntry) {
        if (!vars) continue;
        if (vars.existing) {
          reactions = reactions.filter((r) => r.id !== vars.existing!.id);
        } else {
          const alreadyExists = reactions.some(
            (r) =>
              r.emoji === vars.emoji &&
              r.actor_type === "member" &&
              r.actor_id === userId,
          );
          if (!alreadyExists) {
            reactions = [
              ...reactions,
              {
                id: `optimistic-${vars.emoji}`,
                comment_id: vars.commentId,
                actor_type: "member",
                actor_id: userId ?? "",
                emoji: vars.emoji,
                created_at: "",
              },
            ];
          }
        }
      }
      return { ...entry, reactions };
    });
  }, [timeline, pendingReactionVars, userId]);

  // toggleReaction reads from a ref so its identity does not change with
  // every WS event. Without this every memoized CommentCard down-tree would
  // re-render on each timeline mutation, defeating the React.memo cost
  // savings on long timelines (#1968).
  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  const toggleReaction = useCallback(
    async (commentId: string, emoji: string) => {
      if (!userId) return;
      const entry = timelineRef.current.find((e) => e.id === commentId);
      const existing: Reaction | undefined = (entry?.reactions ?? []).find(
        (r) =>
          r.emoji === emoji &&
          r.actor_type === "member" &&
          r.actor_id === userId,
      );
      toggleCommentReaction({ commentId, emoji, existing });
    },
    [userId, toggleCommentReaction],
  );

  return {
    timeline: optimisticTimeline,
    latestTimeline,
    loading,
    fetchOlderTimeline: fetchNextPage,
    hasOlderTimeline: hasNextPage,
    isFetchingOlderTimeline: isFetchingNextPage,
    submitComment,
    submitReply,
    editComment,
    deleteComment,
    toggleResolveComment,
    toggleReaction,
  };
}
