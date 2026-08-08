"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Agent, IssueSession, MemberWithUser } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { issueSessionResultsOptions } from "@multiremi/core/issues/queries";
import { LocalDirectoryHint } from "../../projects/components/local-directory-hint";
import { useT, useTimeAgo } from "../../i18n";
import { useIssueTimeline } from "../hooks/use-issue-timeline";
import { useResolvedThreads } from "../hooks/use-resolved-threads";
import { useActivityExpansion } from "../hooks/use-activity-expansion";
import { getSessionDisplayName } from "../utils/session-display";
import {
  buildTimelineView,
  flattenGroups,
  lastActivityGroupId,
  type TimelineItem,
} from "../utils/timeline-view";
import { ActivityBlock } from "./activity-block";
import { AgentLiveCard } from "./agent-live-card";
import { CommentCard } from "./comment-card";
import { CommentInput, type ReplyTarget } from "./comment-input";
import { IssueResultActivityLines } from "./issue-key-results-section";
import { IssueSubscribersControl } from "./issue-subscribers-control";
import { ResolvedThreadBar } from "./resolved-thread-bar";
import { SessionAgentStreamRow } from "./session-agent-stream-row";
import { SessionEmptyState, TimelineSkeleton, TimelineUnavailable } from "./timeline-states";

interface IssueActivitySectionProps {
  issueId: string;
  projectId: string | null;
  currentUserId?: string;
  /**
   * Workspace owners and admins moderate any comment authored by anyone
   * (mirrors backend `comment.go:507-512`).
   */
  canModerateComments: boolean;
  members: MemberWithUser[];
  agents: Agent[];
  activeIssueSessionId: string;
  activeIssueSession: IssueSession | null;
  sessionsPending: boolean;
  sessionsFetching: boolean;
  onRetrySessions: () => void;
  /** Scroll parent handed to Virtuoso; null until the callback ref populates. */
  scrollContainerEl: HTMLDivElement | null;
  /** When set, the timeline renders flat and scrolls to this comment. */
  highlightCommentId?: string;
  onShowKeyResults: () => void;
}

/**
 * The issue's conversation: subscribers header, live agent card, published
 * results, the timeline itself (virtualized or flat) and the single composer.
 */
