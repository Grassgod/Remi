"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { api } from "@multiremi/core/api";
import type { QuestionView } from "@multiremi/core/api/schemas";
import { parseTaskHumanRequest } from "@multiremi/core/chat/human-requests";
import { issueKeys } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@multiremi/ui/components/ui/dropdown-menu";
import { AppLink } from "../navigation";
import { useT } from "../i18n";
import { Markdown } from "./markdown";
import { QuestionForm, QuestionContext } from "./human-request-dock";
import { DecisionCardFrame, DecisionAnswerArea, DecisionOptions } from "./decision-panel";
import { MessageHeader } from "./message-header";
import { questionAnswerBody, questionAnswerText } from "./question-answer";
import { TaskTraceDialog } from "./task-transcript/task-trace-dialog";
import { questionLocation } from "./question-location";

/** All surfaces operate on the original Q, including cross-session notifications. */
export function UnifiedQuestionCard({ question, getActorName = (_type, id) => id, initiallyShowHistory = false }: { question: QuestionView; getActorName?: (type: string, id: string) => string; initiallyShowHistory?: boolean }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [revise, setRevise] = useState(false);
  const [operation, setOperation] = useState<"escalate" | "transfer" | "present" | "close" | null>(null);
  const [summaryText, setSummaryText] = useState("");
  const [historyOpen, setHistoryOpen] = useState(initiallyShowHistory);
  const [answerOpen, setAnswerOpen] = useState(false);
  const allowed = question.actions.allowed;
  const act = useMutation({ mutationFn: ({ action, response }: { action: "answer" | "escalate" | "transfer" | "present" | "continue" | "close"; response?: Record<string, unknown> }) => api.actOnQuestion(question.id, action, {
    expected_route_revision: question.route_revision, response, reason: reason.trim(), summary: action === "present" ? summaryText.trim() : undefined,
    body_md: action === "answer" ? text.trim() || (response && questionAnswerText(response, question.options)) || undefined : undefined,
    ...(action === "answer" && revise ? { revise: true, expected_answer_revision: question.answer_revision } : {}),
  }), onSuccess: (result) => {
    setRevise(false);
    setOperation(null);
    setReason("");
    qc.setQueryData(["question", wsId, question.id], result);
    void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    void qc.invalidateQueries({ queryKey: ["inbox", wsId] });
  }, onError: () => {
    void qc.invalidateQueries({ queryKey: ["question", wsId, question.id] });
    void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  } });
  const request = parseTaskHumanRequest({ id: question.id, taskId: "", sessionId: question.session_id, kind: "question",
    payload: { message: question.original_message, questions: question.original_questions, context: question.original_context ?? undefined }, status: "pending", createdAt: question.history[0]?.at ?? "", respondedAt: null, respondedBy: null, response: null });
  const canAnswer = revise ? allowed.includes("revise") && Boolean(reason.trim()) : allowed.includes("answer");
  const transferNeeded = Boolean(question.route_reason) || /question_responsibility_changed|Responsibility changed/.test(act.error?.message ?? "");
  const operationLabels = { escalate: t($ => $.responsibility.escalate), transfer: t($ => $.responsibility.refresh_owner), present: t($ => $.responsibility.present), close: t($ => $.responsibility.close) };
  const operations = (["escalate", "transfer", "present", "close"] as const).filter(action => allowed.includes(action) && (action !== "transfer" || transferNeeded));
  const stageLabel = question.stage === "issue_owner" ? t($ => $.responsibility.issue_owner) : question.stage === "parent_owner" ? t($ => $.responsibility.parent_owner) : question.stage === "human" ? t($ => $.responsibility.waiting_human) : question.stage === "unavailable" ? t($ => $.responsibility.unavailable) : question.stage;
  const waitLabels: Record<string, string> = { waiting: t($ => $.responsibility.waiting), detached: t($ => $.responsibility.detached), consumed: t($ => $.responsibility.consumed), continuation_pending: t($ => $.responsibility.continuation_pending), continuation_consumed: t($ => $.responsibility.continuation_consumed), none: t($ => $.responsibility.none) };
  const answeredStatus = question.wait_status === "consumed" || question.wait_status === "continuation_consumed"
    ? t($ => $.responsibility.execution_resumed)
    : question.wait_status === "detached" ? t($ => $.responsibility.resume_needed)
    : question.wait_status === "continuation_pending" || question.wait_status === "waiting" ? t($ => $.responsibility.awaiting_resume)
    : t($ => $.responsibility.saved);
  return <DecisionCardFrame id={question.id}><div data-question-id={question.id}>
    <div className="flex items-start justify-between gap-2">
      <MessageHeader message={{ to_type: question.current_handler?.type ?? "none", to_ref: question.current_handler?.id ?? null,
        to_agent_id: question.current_handler?.type === "agent" ? question.current_handler.id : null,
        to_member_id: question.current_handler?.type === "member" ? question.current_handler.id : null,
        message_kind: "decision", wake_applied: null, wake_reason: null }} getActorName={getActorName} />
      {(operations.length > 0 || allowed.includes("revise")) && <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t($ => $.responsibility.more_actions)} disabled={act.isPending} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {allowed.includes("revise") && <DropdownMenuItem onClick={() => { setRevise(true); setOperation(null); setReason(""); }}>{t($ => $.responsibility.revise)}</DropdownMenuItem>}
          {operations.map(action => <DropdownMenuItem key={action} variant={action === "close" ? "destructive" : "default"} onClick={() => { setOperation(action); setRevise(false); setReason(""); }}>{operationLabels[action]}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
    {question.summary && <section className="rounded bg-muted/40 p-2"><h4 className="mb-1 text-xs font-medium">{t($ => $.responsibility.remi)}</h4><Markdown mode="minimal">{question.summary.body_md}</Markdown></section>}
    {revise && <div className="space-y-2"><h4 className="text-xs font-medium">{t($ => $.responsibility.revise)}</h4>
      <Textarea aria-label={t($ => $.responsibility.revision_reason)} placeholder={t($ => $.responsibility.revision_reason)} value={reason} disabled={act.isPending} onChange={e => setReason(e.target.value)} />
      <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => { setRevise(false); setReason(""); }}>{t($ => $.responsibility.cancel_action)}</Button>
    </div>}
    <section>
      {request && question.original_questions.length > 0 ? <QuestionForm key={`${question.id}:${revise}`} taskId="" request={request} readOnly={!canAnswer || operation !== null} disabled={act.isPending} hideOptions={question.status !== "pending" && !revise}
        onAnswer={response => act.mutateAsync({ action: "answer", response })} /> : <><Markdown mode="minimal">{question.original_message}</Markdown>{question.original_context && <QuestionContext context={question.original_context} />}</>}
    </section>
    {question.status === "answered" && <div className="mt-2 text-xs text-muted-foreground">
      <Button variant="ghost" size="xs" onClick={() => setAnswerOpen(value => !value)} aria-expanded={answerOpen}>{answeredStatus}</Button>
      {answerOpen && question.answer && <Markdown mode="minimal">{questionAnswerBody(question.answer, question.options)}</Markdown>}
    </div>}
    {question.status === "closed" && <p className="mt-2 text-xs text-muted-foreground">{t($ => $.responsibility.closed)}</p>}
    {question.status === "pending" && !allowed.includes("answer") && !revise && <p className="mt-2 text-xs text-muted-foreground">{stageLabel}</p>}
    {!canAnswer && question.status === "pending" && question.original_questions.length === 0 && question.options?.map(option => <span key={option.value} className="inline-block rounded border px-2 py-1 text-xs">{option.label}</span>)}
    {canAnswer && !operation && question.original_questions.length === 0 && <DecisionAnswerArea>
      <DecisionOptions options={question.options ?? []} selected={selected} disabled={act.isPending} onSelect={value => { setSelected([value]); setText(""); }} />
      {question.kind !== "permission" && <Textarea aria-label={t($ => $.responsibility.answer)} value={text} onChange={e => { setText(e.target.value); setSelected([]); }} disabled={act.isPending} />}
      <Button size="sm" disabled={act.isPending || (!text.trim() && selected.length === 0)} onClick={() => act.mutate({ action: "answer", response: question.kind === "permission" ? { option_id: selected[0] } : selected.length ? { selected_options: selected } : { answer: text.trim() } })}>{t($ => $.responsibility.answer)}</Button>
    </DecisionAnswerArea>}
    {operation && allowed.includes(operation) && <div className="space-y-2 border-t pt-3">
      <h4 className="text-xs font-medium">{operationLabels[operation]}</h4>
      {operation === "present" ? <Textarea aria-label={t($ => $.responsibility.remi)} placeholder={t($ => $.responsibility.remi)} value={summaryText} disabled={act.isPending} onChange={e => setSummaryText(e.target.value)} />
        : <Textarea aria-label={t($ => $.responsibility.action_reason)} placeholder={t($ => $.responsibility.action_reason)} value={reason} disabled={act.isPending} onChange={e => setReason(e.target.value)} />}
      <div className="flex gap-2">
        <Button size="sm" variant={operation === "close" ? "destructive" : "outline"} disabled={act.isPending || !(operation === "present" ? summaryText.trim() : reason.trim())} onClick={() => act.mutate({ action: operation })}>{operationLabels[operation]}</Button>
        <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => { setOperation(null); setReason(""); }}>{t($ => $.responsibility.cancel_action)}</Button>
      </div>
    </div>}
    <div className="mt-2 flex flex-wrap gap-2">
      {allowed.includes("continue") && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "continue" })}>{t($ => $.responsibility.continue)}</Button>}
      <Button size="xs" variant="ghost" onClick={() => setHistoryOpen(v => !v)} aria-expanded={historyOpen}>{t($ => $.responsibility.events)} ({question.history.length})</Button>
    </div>
    {act.error && <p role="alert" className="text-xs text-destructive">{act.error.message}</p>}
    {historyOpen && <div className="space-y-2 border-t pt-2 text-xs text-muted-foreground">
      <p data-question-wait-status={question.wait_status}>{waitLabels[question.wait_status] ?? question.wait_status}{question.wait_reason && ` · ${question.wait_reason}`}</p>
      {question.current_handler && <p>{t($ => $.responsibility.handler)} · {getActorName(question.current_handler.type, question.current_handler.id)}</p>}
      {question.route_reason && <p className="break-words">{question.route_reason}</p>}
      <p>{t($ => $.responsibility.revision, { revision: question.route_revision })}</p>
      <AppLink href={questionLocation(paths.inboxItem, question.id)}>{t($ => $.responsibility.source)} · {question.source_issue_id ?? question.session_id}</AppLink>
      {question.recovery && <div className="flex flex-wrap items-center gap-2">
        {question.recovery.continuation_message_id && <AppLink title={question.recovery.continuation_message_id} href={questionLocation(paths.inboxItem, question.id, question.recovery.continuation_message_id)}>{t($ => $.responsibility.continuation_source)}</AppLink>}
        {question.recovery.reply_message_id && <AppLink title={question.recovery.reply_message_id} href={questionLocation(paths.inboxItem, question.id, question.recovery.reply_message_id)}>{t($ => $.responsibility.answer)}</AppLink>}
        {question.recovery.consumer_turn_id && <span>{t($ => $.responsibility.consumer_turn)} · {question.recovery.consumer_turn_id}</span>}
        {question.recovery.consumer_attempt_id && question.recovery.consumer_turn_id && <QuestionConsumptionAttempt attemptId={question.recovery.consumer_attempt_id} turnId={question.recovery.consumer_turn_id} getActorName={getActorName} />}
        {question.recovery.consumed_at && <span>{question.recovery.consumed_at}</span>}
      </div>}
      <ol className="space-y-2">{question.history.map((event, index) => <li key={`${event.at}:${index}`}>
      <p>{event.type === "notify" ? t($ => $.responsibility.source_notification) : event.type} · {event.at} · {event.actor && getActorName(event.actor.type, event.actor.id)} · {event.route_revision}</p>
      {event.handler && <p>{t($ => $.responsibility.handler)} · {getActorName(event.handler.type, event.handler.id)} · {event.handler.id}</p>}
      {event.reason && <Markdown mode="minimal">{event.reason}</Markdown>}
      {event.answer != null && typeof event.answer === "object" && "body_md" in event.answer && typeof event.answer.body_md === "string" && <Markdown mode="minimal">{event.answer.body_md}</Markdown>}
      {event.overturn && <Markdown mode="minimal">{event.overturn}</Markdown>}
      {event.source_message_id && <AppLink href={questionLocation(paths.inboxItem, question.id, event.source_message_id)}>{t($ => $.responsibility.source)} · {event.source_message_id}</AppLink>}
    </li>)}</ol></div>}
  </div></DecisionCardFrame>;
}

function QuestionConsumptionAttempt({ attemptId, turnId, getActorName }: { attemptId: string; turnId: string; getActorName: (type: string, id: string) => string }) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const task = useQuery({ queryKey: ["task-detail", attemptId, turnId], enabled: open, queryFn: () => api.getTask(attemptId, turnId) });
  return <>
    <Button variant="ghost" size="sm" disabled={task.isFetching} onClick={() => { setOpen(true); if (task.isError) void task.refetch(); }}>{t($ => $.responsibility.consumer_attempt)} · {attemptId}</Button>
    {task.isError && <p role="alert">{t($ => $.responsibility.load_failed)}</p>}
    {open && task.data && <TaskTraceDialog task={task.data} agentName={getActorName("agent", task.data.agent_id)} onOpenChange={setOpen} />}
  </>;
}
