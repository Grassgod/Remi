import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "./queries";
import type { Reaction, TimelineEntry } from "../types";
import { sortTimelineEntriesAsc } from "./timeline-sort";

// ---------------------------------------------------------------------------
// Comments / Timeline
// ---------------------------------------------------------------------------

/**
 * Shared mutation variables — read back by `useMutationState` consumers, so
 * the type lives beside the mutation that writes it.
 */
export type ToggleCommentReactionVars = {
  commentId: string;
  emoji: string;
  existing: Reaction | undefined;
};

type TimelineCache = TimelineEntry[];

export function useCreateComment(issueId: string, issueSessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      content,
      type,
      parentId,
      attachmentIds,
    }: {
      content: string;
      type?: string;
      parentId?: string;
      attachmentIds?: string[];
    }) => api.createComment(issueId, content, type, parentId, attachmentIds, issueSessionId),
    onSuccess: (comment) => {
      const entry: TimelineEntry = {
        type: "comment",
        id: comment.id,
        actor_type: comment.author_type,
        actor_id: comment.author_id,
        task_id: comment.task_id ?? null,
        content: comment.content,
        parent_id: comment.parent_id,
        comment_type: comment.type,
        reactions: comment.reactions ?? [],
        attachments: comment.attachments ?? [],
        created_at: comment.created_at,
        updated_at: comment.updated_at,
      };
      // Dedupe by id: the `comment:created` WS event may have already added
      // this entry from the broadcast path before this onSuccess fires. Skip
      // the append if the entry is already in the cache.
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId), (old) => {
        if (!old) return [entry];
        if (old.some((e) => e.id === entry.id)) return old;
        return sortTimelineEntriesAsc([...old, entry]);
      });
    },
    // No onSettled invalidate. The `comment:created` WS broadcast keeps
    // the timeline cache fresh after a successful create, and reconnect
    // recovery in useIssueTimeline already invalidates if the connection
    // dropped. Re-fetching on every submit replaces every entry's
    // reference, which forces every memoized CommentCard subtree to
    // re-render (visible as a flash across sibling threads during AI
    // streaming).
  });
}

export function useUpdateComment(issueId: string, issueSessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, content, attachmentIds }: { commentId: string; content: string; attachmentIds: string[] }) =>
      api.updateComment(commentId, content, attachmentIds),
    onMutate: async ({ commentId, content, attachmentIds }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
      const prev = qc.getQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId));
      const kept = new Set(attachmentIds);
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId), (old) =>
        old?.map((e) =>
          e.id === commentId
            ? { ...e, content, attachments: e.attachments?.filter((a) => kept.has(a.id)) }
            : e,
        ),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(issueKeys.timeline(issueId, issueSessionId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}

export function useDeleteComment(issueId: string, issueSessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.deleteComment(commentId),
    onMutate: async (commentId) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
      const prev = qc.getQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId));

      // Cascade: collect all descendants of the deleted comment.
      const toRemove = new Set<string>([commentId]);
      if (prev) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const e of prev) {
            if (
              e.parent_id &&
              toRemove.has(e.parent_id) &&
              !toRemove.has(e.id)
            ) {
              toRemove.add(e.id);
              changed = true;
            }
          }
        }
      }

      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId), (old) =>
        old?.filter((e) => !toRemove.has(e.id)),
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(issueKeys.timeline(issueId, issueSessionId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}

export function useResolveComment(issueId: string, issueSessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      resolved ? api.resolveComment(commentId) : api.unresolveComment(commentId),
    onMutate: async ({ commentId, resolved }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
      const prev = qc.getQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId));
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId, issueSessionId), (old) =>
        old?.map((e) =>
          e.id === commentId
            ? {
                ...e,
                resolved_at: resolved ? new Date().toISOString() : null,
                resolved_by_type: resolved ? e.resolved_by_type ?? null : null,
                resolved_by_id: resolved ? e.resolved_by_id ?? null : null,
              }
            : e,
        ),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(issueKeys.timeline(issueId, issueSessionId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}

export function useToggleCommentReaction(issueId: string, issueSessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["toggleCommentReaction", issueId, issueSessionId ?? "all"] as const,
    mutationFn: async ({
      commentId,
      emoji,
      existing,
    }: ToggleCommentReactionVars) => {
      if (existing) {
        await api.removeReaction(commentId, emoji);
        return null;
      }
      return api.addReaction(commentId, emoji);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}