export function IssueActivitySection({
  issueId,
  projectId,
  currentUserId,
  canModerateComments,
  members,
  agents,
  activeIssueSessionId,
  activeIssueSession,
  sessionsPending,
  sessionsFetching,
  onRetrySessions,
  scrollContainerEl,
  highlightCommentId,
  onShowKeyResults,
}: IssueActivitySectionProps) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const { getActorName } = useActorName();

  const {
    timeline, loading: timelineLoading,
    submitComment, submitReply,
    editComment, deleteComment, toggleResolveComment, toggleReaction: handleToggleReaction,
  } = useIssueTimeline(issueId, currentUserId, activeIssueSessionId || undefined, Boolean(activeIssueSessionId));

  const resolvedThreads = useResolvedThreads();
  const activityExpansion = useActivityExpansion();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const didHighlightRef = useRef<string | null>(null);

  // Published results render their own timeline lines (and panel cards), so an
  // otherwise-empty timeline still has content when one exists. Same query key
  // as those components — this shares their cache entry, it doesn't add a fetch.
  const { data: publishedResults = [] } = useQuery(issueSessionResultsOptions(issueId));

  // Resolve / unresolve must always clear the per-session expand entry so
  // re-resolving an already-expanded thread folds it back to the bar (the
  // expand Set is keyed only on commentId, not on resolution state). Without
  // this wrapper, an expand → unresolve → resolve sequence keeps the thread
  // visually expanded after the second resolve.
  const clearResolvedExpand = resolvedThreads.clear;
  const handleResolveToggle = useCallback(
    (commentId: string, resolved: boolean) => {
      clearResolvedExpand(commentId);
      toggleResolveComment(commentId, resolved);
    },
    [clearResolvedExpand, toggleResolveComment],
  );

  // The session stream has exactly one composer, so "reply" is a context it
  // carries: a row's toolbar sets the target, the composer shows it as a chip,
  // and the send routes through `submitReply` (parent_id) instead of
  // `submitComment`. Ephemeral by design — not persisted with the draft.
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const handleStartReply = useCallback((target: ReplyTarget) => {
    setReplyTo(target);
  }, []);
  const handleCancelReply = useCallback(() => setReplyTo(null), []);
  // A target from another session (or another issue) would send a reply into a
  // conversation the user is no longer looking at.
  useEffect(() => {
    setReplyTo(null);
  }, [issueId, activeIssueSessionId]);
  const handleComposerSubmit = useCallback(
    async (content: string, attachmentIds?: string[]) => {
      if (!replyTo) {
        await submitComment(content, attachmentIds);
        return;
      }
      await submitReply(replyTo.commentId, content, attachmentIds);
      setReplyTo(null);
    },
    [replyTo, submitComment, submitReply],
  );

  // Memoized timeline projection. Kept in a useMemo so the objects handed to a
  // memoized CommentCard keep their identity until the timeline itself changes.
  const timelineView = useMemo(() => buildTimelineView(timeline), [timeline]);

  // Flat array consumed by <Virtuoso>. Recomputed when the groups change
  // (timeline events) or a resolved thread is toggled. Kept in a useMemo so
  // Virtuoso's data identity is stable across unrelated re-renders.
  const expandedResolved = resolvedThreads.expanded;
  const items = useMemo<TimelineItem[]>(
    () => flattenGroups(timelineView.groups, expandedResolved),
    [timelineView.groups, expandedResolved],
  );

  const lastActivityId = useMemo(
    () => lastActivityGroupId(timelineView.groups),
    [timelineView.groups],
  );

  // Deep-link landing. Semantically equivalent to navigating to
  // `#comment-${id}`: find the element with that id, scrollIntoView it.
  // When `highlightCommentId` is set the timeline below renders flat (no
  // virtualization), so every comment id is in the DOM by the time this
  // effect runs after commit. Every comment — reply included — is its own
  // timeline item now, so there is no enclosing thread to unfold first.
  //
  // `scrollContainerEl` is in deps because the surrounding panel renders a
  // loading skeleton while the issue query is pending. The scroll-container
  // ref populates only on the post-loading render, so it's the signal that
  // the timeline (and the deep-link target id) has actually rendered.
  useEffect(() => {
    if (!highlightCommentId || items.length === 0) return;
    if (didHighlightRef.current === highlightCommentId) return;

    const el = document.getElementById(`comment-${highlightCommentId}`);
    if (!el) return;

    didHighlightRef.current = highlightCommentId;
    el.scrollIntoView({ block: "center" });

    setHighlightedId(highlightCommentId);
    const fade = window.setTimeout(() => setHighlightedId(null), 2500);
    return () => clearTimeout(fade);
  }, [highlightCommentId, items, scrollContainerEl]);

  // Reference-chip navigation: jump to the comment a reply answers and flash
  // it. Same contract as the deep-link above, minus the one-shot guard — the
  // user can follow the same chip repeatedly. A parent that isn't mounted
  // (virtualized far off-screen, or outside the loaded window) is a no-op
  // rather than a jump to the wrong place.
  const parentFadeRef = useRef<number | null>(null);
  const handleNavigateToParent = useCallback((parentId: string) => {
    const el = document.getElementById(`comment-${parentId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(parentId);
    if (parentFadeRef.current !== null) clearTimeout(parentFadeRef.current);
    parentFadeRef.current = window.setTimeout(() => setHighlightedId(null), 2500);
  }, []);
  useEffect(
    () => () => {
      if (parentFadeRef.current !== null) clearTimeout(parentFadeRef.current);
    },
    [],
  );

  // Cmd-F / Ctrl-F on a virtualized timeline only searches what's mounted in
  // the viewport — off-screen comments are invisible to browser find-in-page.
  // Intercept once per (session, issue) when the list is long enough that the
  // user might actually try; let the keystroke pass through on short lists.
  // Real fix is in-app search (separate PR); this is the toast stopgap.
  useEffect(() => {
    if (items.length <= 30) return;
    const flagKey = `multimira_cmdF_warned:${issueId}`;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "f" || !(e.metaKey || e.ctrlKey)) return;
      if (sessionStorage.getItem(flagKey)) return;
      e.preventDefault();
      sessionStorage.setItem(flagKey, "1");
      toast.message(t(($) => $.detail.cmdf_toast_title), {
        description: t(($) => $.detail.cmdf_toast_description),
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [issueId, items.length, t]);

  // Shared row renderer for both timeline render modes (flat / virtualized).
  // The wrapper `id="comment-..."` is the deep-link target — equivalent to
  // a native `<a href="#comment-...">` anchor.
  const renderItem = (_i: number, item: TimelineItem): React.ReactElement => {
    if (item.kind === "resolved-bar") {
      return (
        <div className="pb-3" id={`comment-${item.id}`}>
          <ResolvedThreadBar
            entry={item.entry}
            onExpand={() => resolvedThreads.toggle(item.id, true)}
          />
        </div>
      );
    }
    if (item.kind === "comment") {
      const isResolved = !!item.entry.resolved_at;
      return (
        <div className="pb-3" id={`comment-${item.id}`}>
          <CommentCard
            issueId={issueId}
            entry={item.entry}
            parentRef={timelineView.parentRefs.get(item.id)}
            onNavigateToParent={handleNavigateToParent}
            hasReplies={timelineView.parentIds.has(item.id)}
            currentUserId={currentUserId}
            canModerate={canModerateComments}
            onStartReply={handleStartReply}
            onEdit={editComment}
            onDelete={deleteComment}
            onToggleReaction={handleToggleReaction}
            onResolveToggle={handleResolveToggle}
            onCollapseResolved={isResolved ? () => resolvedThreads.toggle(item.id, false) : undefined}
            highlightedCommentId={highlightedId}
          />
        </div>
      );
    }
    // activity-group
    const expanded = activityExpansion.isExpanded(item.id, item.id === lastActivityId);
    const truncateOlder = item.id === lastActivityId;
    return (
      <ActivityBlock
        entries={item.entries}
        expanded={expanded}
        onToggle={() => activityExpansion.toggle(item.id, expanded)}
        truncateOlder={truncateOlder}
        showOlder={activityExpansion.isShowingOlder(item.id)}
        onToggleShowOlder={() => activityExpansion.showOlder(item.id)}
        getActorName={getActorName}
        t={t}
        timeAgo={timeAgo}
      />
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">{t(($) => $.detail.activity_section)}</h2>
        </div>
        <IssueSubscribersControl
          issueId={issueId}
          currentUserId={currentUserId}
          members={members}
          agents={agents}
        />
      </div>

      <LocalDirectoryHint projectId={projectId} />

      {/* Agent live output — sticky banner in the activity section,
          keyed by issue id so switching issues remounts the card and
          clears any in-flight task state from the previous issue.
          The execution log itself (per-task timeline + past runs)
          lives in the right panel via ExecutionLogSection — this
          card is just a header-style "agent is working" anchor. */}
      {activeIssueSessionId && (
        <AgentLiveCard
          key={`${issueId}:${activeIssueSessionId}`}
          issueId={issueId}
          issueSessionId={activeIssueSessionId}
        />
      )}

      {/* Published results are shown in full by the right panel's
          key-results section; the timeline only notes that one
          landed and points at it. */}
      <IssueResultActivityLines
        issueId={issueId}
        onShowResults={onShowKeyResults}
      />

      {/* Timeline entries — virtualized via react-virtuoso to keep
          first-paint cost O(viewport) instead of O(N). On a 500-comment
          issue the unvirtualized .map froze the page for several
          seconds (markdown parse + lowlight code highlight runs per
          CommentCard on mount).

          customScrollParent guard: callback ref populates after the
          first commit. Without this null guard Virtuoso falls back to
          its own scroller, grabs 0 height inside overflow-y-auto, and
          miscomputes total-height on first paint. */}
      {!activeIssueSessionId ? (
        // The timeline query is gated on a resolved session id, and a
        // disabled query reports `isLoading === false` — so this branch
        // has to own both the waiting state and the dead end.
        sessionsPending ? (
          <TimelineSkeleton />
        ) : (
          <TimelineUnavailable
            onRetry={onRetrySessions}
            retrying={sessionsFetching}
          />
        )
      ) : timelineLoading && timelineView.groups.length === 0 ? (
        <TimelineSkeleton />
      ) : items.length === 0 && publishedResults.length === 0 ? (
        // A brand-new session has no comments, no activity and no
        // published result. Say so, and say what the two ways forward
        // are, instead of leaving a blank column under the header.
        <SessionEmptyState />
      ) : (
        // Two render modes:
        //   - `highlightCommentId` set (came from inbox deep-link) →
        //     render flat. Every comment mounts, every height is real,
        //     the target id is in the DOM the instant the useEffect
        //     above runs `scrollIntoView`. No virtualization estimate
        //     errors, no spacer reflow drift. Pays cold-mount cost
        //     proportional to items.length (markdown + lowlight per
        //     comment), which is acceptable in the deep-link case —
        //     the user has explicit intent to land on a specific item.
        //   - otherwise → Virtuoso. Browsing mode, virtualization
        //     wins on first-paint perf for long timelines.
        //
        // The split is deliberate: virtualization and "land precisely
        // on a target" have fundamentally opposed contracts (estimated
        // heights vs real heights). Trying to satisfy both in one
        // path is what produced the bug history this PR closes.
        !highlightCommentId ? (
          !scrollContainerEl ? (
            // Skeleton while the callback ref populates so the gap
            // between IssueDetail mount and Virtuoso mount doesn't
            // flash empty.
            <TimelineSkeleton />
          ) : (
            <div className="mt-4">
              <Virtuoso
                key={`${wsId}:${issueId}:${activeIssueSessionId}`}
                customScrollParent={scrollContainerEl}
                data={items}
                increaseViewportBy={{ top: 800, bottom: 800 }}
                computeItemKey={(_i, item) => `${item.kind}:${item.id}`}
                skipAnimationFrameInResizeObserver
                // followOutput intentionally NOT set. Virtuoso treats
                // it as a sticky "is at bottom" flag and resets
                // scrollTop to maxScrollTop on every height-change
                // tick — issue-detail is document-shaped, not chat.
                itemContent={renderItem}
              />
            </div>
          )
        ) : (
          <div className="mt-4">
            {items.map((item, i) => (
              <Fragment key={`${item.kind}:${item.id}`}>
                {renderItem(i, item)}
              </Fragment>
            ))}
          </div>
        )
      )}

      {/* Foot of the stream: what the agent is doing right now. Sits
          outside the timeline list so neither render mode (Virtuoso /
          flat map) has to carry a synthetic item. */}
      {activeIssueSessionId && (
        <SessionAgentStreamRow issueId={issueId} issueSessionId={activeIssueSessionId} />
      )}

      {/* Bottom comment input — the session's only composer. A reply is
          the same box carrying a parent_id, announced by the chip. */}
      <div className="mt-4">
        {/* key={id}: web's /issues/[id] route doesn't remount on
            issueId change, so without an explicit key the editor
            keeps the previous issue's in-memory content and the
            next keystroke would flush it into the new issue's
            draft key. */}
        <CommentInput
          key={`${issueId}:${activeIssueSessionId}`}
          issueId={issueId}
          onSubmit={handleComposerSubmit}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
          // Naming the target session is the only thing that tells the
          // user which of the issue's parallel tracks their comment
          // joins — the composer sits far below the rail's selection.
          placeholder={
            activeIssueSession
              ? t(($) => $.comment.comment_in_session_placeholder, {
                  session: getSessionDisplayName(t, activeIssueSession),
                })
              : undefined
          }
        />
      </div>
    </div>
  );
}
