"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { api } from "@multiremi/core/api";
import { ApiError } from "@multiremi/core/api/client";
import type { QuestionView } from "@multiremi/core/api/schemas";
import { parseTaskHumanRequest } from "@multiremi/core/chat/human-requests";
import { issueDetailOptions, issueKeys } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@multiremi/ui/components/ui/dropdown-menu";
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../navigation";
import { useT } from "../i18n";
import { Markdown } from "./markdown";
import { QuestionForm, QuestionContext } from "./human-request-dock";
import { DecisionCardFrame, DecisionAnswerArea, DecisionOptions, DecisionHeading, DecisionSubmit, DecisionHistory, DecisionHistoryEntry } from "./decision-panel";
import { questionAnswerHistory, questionAnswerText } from "./question-answer";
import { TaskTraceDialog } from "./task-transcript/task-trace-dialog";
import { questionLocation } from "./question-location";

type ActorName = (type: string, id: string) => string;
const AGENT_STAGES = new Set(["issue_owner", "parent_owner"]);
const TAG_TONES = {
  human: "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-400/40 dark:bg-orange-400/10 dark:text-orange-300",
  agent: "border-info/30 bg-info/10 text-info",
  answered: "border-success/30 bg-success/10 text-success",
  muted: "border-border bg-muted text-muted-foreground",
} as const;
/** `route_reason` failures that explain why an Issue Q reached members before the root. */
const ROUTE_FAILURES = {
  leader_missing: "leader_missing", execution_owner_missing: "execution_owner_missing", agent_unavailable: "agent_unavailable",
  team_unavailable: "team_unavailable", parent_missing: "parent_chain", parent_cycle: "parent_chain",
  workspace_mismatch: "parent_chain", issue_missing: "parent_chain",
} as const;
type RouteFailure = (typeof ROUTE_FAILURES)[keyof typeof ROUTE_FAILURES];
/** What a member meets when someone or something changed the Q first; other errors keep the server's text. */
const CONFLICTS = {
  question_route_changed: "route_changed", question_answer_revision_changed: "answer_revision_changed", question_already_settled: "already_settled",
} as const;
const errorCode = (error: unknown): string | null => error instanceof ApiError && error.body && typeof error.body === "object"
  && "code" in error.body && typeof error.body.code === "string" ? error.body.code : null;

/** Drawer sections: human-stage questions first, then what Agents still hold, then settled history. */
export function questionSection(question: QuestionView): "pending" | "agent" | "history" {
  if (question.status !== "pending") return "history";
  return AGENT_STAGES.has(question.stage) ? "agent" : "pending";
}

function questionRequest(question: QuestionView) {
  return parseTaskHumanRequest({ id: question.id, taskId: "", sessionId: question.session_id, kind: "question",
    payload: { message: question.original_message, questions: question.original_questions, context: question.original_context ?? undefined }, status: "pending", createdAt: question.history[0]?.at ?? "", respondedAt: null, respondedBy: null, response: null });
}

/** The first question the Agent asked, on one line; a permission request keeps its tool title. */
export function questionTitle(question: QuestionView): string {
  const first = questionRequest(question)?.payload.questions?.[0]?.question;
  const text = first?.question || first?.header || question.original_message;
  return text.split("\n").map(line => line.trim()).find(Boolean) ?? "";
}

/**
 * Who the Q waits on now, or how it ended. The Issue human stage names nobody;
 * a Chat Q names its member, which reads as waiting on them for anyone else.
 */
export function QuestionStatusTag({ question, getActorName }: { question: QuestionView; getActorName: ActorName }) {
  const { t } = useT("issues");
  const handler = question.current_handler;
  const waitingOn = handler && (AGENT_STAGES.has(question.stage) || !question.actions.allowed.includes("answer")) ? getActorName(handler.type, handler.id) : "";
  const [tone, label]: [keyof typeof TAG_TONES, string] = question.status === "answered" ? ["answered", t($ => $.responsibility.tag_answered)]
    : question.status === "closed" ? ["muted", t($ => $.responsibility.tag_closed)]
    : question.status !== "pending" ? ["muted", question.status]
    : question.stage === "human" ? waitingOn ? ["agent", t($ => $.responsibility.tag_waiting_on, { name: waitingOn })] : ["human", t($ => $.responsibility.tag_pending)]
    : AGENT_STAGES.has(question.stage) ? ["agent", waitingOn ? t($ => $.responsibility.tag_waiting_on, { name: waitingOn }) : t($ => $.responsibility.agent_section)]
    : ["muted", t($ => $.responsibility.tag_unavailable)];
  return <span title={label} data-question-tag={tone}
    className={cn("max-w-[45%] shrink-0 truncate whitespace-nowrap rounded border px-1.5 text-[11px] font-medium leading-5", TAG_TONES[tone])}>{label}</span>;
}

