"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Agent, Attachment, IssueSession, MemberWithUser, TimelineEntry } from "@multiremi/core/types";
import { useCreateComment, useUpdateComment, useDeleteComment, useResolveComment, useToggleCommentReaction } from "@multiremi/core/issues/comment-mutations";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import { SessionLogEntrySchema, type IssueLogBootstrap, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { AttachmentSchema, ReactionSchema } from "@multiremi/core/api/schemas";
import { parseStrictResponse } from "@multiremi/core/api/schema";
import { useWSEvent } from "@multiremi/core/realtime";
import { SessionLogList } from "../../common/session-log/session-log-list";
import { EntryHtml } from "../../common/session-log/entry-html";
import { ReadonlyContent } from "../../editor";
import { useT } from "../../i18n";
import { useResolvedThreads } from "../hooks/use-resolved-threads";
import { getSessionDisplayName } from "../utils/session-display";
import { CommentCard } from "./comment-card";
import { CommentInput, type ReplyTarget } from "./comment-input";
import { IssueLogHead } from "./issue-log-head";
import { ResolvedThreadBar } from "./resolved-thread-bar";
import { SessionAgentStreamRow } from "./session-agent-stream-row";
import { TimelineSkeleton, TimelineUnavailable } from "./timeline-states";
import { IssueSubscribersControl } from "./issue-subscribers-control";
import { LocalDirectoryHint } from "../../projects/components/local-directory-hint";
import { AgentLiveCard } from "./agent-live-card";
import { IssueResultActivityLines } from "./issue-key-results-section";

export const STICK_PIN_THRESHOLD_PX = 24;

interface IssueActivitySectionProps {
  issueId: string;
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

export function IssueActivitySection({ issueId, projectId, members, agents, onShowKeyResults, currentUserId, canModerateComments, activeIssueSessionId: sessionId,
  activeIssueSession, sessionsPending, sessionsFetching, onRetrySessions, highlightCommentId, initialLog, onScrollRoot,
}: IssueActivitySectionProps) {
  const { t } = useT("issues");
  const [activeCommentId, setActiveCommentId] = useState(highlightCommentId ?? null);
  const [tasksReadySessionId, setTasksReadySessionId] = useState("");
  const onTasksReady = useCallback(() => setTasksReadySessionId(sessionId), [sessionId]);
  useEffect(() => setActiveCommentId(highlightCommentId ?? null), [highlightCommentId]);
  const { replica, snapshot, error } = useIssueLog(sessionId, initialLog, activeCommentId ?? undefined);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [paging, setPaging] = useState(false);
  const resolved = useResolvedThreads();
  const create = useCreateComment(issueId, sessionId);
  const update = useUpdateComment(issueId, sessionId);
  const remove = useDeleteComment(issueId, sessionId);
  const resolve = useResolveComment(issueId, sessionId);
  const reaction = useToggleCommentReaction(issueId, sessionId);
  const refresh = useCallback(() => { void replica.refreshVisible().catch(() => {}); }, [replica]);
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
  return <SessionLogList key={`${sessionId}:${activeCommentId ?? "tail"}`} sessionId={sessionId} replica={replica}
    perfScroll="issue-detail" latestAnchor="latest-comment"
    contentReady={initialLog?.sessionId === sessionId || tasksReadySessionId === sessionId}
    anchor={activeCommentId ? { kind: "element", id: `comment-${activeCommentId}` } : { kind: "bottom" }}
    onReturnToLatest={activeCommentId ? () => void returnLatest() : undefined}
    initialPositioned={initialLog?.sessionId === sessionId && (initialLog.targetCommentId ?? null) === activeCommentId}
    onScrollRoot={onScrollRoot}
    afterEntry={entry => entry.seq === 0 ? <>
      {replica.window?.has_more_before && <button type="button" data-log-earlier disabled={paging} className="mt-3 h-8 text-xs text-muted-foreground hover:text-foreground" onClick={() => void earlier()}>
        {replica.window.before_visible_count === undefined
          ? t($ => $.activity.expand_earlier, { count: 30 })
          : t($ => $.activity.remaining_earlier, { count: replica.window.before_visible_count })}
      </button>}
      <div className="mt-4 flex h-8 items-center justify-between">
        <h2 className="text-base font-semibold">{t($ => $.detail.activity_section)}</h2>
        <IssueSubscribersControl issueId={issueId} currentUserId={currentUserId} members={members} agents={agents} />
      </div>
      <LocalDirectoryHint projectId={projectId} />
      <AgentLiveCard key={`${issueId}:${sessionId}`} issueId={issueId} issueSessionId={sessionId}
        onInitialReconcile={onTasksReady} />
      <IssueResultActivityLines issueId={issueId} onShowResults={onShowKeyResults} />
    </> : null}
    renderEntry={({ entry }) => {
      const row = SessionLogEntrySchema.parse(entry);
      if (row.seq === 0) return <IssueLogHead issueId={issueId} entry={row} currentUserId={currentUserId} onSaved={() => replica.refreshHead()} />;
      if (row.kind !== "message" || row.author_type === "system") return <div data-log-kind={row.kind} className="py-2 text-xs text-muted-foreground" role="status">
        <EntryHtml html={row.body_html} markdown={row.body_md} fallback={<ReadonlyContent content={row.body_md} />} />
      </div>;
      const comment = logRowToComment(row);
      if (row.resolved_at && !resolved.expanded.has(row.id)) return <ResolvedThreadBar entry={comment} onExpand={() => resolved.toggle(row.id, true)} />;
      const parent = snapshot.entries.find(e => e.id === row.parent_id);
      const parentRow = parent ? SessionLogEntrySchema.parse(parent) : null;
      return <CommentCard issueId={issueId} entry={comment} bodyHtml={row.body_html} currentUserId={currentUserId}
        canModerate={canModerateComments} onStartReply={setReplyTo}
        parentRef={parentRow ? { id: parentRow.id, actorType: parentRow.author_type, actorId: parentRow.author_id ?? "", preview: parentRow.body_md.slice(0, 120) } : undefined}
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
    </>} />;
}
