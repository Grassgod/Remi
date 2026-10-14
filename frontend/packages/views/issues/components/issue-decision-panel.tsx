"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleHelp, LoaderCircle } from "lucide-react";
import { api } from "@multiremi/core/api";
import type { Message } from "@multiremi/core/api/schemas";
import { parseTaskHumanRequest } from "@multiremi/core/chat/human-requests";
import { issueKeys, issueQuestionsOptions } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { DecisionPanel, DecisionCardFrame, DecisionAnswerArea, DecisionOptions, DecisionSection, DecisionListSkeleton } from "../../common/decision-panel";
import { HumanRequestCard } from "../../common/human-request-dock";
import { MessageHeader } from "../../common/message-header";
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import { UnifiedQuestionCard, questionSection } from "../../common/question-card";
import { linkedQuestionId } from "../../common/linked-question";

type ActorName = (type: string, id: string) => string;

/** The notice-slot bar. Only this Issue's questions at the human stage count; Agent-held ones never do. */
export function IssueDecisionBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useT("issues");
  if (count <= 0) return null;
  return (
    <div className="flex h-10 w-full min-w-0 items-center gap-2 text-sm text-blue-700 dark:text-blue-300" data-issue-decision-banner>
      <CircleHelp className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">{t(($) => $.responsibility.pending, { count })}</span>
      <Button size="sm" className="h-7 shrink-0" aria-haspopup="dialog" onClick={onOpen}>{t(($) => $.responsibility.answer_action)}</Button>
    </div>
  );
}

/**
 * The Issue's question drawer, over the page rather than in the rail. Its count
 * matches the banner: this Issue's own questions at the human stage. Those come
 * first, then sub-issues' human-stage questions, then those Agents still hold;
 * answered and closed ones stay folded. A question shown as pending keeps its
 * place while the drawer is open, and callers keep the drawer mounted outside
 * the notice slot, so answering the last question hides the banner but leaves
 * its result on screen.
 */
export function IssueDecisionDrawer({ issueId, open, onOpenChange, pendingCount = 0, getActorName }: {
  issueId: string; open: boolean; onOpenChange: (open: boolean) => void; pendingCount?: number; getActorName: ActorName;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const query = useQuery({ ...issueQuestionsOptions(wsId, issueId), enabled: open });
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { if (!open) setHistoryOpen(false); }, [open]);
  const shown = useRef(new Set<string>());
  if (!open) shown.current.clear();
  const questions = query.data ?? [];
  if (open) for (const question of questions) if (questionSection(question) === "pending") shown.current.add(question.id);
  const kept = questions.filter(question => shown.current.has(question.id));
  const own = kept.filter(question => question.source_issue_id === issueId);
  const subIssues = kept.filter(question => question.source_issue_id !== issueId);
  const agent = questions.filter(question => !shown.current.has(question.id) && questionSection(question) === "agent");
  const history = questions.filter(question => !shown.current.has(question.id) && questionSection(question) === "history");
  const count = query.data ? own.filter(question => question.status === "pending" && question.stage === "human").length : pendingCount;
  const cards = (list: typeof questions) => list.map(question => <UnifiedQuestionCard key={question.id} question={question} getActorName={getActorName} />);
  const section = (title: string, list: typeof questions) => list.length > 0 && <DecisionSection title={title}>{cards(list)}</DecisionSection>;
  const historyTitle = t($ => $.responsibility.history_section);
  return <DecisionPanel open={open} onOpenChange={onOpenChange} title={t($ => $.responsibility.drawer_title)}
    description={count > 0 ? t($ => $.responsibility.pending, { count }) : t($ => $.responsibility.pending_none)}>
    {query.isPending ? <DecisionListSkeleton /> : query.isError ? <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-center"><p role="alert" className="text-sm text-destructive">{t($ => $.detail.decision_load_failed)}</p>
      <Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t($ => $.detail.decision_retry)}</Button></div>
      : questions.length ? <div className="space-y-6">
        {section(t($ => $.responsibility.pending_section), own)}
        {section(t($ => $.responsibility.sub_issue_pending_section), subIssues)}
        {section(t($ => $.responsibility.agent_section), agent)}
        {history.length > 0 && <section className="space-y-2.5" aria-label={historyTitle}>
          <Button size="xs" variant="ghost" className="-ml-2 text-xs font-semibold text-muted-foreground" aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? <ChevronDown /> : <ChevronRight />}{historyTitle} ({history.length})</Button>
          {historyOpen && cards(history)}
        </section>}
      </div>
      : <p className="text-sm text-muted-foreground">{t($ => $.responsibility.empty)}</p>}
  </DecisionPanel>;
}

