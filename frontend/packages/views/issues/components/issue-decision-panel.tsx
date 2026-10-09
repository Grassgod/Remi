"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleHelp, LoaderCircle } from "lucide-react";
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
import { UnifiedQuestionCard } from "../../common/question-card";
import { linkedQuestionId } from "../../common/linked-question";
interface IssueDecisionPanelProps {
  issueId: string; pendingCount: number; showOwnerOnly?: boolean; canAnswer: boolean;
  getActorName: (type: string, id: string) => string;
}
export function IssueDecisionBanner({
  count,
  showOwnerOnly = false,
  onOpen,
}: {
  count: number;
  showOwnerOnly?: boolean;
  onOpen: () => void;
}) {
  const { t } = useT("issues");
  if (count <= 0 && !showOwnerOnly) return null;
  return (
    <button
      type="button"
      className="flex h-10 w-full min-w-0 items-center gap-2 text-left text-sm text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
      data-issue-decision-banner
      onClick={onOpen}
    >
      <CircleHelp className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">
        {count > 0
          ? t(($) => $.responsibility.pending, { count })
          : t(($) => $.responsibility.history)}
      </span>
      <ChevronRight className="size-4 shrink-0" />
    </button>
  );
}

export function IssueDecisionPanel({ issueId, pendingCount, showOwnerOnly = false, getActorName }: IssueDecisionPanelProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const query = useQuery({ ...issueQuestionsOptions(wsId, issueId), enabled: open });
  const pendingQuestions = query.data?.filter(question => question.status === "pending") ?? [];
  const historyQuestions = query.data?.filter(question => question.status !== "pending") ?? [];
  return <><IssueDecisionBanner count={pendingCount} showOwnerOnly={showOwnerOnly} onOpen={() => setOpen(true)} />
    <DecisionPanel open={open} onOpenChange={setOpen} title={t($ => $.responsibility.history)}
      description={t($ => $.responsibility.pending, { count: query.data?.filter(question => question.status === "pending").length ?? pendingCount })}>
        {query.isPending ? <DecisionListSkeleton /> : query.isError ? <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-center"><p role="alert" className="text-sm text-destructive">{t($ => $.detail.decision_load_failed)}</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t($ => $.detail.decision_retry)}</Button></div>
          : query.data?.length ? <div className="space-y-6">
            {pendingQuestions.length > 0 && <DecisionSection title={t($ => $.responsibility.pending_section)}>
              {pendingQuestions.map(question => <UnifiedQuestionCard key={question.id} question={question} getActorName={getActorName} />)}
            </DecisionSection>}
            {historyQuestions.length > 0 && <DecisionSection title={t($ => $.responsibility.history_section)}>
              {historyQuestions.map(question => <UnifiedQuestionCard key={question.id} question={question} getActorName={getActorName} />)}
            </DecisionSection>}
          </div>
          : <p className="text-sm text-muted-foreground">{t($ => $.responsibility.empty)}</p>}
    </DecisionPanel></>;
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