/** Parses comma-joined `<issueId>:<failure>`; older free-form values explain nothing here. */
function routeFailures(question: QuestionView): Array<{ issueId: string; failure: RouteFailure }> {
  if (question.stage !== "human" || !question.route_reason || question.route_reason === "source_workspace_changed") return [];
  const seen = new Set<string>();
  return question.route_reason.split(",").flatMap(entry => {
    const index = entry.lastIndexOf(":");
    const issueId = entry.slice(0, Math.max(index, 0)).trim();
    const failure = ROUTE_FAILURES[entry.slice(index + 1).trim() as keyof typeof ROUTE_FAILURES];
    if (index <= 0 || !issueId || !failure || seen.has(`${issueId}:${failure}`)) return [];
    seen.add(`${issueId}:${failure}`);
    return [{ issueId, failure }];
  });
}

function QuestionRouteNote({ issueId, failure, sourceIssueId }: { issueId: string; failure: RouteFailure; sourceIssueId: string | null }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { data: issue } = useQuery(issueDetailOptions(wsId, issueId));
  const reason = t($ => $.responsibility.route_reasons[failure]);
  const text = issueId === sourceIssueId ? t($ => $.responsibility.route_note_self, { reason })
    : issue ? t($ => $.responsibility.route_note_upper, { key: issue.identifier, reason })
    : t($ => $.responsibility.route_note_upper_unknown, { reason });
  // A missing Leader is configured on the team, not on the Issue.
  const href = (failure === "leader_missing" || failure === "team_unavailable") && issue?.assignee_type === "squad" && issue.assignee_id
    ? paths.squadDetail(issue.assignee_id) : paths.issueDetail(issueId);
  return <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" data-question-route-note>
    {text}<AppLink href={href} className="ml-1.5 text-primary hover:underline">{t($ => $.responsibility.configure)}</AppLink>
  </p>;
}