export function MessageDecisionCard(props: { message: Message; canAnswer: boolean; getActorName?: (type: string, id: string) => string }) {
  const wsId = useWorkspaceId();
  const unified = linkedQuestionId(props.message.id, props.message.metadata);
  const questionId = unified ?? props.message.id;
  const question = useQuery({ queryKey: ["question", wsId, questionId], queryFn: () => api.getQuestion(questionId), enabled: Boolean(unified) });
  const { t } = useT("issues");
  if (unified) return question.data ? <UnifiedQuestionCard question={question.data} getActorName={props.getActorName} /> : question.isError ? <div role="alert">{t($ => $.responsibility.load_failed)}<Button onClick={() => void question.refetch()}>{t($ => $.responsibility.retry)}</Button></div> : <LoaderCircle className="size-5 animate-spin" />;
  return <LegacyMessageDecisionCard {...props} />;
}

function LegacyMessageDecisionCard({ message, canAnswer, getActorName }: { message: Message; canAnswer: boolean; getActorName?: (type: string, id: string) => string }) {
  const { t } = useT("issues");
  const { t: tm } = useT("messages");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [showReplies, setShowReplies] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) }); void qc.invalidateQueries({ queryKey: ["inbox", wsId] }); };
  const reply = useMutation({ mutationFn: () => api.sendMessage(message.session_id, {
    body_md: selected == null ? answer.trim() : message.options?.find(o => o.value === selected)?.label ?? "",
    message_kind: "reply", reply_to_id: message.id,
    metadata: selected == null ? undefined : { selected_options: [selected] },
    response: { reason: reason.trim(), overturn: "", ...(selected == null ? {} : { selected_options: [selected] }) },
  }), onSettled: refresh });
  const replies = useQuery({ queryKey: ["decision-replies", wsId, message.id], enabled: showReplies,
    queryFn: async () => {
      const messages: Message[] = [];
      let cursor: string | undefined;
      do { const page = await api.listMessages(message.session_id, { thread: message.id, cursor }); messages.push(...page.messages); cursor = page.next_cursor ?? undefined; } while (cursor);
      return messages;
    } });
  const record = message.metadata.human_request;
  const request = record && typeof record === "object" ? parseTaskHumanRequest({ ...record,
    id: message.id, taskId: message.task_id ?? "", sessionId: message.session_id,
    createdAt: message.created_at, respondedAt: null, respondedBy: null,
    response: null, status: message.resolved_at ? "responded" : "pending",
  }) : null;
  return <DecisionCardFrame id={message.id}>
    <MessageHeader message={message} getActorName={getActorName} /><Markdown mode="minimal">{message.body_md}</Markdown>
    {message.resolved_at || reply.isSuccess ? <div className="mt-2 text-xs text-muted-foreground">
      <Button variant="ghost" size="xs" onClick={() => setShowReplies(v => !v)}>{tm($ => $.resolved)}</Button>
      {showReplies && (replies.isError ? <p role="alert">{tm($ => $.load_failed)}</p> : replies.data?.filter(m => m.reply_to_id === message.id).map(m => <Markdown key={m.id} mode="minimal">{m.body_md}</Markdown>))}
    </div> : request ? <HumanRequestCard taskId={request.taskId} request={request} readOnly={!canAnswer} onResponded={refresh} />
    : canAnswer && <DecisionAnswerArea>
      {message.options?.length ? <DecisionOptions options={message.options} selected={selected === null ? [] : [selected]} disabled={reply.isPending} onSelect={setSelected} />
        : <Textarea value={answer} disabled={reply.isPending} placeholder={t($ => $.detail.decision_answer_placeholder)} onChange={e => setAnswer(e.target.value)} />}
      <Input value={reason} disabled={reply.isPending} placeholder={t($ => $.detail.decision_reason_placeholder)} onChange={e => setReason(e.target.value)} />
      {reply.error && <p role="alert" className="text-xs text-destructive">{reply.error.message}</p>}
      <Button size="sm" disabled={reply.isPending || (selected == null && !answer.trim())} onClick={() => reply.mutate()}>{tm($ => $.decision_reply)}</Button>
    </DecisionAnswerArea>}
  </DecisionCardFrame>;
}
