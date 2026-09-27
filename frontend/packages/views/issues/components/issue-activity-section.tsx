"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { toast } from "sonner";
import type { Agent, IssueSession, MemberWithUser } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import {
  issueKeys,
  issueSessionResultsOptions,
} from "@multiremi/core/issues/queries";
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
import type { StickState } from "../../common/use-stick-to-bottom";
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
  /** When set, the timeline renders flat and the reveal hook lands on this comment. */
  highlightCommentId?: string;
  onShowKeyResults: () => void;
  /**
   * Gate (i) and gate (ii) for `useAnchoredReveal`, reported upward because the
   * scroll root and the content wrapper live in `IssueDetailMain`.
   */
  onRevealGatesChange: (gates: { dataReady: boolean; layoutSettled: boolean }) => void;
  /** Virtuoso's own "we are at the end" signal, forwarded to the stick hook. */
  onPinToBottom: () => void;
  /**
   * The stick hook's own "go to the end of the content and stay there". The
   * virtualizer's `scrollToIndex(LAST, align: "end")` only puts the last *row*
   * at the bottom edge; below the list sit the agent-stream row and the
   * composer, ~120 px in the fixture, so the container stops inside the
   * virtualizer's 120 px band but outside the hook's 24 px one and never
   * re-pins (MUL-390 `cmt_rblm56fti12j`).
   */
  onReturnToBottom: () => void;
  /**
   * `useStickToBottom`'s state. Follow-the-latest is driven by this alone:
   * Virtuoso's own `atBottom` uses a much wider band (120 px) than the hook's
   * re-pin threshold (24 px), so a small scroll up leaves Virtuoso still
   * "at the bottom" while the hook has already released. Trusting Virtuoso
   * there yanked the reader back to the end on the next comment.
   */
  stickState: StickState;
}

const ISSUE_TIMELINE_INITIAL_FIRST_ITEM_INDEX = 1_000_000;

/**
 * The stick hook's re-pin threshold, in pixels. Passed to the hook explicitly
 * and used for the one decision the consumer makes on its behalf: Virtuoso's
 * `atBottomStateChange` fires from ~120 px away, but `useStickToBottom.pin()`
 * adopts the *current* distance as the offset it then holds, so calling it from
 * inside that wider band pins the page ~119 px short of the end and every later
 * comment maintains that gap (MUL-390 `cmt_rblm56fti12j`). Only pin when the
 * container is genuinely inside the hook's own band.
 */
