"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { useT } from "../i18n";
import { UnifiedQuestionCard } from "./question-card";

export function linkedQuestionId(id: string, metadata: Record<string, unknown> | undefined): string | null {
  if (typeof metadata?.root_question_id === "string") return metadata.root_question_id;
  return metadata?.question || metadata?.human_request || metadata?.decision_record ? id : null;
}

export function LinkedQuestion({ id, getActorName }: { id: string; getActorName?: (type: string, id: string) => string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const query = useQuery({ queryKey: ["question", wsId, id], queryFn: () => api.getQuestion(id) });
  if (query.isError) return <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>{t($ => $.responsibility.load_failed)}</Button>;
  return query.data ? <UnifiedQuestionCard question={query.data} getActorName={getActorName} /> : null;
}
