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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multiremi/ui/components/ui/sheet";
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
  return <><IssueDecisionBanner count={pendingCount} showOwnerOnly={showOwnerOnly} onOpen={() => setOpen(true)} />
    <Sheet open={open} onOpenChange={setOpen}><SheetContent side="right"
      className="inset-y-2 right-2 h-auto max-h-[calc(100vh-1rem)] w-[calc(100%-1rem)] gap-0 overflow-hidden rounded-md border sm:top-8 sm:bottom-auto sm:h-[610px] sm:w-[440px] sm:max-w-[440px]" data-issue-decision-overlay>
      <SheetHeader className="shrink-0 border-b pr-12"><SheetTitle>{t($ => $.responsibility.history)}</SheetTitle>
        <SheetDescription>{t($ => $.responsibility.pending, { count: query.data?.filter(question => question.status === "pending").length ?? pendingCount })}</SheetDescription></SheetHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {query.isPending ? <LoaderCircle className="size-5 animate-spin" /> : query.isError ? <div><p role="alert">{t($ => $.detail.decision_load_failed)}</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t($ => $.detail.decision_retry)}</Button></div>
          : query.data?.length ? query.data.map(question => <UnifiedQuestionCard key={question.id} question={question} getActorName={getActorName} />)
          : <p className="text-sm text-muted-foreground">{t($ => $.responsibility.empty)}</p>}
      </div>
    </SheetContent></Sheet></>;
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
  return <article className="rounded-md border bg-background p-3" data-decision-entry={message.id}>
    <MessageHeader message={message} getActorName={getActorName} /><Markdown mode="minimal">{message.body_md}</Markdown>
    {message.resolved_at || reply.isSuccess ? <div className="mt-2 text-xs text-muted-foreground">
      <Button variant="ghost" size="xs" onClick={() => setShowReplies(v => !v)}>{tm($ => $.resolved)}</Button>
      {showReplies && (replies.isError ? <p role="alert">{tm($ => $.load_failed)}</p> : replies.data?.filter(m => m.reply_to_id === message.id).map(m => <Markdown key={m.id} mode="minimal">{m.body_md}</Markdown>))}
    </div> : request ? <HumanRequestCard taskId={request.taskId} request={request} readOnly={!canAnswer} onResponded={refresh} />
    : canAnswer && <div className="mt-3 space-y-2 border-t pt-2.5">
      {message.options?.length ? <div className="flex flex-wrap gap-1.5">{message.options.map(option => <Button key={option.value} size="sm"
        variant={selected === option.value ? "default" : "outline"} aria-pressed={selected === option.value} disabled={reply.isPending}
        className="h-auto max-w-full whitespace-normal break-words text-left" onClick={() => setSelected(option.value)}>{option.label}</Button>)}</div>
        : <Textarea value={answer} disabled={reply.isPending} placeholder={t($ => $.detail.decision_answer_placeholder)} onChange={e => setAnswer(e.target.value)} />}
      <Input value={reason} disabled={reply.isPending} placeholder={t($ => $.detail.decision_reason_placeholder)} onChange={e => setReason(e.target.value)} />
      {reply.error && <p role="alert" className="text-xs text-destructive">{reply.error.message}</p>}
      <Button size="sm" disabled={reply.isPending || (selected == null && !answer.trim())} onClick={() => reply.mutate()}>{tm($ => $.decision_reply)}</Button>
    </div>}
  </article>;
}
