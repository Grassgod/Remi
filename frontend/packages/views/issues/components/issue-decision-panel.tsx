"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleHelp, History, LoaderCircle } from "lucide-react";
import { api } from "@multiremi/core/api";
import type {
  AnswerIssueDecisionInput,
  MultiremiIssueDecisionAnswer,
  MultiremiIssueDecisionEntry,
} from "@multiremi/core/types";
import {
  parseTaskHumanRequest,
  type TaskHumanRequest,
} from "@multiremi/core/chat/human-requests";
import { issueDecisionsOptions, issueKeys } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@multiremi/ui/components/ui/sheet";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { cn } from "@multiremi/ui/lib/utils";
import { HumanRequestCard } from "../../common/human-request-dock";
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";

interface IssueDecisionPanelProps {
  issueId: string;
  pendingCount: number;
  showOwnerOnly?: boolean;
  canAnswer: boolean;
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
          ? t(($) => $.detail.decision_banner, { count })
          : t(($) => $.detail.decision_owner_section)}
      </span>
      <ChevronRight className="size-4 shrink-0" />
    </button>
  );
}

export function IssueDecisionPanel({
  issueId,
  pendingCount,
  showOwnerOnly = false,
  canAnswer,
  getActorName,
}: IssueDecisionPanelProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const decisions = useQuery({
    ...issueDecisionsOptions(wsId, issueId),
    enabled: open,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: issueKeys.detail(wsId, issueId) }),
      queryClient.invalidateQueries({ queryKey: issueKeys.decisions(wsId, issueId) }),
    ]);
  };
  const answerDecision = useMutation({
    mutationFn: ({ decisionId, input }: { decisionId: string; input: AnswerIssueDecisionInput }) =>
      api.answerIssueDecision(issueId, decisionId, input),
    onSuccess: refresh,
  });

  const ownerEntries = decisions.data
    ? [...decisions.data.owner_and_answered.pending, ...decisions.data.owner_and_answered.answered]
    : [];

  return (
    <>
      <IssueDecisionBanner
        count={pendingCount}
        showOwnerOnly={showOwnerOnly}
        onOpen={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="inset-y-2 right-2 h-auto max-h-[calc(100vh-1rem)] w-[calc(100%-1rem)] gap-0 overflow-hidden rounded-md border sm:top-8 sm:bottom-auto sm:h-[610px] sm:w-[440px] sm:max-w-[440px]"
          data-issue-decision-overlay
        >
          <SheetHeader className="shrink-0 border-b pr-12">
            <SheetTitle>{t(($) => $.detail.decision_overlay_title)}</SheetTitle>
            <SheetDescription>
              {t(($) => $.detail.decision_overlay_count, { count: pendingCount })}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {decisions.isPending ? (
              <DecisionListSkeleton />
            ) : decisions.isError ? (
              <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-center">
                <p role="alert" className="text-sm text-destructive">
                  {t(($) => $.detail.decision_load_failed)}
                </p>
                <Button size="sm" variant="outline" onClick={() => void decisions.refetch()}>
                  {t(($) => $.detail.decision_retry)}
                </Button>
              </div>
            ) : (
              <div className="space-y-6">
                <DecisionSection title={t(($) => $.detail.decision_waiting_section)}>
                  {(decisions.data?.waiting_on_human ?? []).map((entry) => (
                    <DecisionEntryCard
                      key={entry.id}
                      entry={entry}
                      canAnswer={canAnswer}
                      answerPending={answerDecision.isPending && answerDecision.variables?.decisionId === entry.id}
                      answerError={answerDecision.isError && answerDecision.variables?.decisionId === entry.id
                        ? answerDecision.error
                        : null}
                      onAnswer={(input) => answerDecision.mutateAsync({ decisionId: entry.id, input })}
                      onHumanResponded={() => void refresh()}
                      getActorName={getActorName}
                    />
                  ))}
                </DecisionSection>

                {ownerEntries.length > 0 && (
                  <DecisionSection title={t(($) => $.detail.decision_owner_section)}>
                    {ownerEntries.map((entry) => (
                      <DecisionEntryCard
                        key={entry.id}
                        entry={entry}
                        canAnswer={canAnswer}
                        answerPending={answerDecision.isPending && answerDecision.variables?.decisionId === entry.id}
                        answerError={answerDecision.isError && answerDecision.variables?.decisionId === entry.id
                          ? answerDecision.error
                          : null}
                        onAnswer={(input) => answerDecision.mutateAsync({ decisionId: entry.id, input })}
                        onHumanResponded={() => void refresh()}
                        getActorName={getActorName}
                      />
                    ))}
                  </DecisionSection>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function DecisionSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function DecisionEntryCard({
  entry,
  canAnswer,
  answerPending,
  answerError,
  onAnswer,
  onHumanResponded,
  getActorName,
}: {
  entry: MultiremiIssueDecisionEntry;
  canAnswer: boolean;
  answerPending: boolean;
  answerError: Error | null;
  onAnswer: (input: AnswerIssueDecisionInput) => Promise<unknown>;
  onHumanResponded: () => void;
  getActorName: (type: string, id: string) => string;
}) {
  if (entry.type === "human_request") {
    const request = humanRequestFromEntry(entry);
    if (!request) return null;
    return (
      <div className="space-y-1.5" data-decision-entry={entry.id}>
        <div className="truncate text-xs font-medium" title={entry.title}>{entry.title}</div>
        <HumanRequestCard
          taskId={request.taskId}
          request={request}
          onResponded={onHumanResponded}
          readOnly={!canAnswer}
        />
      </div>
    );
  }
  return (
    <DecisionCard
      entry={entry}
      canAnswer={canAnswer}
      pending={answerPending}
      error={answerError}
      onAnswer={onAnswer}
      getActorName={getActorName}
    />
  );
}

function humanRequestFromEntry(entry: MultiremiIssueDecisionEntry): TaskHumanRequest | null {
  if (!entry.sourceTaskId || (entry.kind !== "permission" && entry.kind !== "question")) return null;
  return parseTaskHumanRequest({
    id: entry.id,
    taskId: entry.sourceTaskId,
    kind: entry.kind,
    payload: entry.payload ?? {},
    status: "pending",
    response: null,
    respondedBy: null,
    createdAt: entry.createdAt,
    respondedAt: null,
  });
}

function DecisionCard({
  entry,
  canAnswer,
  pending,
  error,
  onAnswer,
  getActorName,
}: {
  entry: MultiremiIssueDecisionEntry;
  canAnswer: boolean;
  pending: boolean;
  error: Error | null;
  onAnswer: (input: AnswerIssueDecisionInput) => Promise<unknown>;
  getActorName: (type: string, id: string) => string;
}) {
  const { t } = useT("issues");
  const history = entry.history ?? [];
  return (
    <article className="rounded-md border bg-background p-3" data-decision-entry={entry.id}>
      <div className="min-w-0">
        <h4 className="break-words text-sm font-medium">{entry.title}</h4>
        {entry.body && (
          <Markdown
            mode="minimal"
            className="mt-1 text-xs text-muted-foreground [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
          >
            {entry.body}
          </Markdown>
        )}
      </div>

      {history.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-2.5">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <History className="size-3.5" />
            {t(($) => $.detail.decision_history)}
          </div>
          {history.map((answer, index) => (
            <DecisionHistory
              key={`${answer.answeredAt}:${index}`}
              answer={answer}
              getActorName={getActorName}
            />
          ))}
        </div>
      )}

      {canAnswer && (
        <DecisionAnswerForm
          entry={entry}
          pending={pending}
          error={error}
          onAnswer={onAnswer}
        />
      )}
    </article>
  );
}

function DecisionHistory({
  answer,
  getActorName,
}: {
  answer: MultiremiIssueDecisionAnswer;
  getActorName: (type: string, id: string) => string;
}) {
  const { t } = useT("issues");
  const actor = getActorName(answer.answererType, answer.answererId) || answer.answererId;
  return (
    <div className="rounded bg-muted/50 p-2 text-xs">
      <div className="truncate font-medium" title={actor}>{actor}</div>
      <div className="mt-1 whitespace-pre-wrap break-words">{answer.answer}</div>
      {answer.reason && (
        <div className="mt-1 text-muted-foreground">
          <span className="font-medium">{t(($) => $.detail.decision_reason)}: </span>
          {answer.reason}
        </div>
      )}
      {answer.overturn && (
        <div className="mt-1 text-muted-foreground">
          <span className="font-medium">{t(($) => $.detail.decision_overturn)}: </span>
          {answer.overturn}
        </div>
      )}
    </div>
  );
}

function DecisionAnswerForm({
  entry,
  pending,
  error,
  onAnswer,
}: {
  entry: MultiremiIssueDecisionEntry;
  pending: boolean;
  error: Error | null;
  onAnswer: (input: AnswerIssueDecisionInput) => Promise<unknown>;
}) {
  const { t } = useT("issues");
  const [answer, setAnswer] = useState("");
  const [reason, setReason] = useState("");
  const submit = async () => {
    try {
      await onAnswer({ answer: answer.trim(), reason: reason.trim(), overturn: "" });
      setAnswer("");
      setReason("");
    } catch {
      // The mutation error is rendered in the reserved message row below.
    }
  };
  const actionLabel = entry.status === "answered"
    ? t(($) => $.detail.decision_reanswer)
    : t(($) => $.detail.decision_answer);
  return (
    <div className="mt-3 space-y-2 border-t pt-2.5">
      {entry.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {entry.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={answer === option ? "default" : "outline"}
              aria-pressed={answer === option}
              className="h-auto max-w-full whitespace-normal break-words text-left"
              disabled={pending}
              onClick={() => setAnswer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <Textarea
          className="min-h-16 resize-none text-sm"
          value={answer}
          disabled={pending}
          placeholder={t(($) => $.detail.decision_answer_placeholder)}
          onChange={(event) => setAnswer(event.target.value)}
        />
      )}
      <Input
        value={reason}
        disabled={pending}
        placeholder={t(($) => $.detail.decision_reason_placeholder)}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span role={error ? "alert" : undefined} className={cn("min-w-0 truncate text-xs text-destructive", !error && "invisible")}>
          {error?.message ?? t(($) => $.detail.decision_answer_failed)}
        </span>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={!answer.trim() || pending}
          onClick={() => void submit()}
        >
          {pending && <LoaderCircle className="size-3.5 animate-spin" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function DecisionListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-md border p-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-4/5" />
          <Skeleton className="mt-3 h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
