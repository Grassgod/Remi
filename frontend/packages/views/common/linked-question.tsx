"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleHelp, LoaderCircle } from "lucide-react";
import { isHistoricalIssueQuestionRecord } from "@multiremi/contracts/question";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { AppLink } from "../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useT } from "../i18n";
import { UnifiedQuestionCard } from "./question-card";
import { questionLocation } from "./question-location";
import { DecisionPanel } from "./decision-panel";

export function linkedQuestionId(id: string, metadata: Record<string, unknown> | undefined): string | null {
  if (typeof metadata?.root_question_id === "string" && (metadata.question_notification === true || metadata.question_present_request === true)) return metadata.root_question_id;
  return metadata?.question || metadata?.human_request || isHistoricalIssueQuestionRecord(metadata?.decision_record) ? id : null;
}

/** Replies keep their own body; their reference is a link, rather than another full Q. */
export function QuestionReplyReference({ metadata }: { metadata: Record<string, unknown> | undefined }) {
  const paths = useWorkspacePaths();
  const { t } = useT("issues");
  const id = typeof metadata?.root_question_id === "string" ? metadata.root_question_id : null;
  return id ? <AppLink href={questionLocation(paths.inboxItem, id)} className="text-xs text-muted-foreground">{t($ => $.responsibility.source)}</AppLink> : null;
}

export function LinkedQuestion({ id, getActorName }: { id: string; getActorName?: (type: string, id: string) => string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["question", wsId, id], queryFn: () => api.getQuestion(id), enabled: open });
  return <>
    <Button variant="ghost" size="sm" className="max-w-full text-blue-700 dark:text-blue-300" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <CircleHelp className="size-4 shrink-0" />{t($ => $.responsibility.open_question)}<ChevronRight className="size-4 shrink-0" />
    </Button>
    <DecisionPanel open={open} onOpenChange={setOpen} title={t($ => $.responsibility.history)} description={t($ => $.responsibility.original)}>
      {query.data ? <UnifiedQuestionCard question={query.data} getActorName={getActorName} />
        : query.isError ? <div><p role="alert">{t($ => $.responsibility.load_failed)}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t($ => $.responsibility.retry)}</Button></div>
        : <LoaderCircle className="size-5 animate-spin" />}
    </DecisionPanel>
  </>;
}
