"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { useT } from "../i18n";
import { UnifiedQuestionCard } from "./question-card";

export function LinkedQuestion({ id, getActorName }: { id: string; getActorName?: (type: string, id: string) => string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const query = useQuery({ queryKey: ["question", wsId, id], queryFn: () => api.getQuestion(id) });
  if (query.isError) return <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>{t($ => $.responsibility.load_failed)}</Button>;
  return query.data ? <UnifiedQuestionCard question={query.data} getActorName={getActorName} /> : null;
}
