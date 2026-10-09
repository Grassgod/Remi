"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import type { QuestionView } from "@multiremi/core/api/schemas";
import { parseTaskHumanRequest } from "@multiremi/core/chat/human-requests";
import { issueKeys } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { AppLink } from "../navigation";
import { useT } from "../i18n";
import { Markdown } from "./markdown";
import { QuestionCard, QuestionContext } from "./human-request-dock";
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
  const [historyOpen, setHistoryOpen] = useState(initiallyShowHistory);
  const allowed = question.actions.allowed;
  const act = useMutation({ mutationFn: ({ action, response }: { action: "answer" | "escalate" | "transfer" | "present" | "continue" | "close"; response?: Record<string, unknown> }) => api.actOnQuestion(question.id, action, {
    expected_route_revision: question.route_revision, response, reason: reason.trim(), summary: action === "present" ? text.trim() : undefined,
    body_md: action === "answer" ? text.trim() || undefined : undefined,
    ...(action === "answer" && revise ? { revise: true, expected_answer_revision: question.answer_revision } : {}),
  }), onSuccess: (result) => {
    setRevise(false);
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
  const stageLabel = question.stage === "issue_owner" ? t($ => $.responsibility.issue_owner) : question.stage === "parent_owner" ? t($ => $.responsibility.parent_owner) : question.stage === "human" ? t($ => $.responsibility.waiting_human) : question.stage === "unavailable" ? t($ => $.responsibility.unavailable) : question.stage;
  const waitLabels: Record<string, string> = { waiting: t($ => $.responsibility.waiting), detached: t($ => $.responsibility.detached), consumed: t($ => $.responsibility.consumed), continuation_pending: t($ => $.responsibility.continuation_pending), continuation_consumed: t($ => $.responsibility.continuation_consumed), none: t($ => $.responsibility.none) };
  return <article className="min-w-0 space-y-3 rounded-md border bg-background p-3" data-question-id={question.id}>
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">{question.status === "pending" ? stageLabel : question.status === "answered" ? t($ => $.responsibility.saved) : question.status === "closed" ? t($ => $.responsibility.closed) : question.status}</p>
      {question.current_handler && <p className="break-words">{t($ => $.responsibility.handler)}: {getActorName(question.current_handler.type, question.current_handler.id)} · {question.current_handler.id}</p>}
      <p>{t($ => $.responsibility.revision, { revision: question.route_revision })}</p>
      {question.route_reason && <p className="break-words">{question.route_reason}</p>}
      <AppLink href={questionLocation(paths.inboxItem, question.id)}>{t($ => $.responsibility.source)} · {question.source_issue_id ?? question.session_id} · {question.source_agent_id && getActorName("agent", question.source_agent_id)}</AppLink>
    </div>
    <section><h4 className="mb-1 text-xs font-medium">{t($ => $.responsibility.original)}</h4>
      {request && question.original_questions.length > 0 ? <QuestionCard key={`${question.id}:${revise}`} taskId="" request={request} readOnly={!canAnswer || act.isPending}
        onAnswer={response => act.mutateAsync({ action: "answer", response })} /> : <><Markdown mode="minimal">{question.original_message}</Markdown>{question.original_context && <QuestionContext context={question.original_context} />}</>}
    </section>
    {question.summary && <section className="rounded bg-muted/40 p-2"><h4 className="mb-1 text-xs font-medium">{t($ => $.responsibility.remi)}</h4><Markdown mode="minimal">{question.summary.body_md}</Markdown></section>}
    <p className="text-xs text-muted-foreground" data-question-wait-status={question.wait_status}>{waitLabels[question.wait_status] ?? question.wait_status}{question.wait_reason && ` · ${question.wait_reason}`}</p>
    {question.recovery && <div className="flex flex-wrap items-center gap-2 text-xs">
      {question.recovery.continuation_message_id && <AppLink title={question.recovery.continuation_message_id} href={questionLocation(paths.inboxItem, question.id, question.recovery.continuation_message_id)}>{t($ => $.responsibility.continuation_source)}</AppLink>}
      {question.recovery.reply_message_id && <AppLink title={question.recovery.reply_message_id} href={questionLocation(paths.inboxItem, question.id, question.recovery.reply_message_id)}>{t($ => $.responsibility.answer)}</AppLink>}
      {question.recovery.consumer_turn_id && <span>{t($ => $.responsibility.consumer_turn)} · {question.recovery.consumer_turn_id}</span>}
      {question.recovery.consumer_attempt_id && question.recovery.consumer_turn_id && <QuestionConsumptionAttempt attemptId={question.recovery.consumer_attempt_id} turnId={question.recovery.consumer_turn_id} getActorName={getActorName} />}
      {question.recovery.consumed_at && <span>{question.recovery.consumed_at}</span>}
    </div>}
    {question.answer && <section><h4 className="text-xs font-medium">{getActorName(question.answer.actor.type, question.answer.actor.id)} · {question.answer.at}</h4><Markdown mode="minimal">{question.answer.body_md || JSON.stringify(question.answer.response)}</Markdown></section>}
    {!canAnswer && question.original_questions.length === 0 && question.options?.map(option => <span key={option.value} className="inline-block rounded border px-2 py-1 text-xs">{option.label}</span>)}
    {canAnswer && question.original_questions.length === 0 && <div className="space-y-2">
      {question.options?.map(option => <Button key={option.value} size="sm" variant={selected.includes(option.value) ? "default" : "outline"} aria-pressed={selected.includes(option.value)} disabled={act.isPending} onClick={() => { setSelected([option.value]); setText(""); }}>{option.label}</Button>)}
      {question.kind !== "permission" && <Textarea aria-label={t($ => $.responsibility.answer)} value={text} onChange={e => { setText(e.target.value); setSelected([]); }} disabled={act.isPending} />}
      <Button size="sm" disabled={act.isPending || (!text.trim() && selected.length === 0)} onClick={() => act.mutate({ action: "answer", response: question.kind === "permission" ? { option_id: selected[0] } : selected.length ? { selected_options: selected } : { answer: text.trim() } })}>{t($ => $.responsibility.answer)}</Button>
    </div>}
    {(revise || allowed.some(action => ["escalate", "transfer", "present", "close"].includes(action))) && <Textarea aria-label={t($ => $.responsibility.reason)} placeholder={t($ => $.responsibility.reason)} value={reason} disabled={act.isPending} onChange={e => setReason(e.target.value)} />}
    {allowed.includes("present") && <Textarea aria-label={t($ => $.responsibility.remi)} placeholder={t($ => $.responsibility.remi)} value={text} disabled={act.isPending} onChange={e => setText(e.target.value)} />}
    <div className="flex flex-wrap gap-2">
      {allowed.includes("revise") && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => setRevise(v => !v)} aria-pressed={revise}>{t($ => $.responsibility.revise)}</Button>}
      {allowed.includes("escalate") && <Button size="sm" variant="outline" disabled={act.isPending || !reason.trim()} onClick={() => act.mutate({ action: "escalate" })}>{t($ => $.responsibility.escalate)}</Button>}
      {allowed.includes("transfer") && <Button size="sm" variant="outline" disabled={act.isPending || !reason.trim()} onClick={() => act.mutate({ action: "transfer" })}>{t($ => $.responsibility.refresh_owner)}</Button>}
      {allowed.includes("present") && <Button size="sm" variant="outline" disabled={act.isPending || !text.trim()} onClick={() => act.mutate({ action: "present" })}>{t($ => $.responsibility.present)}</Button>}
      {allowed.includes("continue") && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "continue" })}>{t($ => $.responsibility.continue)}</Button>}
      {allowed.includes("close") && <Button size="sm" variant="outline" disabled={act.isPending || !reason.trim()} onClick={() => act.mutate({ action: "close" })}>{t($ => $.responsibility.close)}</Button>}
      <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(v => !v)} aria-expanded={historyOpen}>{t($ => $.responsibility.events)} ({question.history.length})</Button>
    </div>
    {act.error && <p role="alert" className="text-xs text-destructive">{act.error.message}</p>}
    {historyOpen && <ol className="space-y-2 border-t pt-2 text-xs">{question.history.map((event, index) => <li key={`${event.at}:${index}`}>
      <p>{event.type === "notify" ? t($ => $.responsibility.source_notification) : event.type} · {event.at} · {event.actor && getActorName(event.actor.type, event.actor.id)} · {event.route_revision}</p>
      {event.handler && <p>{t($ => $.responsibility.handler)} · {getActorName(event.handler.type, event.handler.id)} · {event.handler.id}</p>}
      {event.reason && <Markdown mode="minimal">{event.reason}</Markdown>}
      {event.answer != null && typeof event.answer === "object" && "body_md" in event.answer && typeof event.answer.body_md === "string" && <Markdown mode="minimal">{event.answer.body_md}</Markdown>}
      {event.overturn && <Markdown mode="minimal">{event.overturn}</Markdown>}
      {event.source_message_id && <AppLink href={questionLocation(paths.inboxItem, question.id, event.source_message_id)}>{t($ => $.responsibility.source)} · {event.source_message_id}</AppLink>}
    </li>)}</ol>}
  </article>;
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