/** All surfaces operate on the original Q, including cross-session notifications. */
export function UnifiedQuestionCard({ question, getActorName = (_type, id) => id, initiallyShowHistory = false }: { question: QuestionView; getActorName?: ActorName; initiallyShowHistory?: boolean }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [revise, setRevise] = useState(false);
  const [operation, setOperation] = useState<"escalate" | "present" | "close" | null>(null);
  const [summaryText, setSummaryText] = useState("");
  const [historyOpen, setHistoryOpen] = useState(initiallyShowHistory);
  const allowed = question.actions.allowed;
  const conflict = (error: unknown, code = errorCode(error)) => {
    const key = CONFLICTS[code as keyof typeof CONFLICTS];
    return key && error instanceof ApiError ? new ApiError(t($ => $.responsibility.conflicts[key]), error.status, error.statusText, error.body) : error;
  };
  const act = useMutation({ mutationFn: async ({ action, response }: { action: "answer" | "escalate" | "present" | "continue" | "close"; response?: Record<string, unknown> }) => {
    const send = (routeRevision: number) => api.actOnQuestion(question.id, action, {
      expected_route_revision: routeRevision, response, reason: reason.trim(), summary: action === "present" ? summaryText.trim() : undefined,
      body_md: action === "answer" ? text.trim() || (response && questionAnswerText(response, question.options)) || undefined : undefined,
      ...(action === "answer" && revise ? { revise: true, expected_answer_revision: question.answer_revision } : {}),
    });
    try { return await send(question.route_revision); } catch (error) {
      // A stale responsibility revision re-routes the Q in its own commit first (e.g. its first answer
      // after an upgrade). Submit once more only if the refreshed Q still offers this viewer the same action.
      if (errorCode(error) !== "question_route_changed") throw conflict(error);
      const fresh = await api.getQuestion(question.id).catch(() => null);
      if (fresh) qc.setQueryData(["question", wsId, question.id], fresh);
      const changed = !fresh ? undefined : fresh.status !== question.status ? "question_already_settled"
        : fresh.answer_revision !== question.answer_revision ? "question_answer_revision_changed" : undefined;
      if (!fresh || changed || !fresh.actions.allowed.includes(action === "answer" && revise ? "revise" : action)) throw conflict(error, changed);
      return send(fresh.route_revision).catch((retryError: unknown) => { throw conflict(retryError); });
    }
  }, onSuccess: (result) => {
    setRevise(false);
    setOperation(null);
    setReason("");
    qc.setQueryData(["question", wsId, question.id], result);
    void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    void qc.invalidateQueries({ queryKey: ["inbox", wsId] });
  }, onError: () => {
    // A responsibility change re-routes the Q on the server; refetch shows the new handler and revision.
    void qc.invalidateQueries({ queryKey: ["question", wsId, question.id] });
    void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  } });
  const request = questionRequest(question);
  const canAnswer = revise ? allowed.includes("revise") && Boolean(reason.trim()) : allowed.includes("answer");
  const operationLabels = { escalate: t($ => $.responsibility.escalate), present: t($ => $.responsibility.present), close: t($ => $.responsibility.close) };
  const operations = (["escalate", "present", "close"] as const).filter(action => allowed.includes(action));
  const agentStage = question.status === "pending" && AGENT_STAGES.has(question.stage);
  const routeNotes = routeFailures(question).map(({ issueId, failure }) => <QuestionRouteNote key={`${issueId}:${failure}`} issueId={issueId} failure={failure} sourceIssueId={question.source_issue_id} />);
  const waitLabels: Record<string, string> = { waiting: t($ => $.responsibility.waiting), detached: t($ => $.responsibility.detached), consumed: t($ => $.responsibility.consumed), continuation_pending: t($ => $.responsibility.continuation_pending), continuation_consumed: t($ => $.responsibility.continuation_consumed), none: t($ => $.responsibility.none) };
  const answeredStatus = question.wait_status === "consumed" || question.wait_status === "continuation_consumed"
    ? t($ => $.responsibility.execution_resumed)
    : question.wait_status === "detached" ? t($ => $.responsibility.resume_needed)
    : question.wait_status === "continuation_pending" || question.wait_status === "waiting" ? t($ => $.responsibility.awaiting_resume)
    : t($ => $.responsibility.saved);
  const actions = (operations.length > 0 || allowed.includes("revise")) && <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t($ => $.responsibility.more_actions)} disabled={act.isPending} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {allowed.includes("revise") && <DropdownMenuItem onClick={() => { setRevise(true); setOperation(null); setReason(""); }}>{t($ => $.responsibility.revise)}</DropdownMenuItem>}
          {operations.map(action => <DropdownMenuItem key={action} variant={action === "close" ? "destructive" : "default"} onClick={() => { setOperation(action); setRevise(false); setReason(""); }}>{operationLabels[action]}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>;
  const answers = questionAnswerHistory(question);
  const answerHistory = answers.length > 0 && <DecisionHistory title={t($ => $.detail.decision_history)}>
    {answers.map((answer, index) => <DecisionHistoryEntry key={`${answer.at}:${index}`}
      actor={answer.actor ? getActorName(answer.actor.type, answer.actor.id) : ""} answer={answer.body}
      reason={answer.reason} reasonLabel={t($ => $.detail.decision_reason)} overturn={answer.overturn} overturnLabel={t($ => $.detail.decision_overturn)} />)}
  </DecisionHistory>;
  const answerContext = <>
    {question.summary && <section className="rounded bg-muted/40 p-2"><h4 className="mb-1 text-xs font-medium">{t($ => $.responsibility.remi)}</h4><Markdown mode="minimal">{question.summary.body_md}</Markdown></section>}
    {answerHistory}
    {revise && <div className="space-y-2"><h4 className="text-xs font-medium">{t($ => $.responsibility.revise)}</h4>
      <Textarea aria-label={t($ => $.responsibility.revision_reason)} placeholder={t($ => $.responsibility.revision_reason)} value={reason} disabled={act.isPending} onChange={e => setReason(e.target.value)} />
      <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => { setRevise(false); setReason(""); }}>{t($ => $.responsibility.cancel_action)}</Button>
    </div>}
  </>;
  return <DecisionCardFrame id={question.id}><div data-question-id={question.id}>
    <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <QuestionStatusTag question={question} getActorName={getActorName} />
      {question.source_agent_id && <span className="min-w-0 truncate">{t($ => $.responsibility.asked_by, { name: getActorName("agent", question.source_agent_id) || question.source_agent_id })}</span>}
    </div>
    <section>
      {request && question.original_questions.length > 0 ? <QuestionForm key={`${question.id}:${revise}`} taskId="" request={request} readOnly={!canAnswer || operation !== null} disabled={act.isPending} hideOptions={question.status !== "pending" && !revise}
        actions={actions} notice={routeNotes} history={answerContext} onAnswer={response => act.mutateAsync({ action: "answer", response })} />
        : <><DecisionHeading title={question.original_message} actions={actions} />{question.original_context && <QuestionContext context={question.original_context} />}{routeNotes}{answerContext}</>}
    </section>
    {question.status === "answered" && <p className="mt-2 text-xs text-muted-foreground" role="status">{answeredStatus}</p>}
    {question.status === "closed" && <p className="mt-2 text-xs text-muted-foreground">{t($ => $.responsibility.closed)}</p>}
    {agentStage && !allowed.includes("answer") && <p className="mt-2 text-xs text-muted-foreground">{t($ => $.responsibility.agent_readonly)}</p>}
    {!canAnswer && question.status === "pending" && question.original_questions.length === 0 && question.options?.map(option => <span key={option.value} className="mr-1.5 mt-2 inline-block rounded border px-2 py-1 text-xs">{option.label}</span>)}
    {canAnswer && !operation && question.original_questions.length === 0 && <DecisionAnswerArea>
      <DecisionOptions options={question.options ?? []} selected={selected} disabled={act.isPending} onSelect={value => { setSelected([value]); setText(""); }} />
      {question.kind !== "permission" && <Textarea className="min-h-16 resize-none text-sm" aria-label={t($ => $.responsibility.answer)} value={text} onChange={e => { setText(e.target.value); setSelected([]); }} disabled={act.isPending} />}
      <DecisionSubmit label={t($ => $.responsibility.answer)} pending={act.isPending} disabled={!text.trim() && selected.length === 0} error={act.error?.message}
        onSubmit={() => act.mutate({ action: "answer", response: question.kind === "permission" ? { option_id: selected[0] } : selected.length ? { selected_options: selected } : { answer: text.trim() } })} />
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
    {act.error && (operation || !canAnswer) && <p role="alert" className="text-xs text-destructive">{act.error.message}</p>}
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
      {!(event.answer && typeof event.answer === "object" && "body_md" in event.answer && typeof event.answer.body_md === "string") && event.reason && <Markdown mode="minimal">{event.reason}</Markdown>}
      {!(event.answer && typeof event.answer === "object" && "body_md" in event.answer && typeof event.answer.body_md === "string") && event.overturn && <Markdown mode="minimal">{event.overturn}</Markdown>}
      {event.source_message_id && <AppLink href={questionLocation(paths.inboxItem, question.id, event.source_message_id)}>{t($ => $.responsibility.source)} · {event.source_message_id}</AppLink>}
    </li>)}</ol></div>}
  </div></DecisionCardFrame>;
}

function QuestionConsumptionAttempt({ attemptId, turnId, getActorName }: { attemptId: string; turnId: string; getActorName: ActorName }) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const task = useQuery({ queryKey: ["task-detail", attemptId, turnId], enabled: open, queryFn: () => api.getTask(attemptId, turnId) });
  return <>
    <Button variant="ghost" size="sm" disabled={task.isFetching} onClick={() => { setOpen(true); if (task.isError) void task.refetch(); }}>{t($ => $.responsibility.consumer_attempt)} · {attemptId}</Button>
    {task.isError && <p role="alert">{t($ => $.responsibility.load_failed)}</p>}
    {open && task.data && <TaskTraceDialog task={task.data} agentName={getActorName("agent", task.data.agent_id)} onOpenChange={setOpen} />}
  </>;
}
