"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Agent, Attachment, IssueSession, MemberWithUser, TimelineEntry } from "@multiremi/core/types";
import { useCreateComment, useUpdateComment, useDeleteComment, useResolveComment, useToggleCommentReaction } from "@multiremi/core/issues/comment-mutations";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import { useActivityPreferences } from "@multiremi/core/issues/stores";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { SessionLogEntrySchema, type IssueLogBootstrap, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { AttachmentSchema, ReactionSchema } from "@multiremi/core/api/schemas";
import { parseStrictResponse } from "@multiremi/core/api/schema";
import { useWSEvent } from "@multiremi/core/realtime";
import { SessionLogList } from "../../common/session-log/session-log-list";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { eventLayoutEntry, eventSummary, metadataString } from "../../common/session-log/event-summary";
import { useT } from "../../i18n";
import { useResolvedThreads } from "../hooks/use-resolved-threads";
import { getSessionDisplayName } from "../utils/session-display";
import { quotePreview } from "../utils/quote-preview";
import { formatActivity } from "../utils/format-activity";
import { CommentCard } from "./comment-card";
import { CommentInput, type ReplyTarget } from "./comment-input";
import { IssueLogHead } from "./issue-log-head";
import { ResolvedThreadBar } from "./resolved-thread-bar";
import { SessionAgentStreamRow } from "./session-agent-stream-row";
import { TimelineSkeleton, TimelineUnavailable } from "./timeline-states";
import { IssueSubscribersControl } from "./issue-subscribers-control";
import { LocalDirectoryHint } from "../../projects/components/local-directory-hint";
import { AgentLiveCard } from "./agent-live-card";
import { useVisibleResults } from "./issue-key-results-section";
import { IssueLogEventRow } from "./issue-log-event-row";
import { firstTaskResponses, isSystemDetail } from "./issue-log-presentation";
import { IssueTaskPromptDialog } from "./issue-task-prompt-dialog";

export const STICK_PIN_THRESHOLD_PX = 24;

interface IssueActivitySectionProps {
  issueId: string;
  issueTitle: string;
  projectId: string | null;
  currentUserId?: string;
  canModerateComments: boolean;
  members: MemberWithUser[];
  agents: Agent[];
  activeIssueSessionId: string;
  activeIssueSession: IssueSession | null;
  sessionsPending: boolean;
  sessionsFetching: boolean;
  onRetrySessions: () => void;
  scrollContainerEl: HTMLDivElement | null;
  highlightCommentId?: string;
  initialLog?: IssueLogBootstrap;
  onShowKeyResults: () => void;
  onScrollRoot: (el: HTMLDivElement | null) => void;
  onContentReady?: () => void;
}

export function logRowToComment(row: SessionLogRow): TimelineEntry {
  return {
    type: "comment", id: row.id, issue_session_id: row.session_id,
    actor_type: row.author_type, actor_id: row.author_id ?? "", task_id: row.task_id,
    content: row.body_md, parent_id: row.parent_id, created_at: row.created_at, updated_at: row.updated_at,
    resolved_at: row.resolved_at, resolved_by_id: row.resolved_by_id,
    resolved_by_type: row.resolved_by_type === "member" || row.resolved_by_type === "agent" || row.resolved_by_type === "system" ? row.resolved_by_type : null,
    reactions: ReactionSchema.array().safeParse(row.metadata.reactions).data ?? [],
    attachments: parseStrictResponse<Attachment[]>(row.metadata.attachments ?? [], AttachmentSchema.array(), { endpoint: "log.metadata.attachments" }),
  };
}

export function IssueActivitySection({ issueId, issueTitle, projectId, members, agents, onShowKeyResults, currentUserId, canModerateComments, activeIssueSessionId: sessionId,
  activeIssueSession, sessionsPending, sessionsFetching, onRetrySessions, highlightCommentId, initialLog, onScrollRoot, onContentReady,
}: IssueActivitySectionProps) {
  const { t } = useT("issues");
  const { ready: preferencesReady, showSystemDetails, setShowSystemDetails } = useActivityPreferences(currentUserId);
  const scrollRoot = useRef<HTMLDivElement | null>(null);
  const toggleAnchor = useRef<{ pinned: true } | { id: string; top: number } | null>(null);
  const setScrollRoot = useCallback((el: HTMLDivElement | null) => { scrollRoot.current = el; onScrollRoot(el); }, [onScrollRoot]);
  const toggleSystemDetails = (value: boolean) => {
    const root = scrollRoot.current;
    if (root?.dataset.stickState === "pinned") toggleAnchor.current = { pinned: true };
    else if (root) {
      const top = root.getBoundingClientRect().top;
      const survivor = [...root.querySelectorAll<HTMLElement>('[data-perf-item="message"]')]
        .find(row => !row.querySelector("[data-system-detail]") && row.getBoundingClientRect().bottom > top);
      toggleAnchor.current = survivor ? { id: survivor.id, top: survivor.getBoundingClientRect().top } : null;
    }
    setShowSystemDetails(value);
  };
  useLayoutEffect(() => {
    const anchor = toggleAnchor.current;
    const root = scrollRoot.current;
    toggleAnchor.current = null;
    if (!root || !anchor) return;
    if ("pinned" in anchor) root.scrollTop = root.scrollHeight;
    else {
      const row = document.getElementById(anchor.id);
      if (row && root.contains(row)) root.scrollTop += row.getBoundingClientRect().top - anchor.top;
    }
  }, [showSystemDetails]);
  const results = useVisibleResults(issueId);
  const resultsById = useMemo(() => new Map(results.map(result => [result.id, result])), [results]);
  const actorNames = useMemo(() => new Map<string, string>([
    ...agents.map(agent => [`agent:${agent.id}`, agent.name] as const),
    ...members.flatMap(member => [[`member:${member.user_id}`, member.name], [`member:${member.id}`, member.name]] as const),
  ]), [agents, members]);
  const getActorName = (type: string, id: string) => actorNames.get(`${type}:${id}`) ?? "";
  const [promptRow, setPromptRow] = useState<SessionLogRow | null>(null);
  const [activeCommentId, setActiveCommentId] = useState(highlightCommentId ?? null);
  const [tasksReadySessionId, setTasksReadySessionId] = useState("");
  const onTasksReady = useCallback(() => setTasksReadySessionId(sessionId), [sessionId]);
  useEffect(() => setActiveCommentId(highlightCommentId ?? null), [highlightCommentId]);
  const { replica, snapshot, error } = useIssueLog(sessionId, initialLog, activeCommentId ?? undefined);
  const responseDecisions = useRef(new Map<string, SessionLogRow | null>());
  const { responseTurns, taskAgents } = useMemo(() => {
    const rows = snapshot.entries.map(entry => SessionLogEntrySchema.parse(entry));
    const candidates = firstTaskResponses(rows);
    const loadedIds = new Set(rows.map(row => row.id));
    const responseTurns = new Map<string, SessionLogRow>();
    const taskAgents = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "turn" && row.task_id) taskAgents.set(row.task_id, metadataString(row.metadata.assignee_agent_id));
      if (row.kind !== "message") continue;
      const key = `${sessionId}:${row.id}`;
      // Never insert a reference into an already visible comment when an older
      // page arrives. Loaded-window metadata is sufficient on first appearance.
      if (!responseDecisions.current.has(key)) responseDecisions.current.set(key, candidates.get(row.id) ?? null);
      const turn = responseDecisions.current.get(key);
      if (turn && loadedIds.has(turn.id)) responseTurns.set(row.id, turn);
    }
    return { responseTurns, taskAgents };
  }, [snapshot.entries, sessionId]);
  const transformEntries = useCallback((entries: readonly SessionLogEntry[]) => entries
    .filter(entry => showSystemDetails || !isSystemDetail(entry)).map(entry => {
      if (entry.seq > 0 && (entry.kind !== "message" || isSystemDetail(entry))) return eventLayoutEntry(entry);
      return responseTurns.has(entry.id) ? { ...entry, render_version: `${entry.render_version ?? ""}:issue-response-v1` } : entry;
    }), [showSystemDetails, responseTurns]);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [paging, setPaging] = useState(false);
  const resolved = useResolvedThreads();
  const create = useCreateComment(issueId, sessionId);
  const update = useUpdateComment(issueId, sessionId);
  const remove = useDeleteComment(issueId, sessionId);
  const resolve = useResolveComment(issueId, sessionId);
  const reaction = useToggleCommentReaction(issueId, sessionId);
  const refresh = useCallback(() => { void replica.refreshVisible().catch(() => {}); }, [replica]);
  useEffect(() => {
    if ((!sessionId && !sessionsPending) || (error && !snapshot.ready)
      || (sessionId && snapshot.ready && snapshot.entries.every(entry => entry.seq === 0))) onContentReady?.();
  }, [sessionId, sessionsPending, error, snapshot.ready, snapshot.entries, onContentReady]);
  const onLegacyUpdate = useCallback((payload: unknown) => {
    const p = payload as { issue_id?: string; comment?: { issue_id?: string; issue_session_id?: string } };
    if ((p.issue_id ?? p.comment?.issue_id) === issueId && (!p.comment?.issue_session_id || p.comment.issue_session_id === sessionId)) refresh();
  }, [issueId, sessionId, refresh]);
  useWSEvent("comment:created", onLegacyUpdate);
  useWSEvent("comment:updated", onLegacyUpdate);
  useWSEvent("comment:deleted", onLegacyUpdate);
  useWSEvent("comment:resolved", onLegacyUpdate);
  useWSEvent("comment:unresolved", onLegacyUpdate);
  useWSEvent("reaction:added", onLegacyUpdate);
  useWSEvent("reaction:removed", onLegacyUpdate);
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); await replica.refreshVisible(); }
    catch (error) { toast.error(error instanceof Error ? error.message : t($ => $.comment.update_failed)); throw error; }
  };
  const earlier = async () => {
    setPaging(true);
    try { await replica.earlier(); } catch { toast.error(t($ => $.comment.update_failed)); }
    finally { setPaging(false); }
  };
  const newer = async () => {
    setPaging(true);
    try { await replica.newer(); } catch { toast.error(t($ => $.comment.update_failed)); }
    finally { setPaging(false); }
  };
  const returnLatest = async () => {
    setPaging(true);
    try { await replica.loadTail(); setActiveCommentId(null); }
    catch { toast.error(t($ => $.comment.update_failed)); }
    finally { setPaging(false); }
  };
  if (!sessionId) return sessionsPending ? <TimelineSkeleton /> : <TimelineUnavailable onRetry={onRetrySessions} retrying={sessionsFetching} />;
  if (error && !snapshot.ready) return <TimelineUnavailable onRetry={refresh} retrying={false} />;
  return <><SessionLogList key={`${sessionId}:${activeCommentId ?? "tail"}`} sessionId={sessionId} replica={replica}
    transformEntries={transformEntries}
    onRevealed={onContentReady}
    perfScroll="issue-detail" latestAnchor="latest-comment"
    contentReady={initialLog?.sessionId === sessionId || tasksReadySessionId === sessionId}
    anchor={activeCommentId ? { kind: "element", id: `comment-${activeCommentId}` } : { kind: "bottom" }}
    onReturnToLatest={activeCommentId ? () => void returnLatest() : undefined}
    initialPositioned={initialLog?.sessionId === sessionId && (initialLog.targetCommentId ?? null) === activeCommentId}
    initialDisplayReady={preferencesReady}
    onScrollRoot={setScrollRoot}
    afterEntry={entry => entry.seq === 0 ? <>
      {replica.window?.has_more_before && <button type="button" data-log-earlier disabled={paging} className="mt-3 h-8 text-xs text-muted-foreground hover:text-foreground" onClick={() => void earlier()}>
        {replica.window.before_visible_count === undefined
          ? t($ => $.activity.expand_earlier, { count: 30 })
          : t($ => $.activity.remaining_earlier, { count: replica.window.before_visible_count })}
      </button>}
      <div className="mt-4 flex h-8 items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">{t($ => $.detail.activity_section)}</h2>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>{t($ => $.log_event.show_system_details)}</span>
          <Switch size="sm" checked={showSystemDetails} onCheckedChange={toggleSystemDetails} aria-label={t($ => $.log_event.show_system_details)} />
        </div>
        <IssueSubscribersControl issueId={issueId} currentUserId={currentUserId} members={members} agents={agents} />
      </div>
      <LocalDirectoryHint projectId={projectId} />
      <AgentLiveCard key={`${issueId}:${sessionId}`} issueId={issueId} issueSessionId={sessionId}
        onInitialReconcile={onTasksReady} />
    </> : null}
    renderEntry={({ entry }) => {
      const row = SessionLogEntrySchema.parse(entry);
      if (row.seq === 0) return <IssueLogHead issueId={issueId} title={issueTitle} entry={row} currentUserId={currentUserId} onSaved={() => replica.refreshHead()} />;
      if (row.kind !== "message" || isSystemDetail(row)) {
        if (row.metadata.type === "workspace_move_cleared") return <div data-log-kind={row.kind} className="py-2 text-xs text-muted-foreground" role="status">
          {formatActivity({ type: "activity", id: row.id, action: "workspace_move_cleared", details: row.metadata,
            actor_type: row.author_type, actor_id: row.author_id ?? "", created_at: row.created_at }, t)}
        </div>;
        return <IssueLogEventRow row={row} getActorName={getActorName} taskAgents={taskAgents}
          results={resultsById} onShowKeyResults={onShowKeyResults} onOpenTask={setPromptRow} />;
      }
      const comment = logRowToComment(row);
      if (row.resolved_at && !resolved.expanded.has(row.id)) return <ResolvedThreadBar entry={comment} onExpand={() => resolved.toggle(row.id, true)} />;
      const parent = snapshot.entries.find(e => e.id === row.parent_id);
      const parentRow = parent ? SessionLogEntrySchema.parse(parent) : null;
      return <CommentCard issueId={issueId} entry={comment} bodyHtml={row.body_html} currentUserId={currentUserId}
        canModerate={canModerateComments} onStartReply={setReplyTo}
        assignmentRef={responseTurns.has(row.id) ? { title: eventSummary(responseTurns.get(row.id)!.body_md), onOpen: () => setPromptRow(responseTurns.get(row.id)!) } : undefined}
        parentRef={parentRow ? { id: parentRow.id, actorType: parentRow.author_type, actorId: parentRow.author_id ?? "", preview: quotePreview(parentRow.body_md) } : undefined}
        hasReplies={snapshot.entries.some(e => SessionLogEntrySchema.parse(e).parent_id === row.id)}
        onNavigateToParent={id => document.getElementById(`comment-${id}`)?.scrollIntoView({ block: "center" })}
        onEdit={(id, content, attachmentIds) => run(() => update.mutateAsync({ commentId: id, content, attachmentIds }))}
        onDelete={id => run(() => remove.mutateAsync(id))}
        onResolveToggle={(id, value) => { resolved.clear(id); void run(() => resolve.mutateAsync({ commentId: id, resolved: value })); }}
        onCollapseResolved={row.resolved_at ? () => resolved.toggle(row.id, false) : undefined}
        onToggleReaction={(id, emoji) => run(() => reaction.mutateAsync({ commentId: id, emoji, existing: comment.reactions?.find(r => r.emoji === emoji && r.actor_id === currentUserId) }))} />;
    }}
    footer={<>
      {activeCommentId && <div className="flex h-8 items-center gap-4 text-xs">
        {replica.window?.has_more_after && <button type="button" data-log-newer disabled={paging} className="text-muted-foreground hover:text-foreground" onClick={() => void newer()}>
          {t($ => $.activity.expand_newer, { count: 30 })}
        </button>}
        <button type="button" data-log-return-latest disabled={paging} className="text-muted-foreground hover:text-foreground" onClick={() => void returnLatest()}>
          {t($ => $.activity.jump_to_latest)}
        </button>
      </div>}
      <SessionAgentStreamRow issueId={issueId} issueSessionId={sessionId} />
      <div className="mt-4 min-h-32"><CommentInput key={`${issueId}:${sessionId}`} issueId={issueId} replyTo={replyTo} onCancelReply={() => setReplyTo(null)}
        placeholder={activeIssueSession ? t($ => $.comment.comment_in_session_placeholder, { session: getSessionDisplayName(t, activeIssueSession) }) : undefined}
        onSubmit={async (content, attachmentIds) => { await run(() => create.mutateAsync({ content, parentId: replyTo?.commentId, attachmentIds })); setReplyTo(null); }} /></div>
    </>} />
    {promptRow && <IssueTaskPromptDialog key={promptRow.id} issueId={issueId} row={promptRow} getActorName={getActorName} onClose={() => setPromptRow(null)} />}
  </>;
}
