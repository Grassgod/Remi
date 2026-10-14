"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { isHistoricalIssueQuestionRecord } from "@multiremi/contracts/question";
import { api, ApiError } from "@multiremi/core/api";
import type { QuestionView } from "@multiremi/core/api/schemas";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useT } from "../i18n";
import { useTimeAgo } from "../i18n/use-time-ago";
import { QuestionStatusTag, UnifiedQuestionCard, questionSection, questionTitle } from "./question-card";
import { questionAnswerBody } from "./question-answer";
import { questionLocation } from "./question-location";
import { DecisionPanel, DecisionSection, DecisionListSkeleton } from "./decision-panel";

type ActorName = (type: string, id: string) => string;

export function linkedQuestionId(id: string, metadata: Record<string, unknown> | undefined): string | null {
  if (typeof metadata?.root_question_id === "string" && (metadata.question_notification === true || metadata.question_present_request === true)) return metadata.root_question_id;
  return metadata?.question || metadata?.human_request || isHistoricalIssueQuestionRecord(metadata?.decision_record) ? id : null;
}

type ReminderRow = { metadata?: Record<string, unknown>; to_type?: string | null; to_member_id?: string | null; to_ref?: string | null };

/** A question reminder or recovery notice addressed to one member. */
export function isMemberQuestionReminder(row: ReminderRow): boolean {
  return row.metadata?.question_notification === true && row.to_type === "member";
}

/**
 * Human-stage reminders go to several members, one row each in the source
 * Issue's log. A timeline renders only the reader's own reminder; the original
 * Q row already shows the same question to everyone else.
 */
export function isOthersQuestionReminder(row: ReminderRow, memberId: string | null | undefined): boolean {
  return isMemberQuestionReminder(row) && (!memberId || (row.to_member_id ?? row.to_ref) !== memberId);
}

/**
 * An Issue timeline renders a member reminder only for the member it reached,
 * and only when the original Q row lives in another session: in the same
 * session that row already shows the question. Older recovery notices lack
 * `source_question_session_id`, so a loaded original row counts as well.
 */
export function isRedundantQuestionReminder(row: ReminderRow, memberId: string | null | undefined, sessionId: string | null | undefined, rowIds: ReadonlySet<string>): boolean {
  if (!isMemberQuestionReminder(row)) return false;
  if (isOthersQuestionReminder(row, memberId)) return true;
  const original = row.metadata?.root_question_id;
  return (!!sessionId && row.metadata?.source_question_session_id === sessionId) || (typeof original === "string" && rowIds.has(original));
}

/** Replies keep their own body; their reference is a link, rather than another full Q. */
export function QuestionReplyReference({ metadata }: { metadata: Record<string, unknown> | undefined }) {
  const paths = useWorkspacePaths();
  const { t } = useT("issues");
  const id = typeof metadata?.root_question_id === "string" ? metadata.root_question_id : null;
  return id ? <AppLink href={questionLocation(paths.inboxItem, id)} className="text-xs text-muted-foreground">{t($ => $.responsibility.source)}</AppLink> : null;
}

const LINE = "flex h-10 min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 text-sm";
/** A frozen or inaccessible Q answers 403/404 for good; retrying cannot help. */
const goneQuestion = (error: unknown) => error instanceof ApiError && (error.status === 403 || error.status === 404);

/** One line per Q on run cards and timelines: its status, title, then the answer or a way into the drawer. */
export function QuestionSummaryLine({ question, getActorName, onOpen }: { question: QuestionView; getActorName: ActorName; onOpen: () => void }) {
  const { t } = useT("issues");
  const title = questionTitle(question);
  const answerable = question.actions.allowed.includes("answer");
  const body = question.status === "answered" && question.answer ? questionAnswerBody(question.answer, question.options).replace(/\s+/g, " ").trim() : "";
  const answerer = body && question.answer ? getActorName(question.answer.actor.type, question.answer.actor.id) : "";
  const answer = answerer ? t($ => $.responsibility.answered_by, { name: answerer, answer: body }) : body;
  return <div data-question-summary={question.id} className={cn(LINE, question.status === "pending" && question.stage === "human" && answerable
    && "border-orange-300 bg-orange-50/40 dark:border-orange-400/40 dark:bg-orange-400/5")}>
    <QuestionStatusTag question={question} getActorName={getActorName} />
    <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
    {answer && <span className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground" title={answer}>{answer}</span>}
    <Button size="xs" variant={answerable ? "default" : "ghost"} aria-haspopup="dialog" className={cn(!answerable && "text-primary")} onClick={onOpen}>
      {answerable ? t($ => $.responsibility.answer_action) : t($ => $.responsibility.view_action)}<ChevronRight />
    </Button>
  </div>;
}

/** A Q referenced from a run card or a timeline row: the summary line, and the drawer that answers it. */
export function LinkedQuestion({ id, getActorName = (_type, actorId) => actorId }: { id: string; getActorName?: ActorName }) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["question", wsId, id], queryFn: () => api.getQuestion(id),
    retry: (failures, error) => !goneQuestion(error) && failures < 1 });
  const question = query.data;
  const section = question ? questionSection(question) : null;
  const askedAt = question?.history.find(event => event.type === "created")?.at ?? question?.history[0]?.at;
  const asker = question?.source_agent_id ? t($ => $.responsibility.asked_by, { name: getActorName("agent", question.source_agent_id) || question.source_agent_id }) : t($ => $.responsibility.original);
  return <>
    {question ? <QuestionSummaryLine question={question} getActorName={getActorName} onOpen={() => setOpen(true)} />
      : <div className={LINE} data-question-summary={id}>{query.isError ? goneQuestion(query.error)
        ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t($ => $.responsibility.question_unavailable)}</span>
        : <><span role="alert" className="min-w-0 flex-1 truncate text-xs text-destructive">{t($ => $.responsibility.load_failed)}</span>
          <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>{t($ => $.responsibility.retry)}</Button></>
        : <><Skeleton className="h-5 w-14 shrink-0" /><Skeleton className="h-4 flex-1" /></>}</div>}
    <DecisionPanel open={open} onOpenChange={setOpen} title={t($ => $.responsibility.drawer_title)}
      description={askedAt ? `${asker} · ${timeAgo(askedAt)}` : asker}>
      {question ? <DecisionSection title={section === "pending" ? t($ => $.responsibility.pending_section) : section === "agent" ? t($ => $.responsibility.agent_section) : t($ => $.responsibility.history_section)}>
        <UnifiedQuestionCard question={question} getActorName={getActorName} />
      </DecisionSection>
        : query.isError ? <div><p role="alert">{t($ => $.responsibility.load_failed)}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t($ => $.responsibility.retry)}</Button></div>
        : <DecisionListSkeleton />}
    </DecisionPanel>
  </>;
}
