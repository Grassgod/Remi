"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, MessageCircleQuestion } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  humanRequestsOptions,
  useRespondHumanRequest,
  type HumanRequestQuestion,
  type TaskHumanRequest,
} from "@multiremi/core/chat/human-requests";
import { useT } from "../../i18n";

/**
 * Interactive cards for pending human requests (tool-permission prompts and
 * AskUserQuestion forms) of the session's in-flight task. The agent is parked
 * on the ACP promise until one of these is answered — resolved requests stay
 * in the transcript as static rows, so the dock only renders `pending` ones.
 */
export function HumanRequestDock({ taskId }: { taskId: string | null }) {
  const { data } = useQuery({
    ...humanRequestsOptions(taskId ?? ""),
    enabled: Boolean(taskId),
  });
  const pending = (data ?? []).filter((request) => request.status === "pending");
  if (!taskId || pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-muted/30 px-3 py-2">
      {pending.map((request) => (
        <HumanRequestCard key={request.id} taskId={taskId} request={request} />
      ))}
    </div>
  );
}

function HumanRequestCard({ taskId, request }: { taskId: string; request: TaskHumanRequest }) {
  return request.kind === "permission" ? (
    <PermissionCard taskId={taskId} request={request} />
  ) : (
    <QuestionCard taskId={taskId} request={request} />
  );
}

function PermissionCard({ taskId, request }: { taskId: string; request: TaskHumanRequest }) {
  const { t } = useT("chat");
  const respond = useRespondHumanRequest();
  const options = request.payload.options ?? [];
  const title = request.payload.tool_call?.title;
  return (
    <div className="rounded-md border border-amber-500/40 bg-background p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
        <span>{t(($) => $.human_requests.permission_title)}</span>
      </div>
      {title && <div className="mt-1 break-words text-xs text-muted-foreground">{title}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={option.kind.startsWith("allow") ? "default" : "outline"}
            disabled={respond.isPending}
            onClick={() =>
              respond.mutate({ taskId, requestId: request.id, response: { option_id: option.optionId } })
            }
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({ taskId, request }: { taskId: string; request: TaskHumanRequest }) {
  const { t } = useT("chat");
  const respond = useRespondHumanRequest();
  const questions = request.payload.questions ?? [];
  // Answers keyed by question text — the worker folds them back into the
  // elicitation content via answersToElicitationContent.
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const setAnswer = (question: string, value: string) =>
    setAnswers((old) => ({ ...old, [question]: value }));

  const toggleOption = (question: HumanRequestQuestion["question"], label: string) => {
    if (!question.multiSelect) {
      setAnswer(question.question, label);
      return;
    }
    const chosen = new Set(
      (answers[question.question] ?? "").split(", ").filter(Boolean),
    );
    if (chosen.has(label)) chosen.delete(label);
    else chosen.add(label);
    setAnswer(question.question, [...chosen].join(", "));
  };

  const answered = questions.every(({ question }) => (answers[question.question] ?? "").trim().length > 0);

  return (
    <div className="rounded-md border border-blue-500/40 bg-background p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <MessageCircleQuestion className="h-3.5 w-3.5 text-blue-500" />
        <span>{t(($) => $.human_requests.question_title)}</span>
      </div>
      {request.payload.message && (
        <div className="mt-1 break-words text-xs text-muted-foreground">{request.payload.message}</div>
      )}
      <div className="mt-2 flex flex-col gap-2.5">
        {questions.map(({ fieldKey, question }) => (
          <div key={fieldKey} className="flex flex-col gap-1">
            <div className="text-xs font-medium">{question.header ?? question.question}</div>
            {question.header && question.header !== question.question && (
              <div className="text-xs text-muted-foreground">{question.question}</div>
            )}
            {question.options.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const selected = question.multiSelect
                    ? (answers[question.question] ?? "").split(", ").includes(option.label)
                    : answers[question.question] === option.label;
                  return (
                    <Button
                      key={option.label}
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      title={option.description}
                      className={cn(!selected && "text-muted-foreground")}
                      onClick={() => toggleOption(question, option.label)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <Input
                value={answers[question.question] ?? ""}
                placeholder={t(($) => $.human_requests.answer_placeholder)}
                onChange={(event) => setAnswer(question.question, event.target.value)}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          disabled={!answered || respond.isPending}
          onClick={() => respond.mutate({ taskId, requestId: request.id, response: { answers } })}
        >
          {t(($) => $.human_requests.submit)}
        </Button>
      </div>
    </div>
  );
}
