"use client";

import { AlertCircle, Puzzle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { AgentRuntime } from "@multiremi/core/types";
import { runtimePluginStatesOptions } from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { PluginReadinessList } from "../../plugins/components/plugin-readiness-list";
import { useT } from "../../i18n";

export function RuntimePluginsTab({
  runtime,
  canManage,
}: {
  runtime: AgentRuntime;
  canManage: boolean;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const statesQuery = useQuery(runtimePluginStatesOptions(wsId, runtime.id));
  const rows = statesQuery.data ?? [];

  if (statesQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3 p-4 sm:p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{t(($) => $.runtime.title)}</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {rows.length}
        </span>
      </div>

      {statesQuery.error ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {t(($) => $.runtime.load_error)}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-14 text-center">
          <Puzzle className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">
            {t(($) => $.runtime.empty_title)}
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            {t(($) => $.runtime.empty_description)}
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((state) => (
            <li
              key={
                state.id ||
                `${state.pluginId}-${state.pluginVersionId}-${state.desiredReason}`
              }
              className="space-y-3 p-4"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {state.plugin.name}
                </span>
                <Badge variant="outline" className="capitalize">
                  {t(($) => $.provider[state.plugin.provider])}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {t(($) => $.runtime.version, {
                    version: state.version.version,
                  })}
                </span>
                {state.plugin.activeVersionId === state.pluginVersionId && (
                  <Badge variant="secondary">
                    {t(($) => $.runtime.active_badge)}
                  </Badge>
                )}
                {state.plugin.candidateVersionId === state.pluginVersionId && (
                  <Badge variant="secondary">
                    {t(($) => $.runtime.candidate_badge)}
                  </Badge>
                )}
              </div>
              <PluginReadinessList
                pluginId={state.pluginId}
                states={[state]}
                compact
                allowRetry={canManage}
                linkRuntime={false}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
