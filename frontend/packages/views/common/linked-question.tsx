"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { AppLink } from "../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useT } from "../i18n";
import { UnifiedQuestionCard } from "./question-card";

export function linkedQuestionId(id: string, metadata: Record<string, unknown> | undefined): string | null {
  if (typeof metadata?.root_question_id === "string" && (metadata.question_notification === true || metadata.question_present_request === true)) return metadata.root_question_id;
  return metadata?.question || metadata?.human_request || metadata?.decision_record ? id : null;
}

/** Replies keep their own body; their reference is a link, rather than another full Q. */
export function QuestionReplyReference({ metadata }: { metadata: Record<string, unknown> | undefined }) {
  const paths = useWorkspacePaths();
  const { t } = useT("issues");
  const id = typeof metadata?.root_question_id === "string" ? metadata.root_question_id : null;
  return id ? <AppLink href={paths.inboxItem(id)} className="text-xs text-muted-foreground">{t($ => $.responsibility.source)}</AppLink> : null;
}

export function LinkedQuestion({ id, getActorName }: { id: string; getActorName?: (type: string, id: string) => string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const query = useQuery({ queryKey: ["question", wsId, id], queryFn: () => api.getQuestion(id) });
  if (query.isError) return <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>{t($ => $.responsibility.load_failed)}</Button>;
  return query.data ? <UnifiedQuestionCard question={query.data} getActorName={getActorName} /> : null;
}