export const STICK_PIN_THRESHOLD_PX = 24;

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
  onRevealGatesChange,
  onPinToBottom,
  onReturnToBottom,
  stickState,
}: IssueActivitySectionProps) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const { getActorName } = useActorName();

  const {
    timeline, latestTimeline, loading: timelineLoading,
    fetchOlderTimeline, hasOlderTimeline, isFetchingOlderTimeline,
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
  const latestItems = useMemo<TimelineItem[]>(
    () => flattenGroups(buildTimelineView(latestTimeline).groups, expandedResolved),
    [latestTimeline, expandedResolved],
  );
  // Activity events can collapse into a single visual group. Derive the
  // prepend delta from rendered rows so Virtuoso's logical index decreases by
  // exactly the number of rows inserted above the current viewport.
  const olderItemCount = Math.max(0, items.length - latestItems.length);
  const firstItemIndex = items.length > 0
    ? ISSUE_TIMELINE_INITIAL_FIRST_ITEM_INDEX - olderItemCount
    : 0;

  const highlightLoaded = !highlightCommentId
    || timeline.some((entry) => entry.id === highlightCommentId);
  useEffect(() => {
    if (
      !highlightCommentId
      || highlightLoaded
      || !hasOlderTimeline
      || isFetchingOlderTimeline
    ) return;
    // The explicit deep-link render path is flat rather than virtualized, so
    // it has no startReached callback to pull a target outside page zero.
    void fetchOlderTimeline();
  }, [
    fetchOlderTimeline,
    hasOlderTimeline,
    highlightCommentId,
    highlightLoaded,
    isFetchingOlderTimeline,
  ]);

  // The initial window is chronological and mounts directly at its last row.
  // There is no post-fetch imperative scroll, so opening does not first paint
  // at the top and then jump to the bottom.
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Gate (ii): Virtuoso measures row heights asynchronously, so the container's
  // height is still converging after the data arrives. The reveal hook must not
  // position against a height that is about to change. Both callbacks firing
  // once is the cheapest honest signal that the measurement has settled; the
  // flat deep-link path mounts every row synchronously and is settled by
  // construction, which `highlightCommentId` expresses below.
  const [measuredTotalHeight, setMeasuredTotalHeight] = useState(false);
  const [measuredRange, setMeasuredRange] = useState(false);
  const virtuosoLayoutSettled = measuredTotalHeight && measuredRange;

  // `followOutput` and `atBottomStateChange` are handed to Virtuoso once and
  // called from its own scroll handling, so they must read the *current* stick
  // state rather than the one captured when the prop was created.
  const stickStateRef = useRef<StickState>(stickState);
  stickStateRef.current = stickState;

  /**
   * Whether the reader has driven the page back towards the end since the last
   * release. Virtuoso's at-bottom band is 120 px wide, which is roughly the
   * composer below the list, while the stick hook releases on any upward wheel
   * and re-pins only within 24 px. The band alone therefore cannot tell "the
   * reader is heading back to the end" from "the reader is parked 30–119 px up
   * and never moved down"; only the second is what must not re-pin
   * (MUL-390 `cmt_i1xic8rs050s`).
   */
  const sawDownwardScrollRef = useRef(false);

  // A downward scroll while the hook is not pinned is the reader driving, not
  // the hook: its own ResizeObserver compensation only runs while pinned, and
  // `followOutput` no longer scrolls unless pinned either. That covers wheel,
  // keys, touch drags and scrollbar drags without re-deriving each gesture.
  useEffect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      // Only the reader's own travel counts as intent. `returning` is the
      // hook's own trip to the end (its `returnToBottom()`), and counting that
      // would let Virtuoso's wider band pin the container part-way down.
      if (top > lastTop + 1 && stickStateRef.current === "released") {
        sawDownwardScrollRef.current = true;
      }
      lastTop = top;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerEl]);

  // Once the hook is pinned again the intent has been honoured; a later release
  // has to earn its own.
  useEffect(() => {
    if (stickState === "pinned") sawDownwardScrollRef.current = false;
  }, [stickState]);

  /**
   * "Back to latest" goes through the stick hook rather than the virtualizer.
   *
   * `scrollToIndex({ index: "LAST", align: "end" })` only puts the last *row* at
   * the bottom edge of the viewport. The agent-stream row and the composer sit
   * below the list inside the same scroll container, ~120 px of it in the
   * 250-comment fixture, so the container came to rest inside the virtualizer's
   * 120 px "at bottom" band but outside the hook's 24 px one: the trip never
   * reached the end, the hook stayed `released`, and the next comment did not
   * follow (MUL-390 `cmt_rblm56fti12j`). The hook's `returnToBottom()` travels
   * to the end of the *content* and then pins on its own 24 px rule, which also
   * anchors at the true bottom instead of whatever distance it stopped at.
   *
   * Nothing here marks downward intent: the trip is the hook's, not the
   * reader's, and Virtuoso still reports `atBottom` from 120 px away while it
   * glides. Letting that signal pin would anchor the machine part-way down.
   */
  const jumpToLatest = useCallback(() => {
    onReturnToBottom();
  }, [onReturnToBottom]);

  // The container's distance to the true end, for the at-bottom decision below.
  const bottomDistance = useCallback((): number => {
    const el = scrollContainerEl;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [scrollContainerEl]);

  // A comment that lands while the return trip is still gliding makes the
  // content taller under a trip whose destination was computed when the button
  // was pressed. The browser then finishes at the *old* end, which is now more
  // than the hook's 24 px threshold away, so the hook releases instead of
  // pinning and the newest row sits below the fold.
  //
  // Watching `scrollHeight` on a frame loop (rather than on scroll events) also
  // covers the narrow case where the row lands after the glide has stopped but
  // before the hook's 100 ms settle timer fires: no scroll event accompanies
  // that growth, so an event-driven re-aim would miss it and the timer would
  // release. The loop is bounded by `returning`, which the hook ends as soon as
  // the scrolling goes quiet or the reader takes over.
  useEffect(() => {
    if (stickState !== "returning") return;
    const el = scrollContainerEl;
    if (!el) return;
    let frame = 0;
    let height = el.scrollHeight;
    const tick = () => {
      const grown = el.scrollHeight;
      if (grown !== height) {
        height = grown;
        const top = Math.max(0, grown - el.clientHeight);
        if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" });
        else el.scrollTop = top;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [stickState, scrollContainerEl]);

  const lastActivityId = useMemo(
    () => lastActivityGroupId(timelineView.groups),
    [timelineView.groups],
  );

  // Gate (i): everything above the timeline that can push it down has to have
  // settled before the reveal positions the page.
  //
  //   - the owning session resolved, or the session list came back empty and
  //     `TimelineUnavailable` is the terminal state;
  //   - the timeline itself finished its first load;
  //   - `issueKeys.tasks(issueId)` settled, because `SessionAgentStreamRow`
  //     sits at the foot of the list and pops in once it resolves;
  //   - on a deep link, the target comment is part of the loaded window.
  //
  // The description, sub-issues, published results and the live agent card are
  // deliberately *not* gated: all four sit above the timeline, and the stick
  // hook compensates for them arriving late without moving the viewport. Gate
  // on them too and a slow sub-issue query would hold the whole page behind the
  // skeleton instead.
  const sessionResolved = Boolean(activeIssueSessionId) || !sessionsPending;
  // Same cache entry as `SessionAgentStreamRow` below — this observer exists so
  // the gate can wait for it on screens where the row itself never mounts.
  const { isPending: tasksPending } = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    enabled: sessionResolved,
  });
  const dataReady = sessionResolved
    && !timelineLoading
    && !tasksPending
    && (!highlightCommentId || highlightLoaded);

  // The gate only applies where something is going to be measured. Virtuoso is
  // not mounted in three cases — the deep link renders flat, the session list
  // came back empty (so `TimelineUnavailable` is the terminal state), or every
  // loaded session is still empty — and in all three the document is settled by
  // construction. Leaving the gate false there would hold the page behind the
  // skeleton until the reveal budget expired.
  const virtuosoMounted = !highlightCommentId
    && Boolean(activeIssueSessionId)
    && scrollContainerEl !== null
    && items.length > 0;
  const layoutSettled = virtuosoMounted ? virtuosoLayoutSettled : true;

  useEffect(() => {
    onRevealGatesChange({ dataReady, layoutSettled });
  }, [dataReady, layoutSettled, onRevealGatesChange]);

  // Deep-link landing: the scroll position itself is owned by
  // `useAnchoredReveal` in `IssueDetailMain`, which places the target before
  // anything is visible. Doing it here as well would move the viewport a second
  // time, after the reveal, which is exactly the jump this issue removes — the
  // effect that used to call `scrollIntoView` is gone on purpose.
  //
  // What remains is the 2.5 s highlight. It has to start once the timeline has
  // actually rendered the target, so it keys off the flat path's item list
  // rather than off the position.
  useEffect(() => {
    if (!highlightCommentId || items.length === 0) return;
    if (didHighlightRef.current === highlightCommentId) return;
    if (!document.getElementById(`comment-${highlightCommentId}`)) return;

    didHighlightRef.current = highlightCommentId;
    setHighlightedId(highlightCommentId);
    const fade = window.setTimeout(() => setHighlightedId(null), 2500);
    return () => clearTimeout(fade);
  }, [highlightCommentId, items]);

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
  //
  // `data-perf-*` is the measurement contract for the MUL-384 page-speed probe:
  // `data-perf-item` marks a row holding real data (skeletons never carry it),
  // `data-perf-key` keys it for frame-to-frame comparison, and the anchors let
  // the probe find the terminal elements. Attributes only — no behavior here.
  // The newest row by identity, not by index: Virtuoso hands this renderer a
  // logical index offset by `firstItemIndex`, so `_i === items.length - 1` never
  // matches and the terminal anchor would silently never render.
  const latestItemId = items.length > 0 ? items[items.length - 1]!.id : null;
  const renderItem = (_i: number, item: TimelineItem): React.ReactElement => {
    const perfItem = {
      "data-perf-item": item.kind === "activity-group" ? "activity" : item.kind,
      "data-perf-key": item.id,
    } as const;
    const perfAnchor = item.id === highlightCommentId ? { "data-perf-anchor": "target-comment" } : null;
    // The last row of the list is where the reading position settles; the probe
    // treats it as the terminal element when no agent stream row is rendered.
    const perfLatest = item.id === latestItemId ? { "data-perf-anchor": "latest-comment" } : null;
    if (item.kind === "resolved-bar") {
      return (
        <div className="pb-3" id={`comment-${item.id}`} {...perfItem} {...perfLatest} {...perfAnchor}>
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
        <div className="pb-3" id={`comment-${item.id}`} {...perfItem} {...perfLatest} {...perfAnchor}>
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
      <div {...perfItem} {...perfLatest}>
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
      </div>
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
                ref={virtuosoRef}
                key={`${wsId}:${issueId}:${activeIssueSessionId}`}
                customScrollParent={scrollContainerEl}
                data={items}
                firstItemIndex={firstItemIndex}
                initialTopMostItemIndex={{ index: "LAST", align: "end" }}
                increaseViewportBy={{ top: 800, bottom: 800 }}
                computeItemKey={(_i, item) => `${item.kind}:${item.id}`}
                skipAnimationFrameInResizeObserver
                atBottomThreshold={120}
                atBottomStateChange={(bottom) => {
                  setAtBottom(bottom);
                  // Virtuoso's band is 120 px wide while the hook re-pins at
                  // 24 px, so this signal alone must not re-pin: a reader who
                  // scrolled up by 30 px is inside Virtuoso's band but outside
                  // the hook's, and pinning there is the same yank by another
                  // route. Re-pin only once the reader has actually come back
                  // to the end of the stream — the hook's own state has to say
                  // so, and a downward-intent flag says the user drove it.
                  if (
                    bottom
                    && sawDownwardScrollRef.current
                    && stickStateRef.current !== "returning"
                    && bottomDistance() <= STICK_PIN_THRESHOLD_PX
                  ) {
                    onPinToBottom();
                  }
                }}
                totalListHeightChanged={() => setMeasuredTotalHeight(true)}
                rangeChanged={() => setMeasuredRange(true)}
                // Follow-the-latest is the stick hook's decision, not
                // Virtuoso's: `atBottom` here means "within 120 px", so using
                // it let a 25–119 px scroll up still chase the newest comment
                // (QA, MUL-390 cmt_i1xic8rs050s). `pinned` is the hook's own
                // 24 px contract; `released` and `returning` deliberately do
                // not follow.
                followOutput={() => (
                  !isFetchingOlderTimeline && stickStateRef.current === "pinned"
                    ? "smooth"
                    : false
                )}
                startReached={() => {
                  if (hasOlderTimeline && !isFetchingOlderTimeline) {
                    void fetchOlderTimeline();
                  }
                }}
                components={{
                  Header: () => isFetchingOlderTimeline ? (
                    <div className="pb-3 text-center text-xs text-muted-foreground">
                      {t(($) => $.activity.loading_older)}
                    </div>
                  ) : null,
                }}
                itemContent={renderItem}
              />
              {!atBottom && (
                <div className="pointer-events-none sticky bottom-4 z-10 flex h-0 items-end justify-center">
                  <button
                    type="button"
                    onClick={jumpToLatest}
                    className="pointer-events-auto flex -translate-y-2 items-center gap-1 rounded-full border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-md transition-colors hover:text-foreground"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                    {t(($) => $.activity.jump_to_latest)}
                  </button>
                </div>
              )}
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
