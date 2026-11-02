"use client";

import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { fleetModelsOptions } from "@multiremi/core/runtimes";
import type { RuntimeModel } from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { useT } from "../../i18n";

/** Cursor model capabilities come from its native Runtime catalog. */
export function CursorModelCapabilities({ wsId }: { wsId: string }) {
  const { t } = useT("settings");
  const { data, isPending, isError, refetch } = useQuery(fleetModelsOptions(wsId));
  const provider = data?.providers.find((entry) => entry.provider === "cursor");
  const models = provider?.models ?? [];
  const failed = isError || provider?.model_catalog_status === "error";

  return (
    <section className="space-y-3" aria-label={t(($) => $.modelGateway.cursor_models_title)}>
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.modelGateway.cursor_models_title)}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.modelGateway.cursor_models_description)}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-3">
          {isPending ? (
            <Skeleton className="h-16 w-full" aria-label={t(($) => $.modelGateway.cursor_models_loading)} />
          ) : failed ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-destructive">{t(($) => $.modelGateway.cursor_models_load_failed)}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t(($) => $.modelGateway.try_again)}
              </Button>
            </div>
          ) : (
            <>
              {provider?.online_runtime_count === 0 ? (
                <p className="text-xs text-muted-foreground">{t(($) => $.modelGateway.cursor_models_offline)}</p>
              ) : provider?.model_catalog_status === "unknown" ? (
                <p className="text-xs text-muted-foreground">{t(($) => $.modelGateway.cursor_models_pending)}</p>
              ) : null}
              {models.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t(($) => $.modelGateway.cursor_models_empty)}</p>
              ) : (
                <ul className="max-h-96 divide-y overflow-y-auto">
                  {models.map((model) => <CursorModelCapabilityRow key={model.id} model={model} />)}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function CursorModelCapabilityRow({ model }: { model: RuntimeModel }) {
  const { t } = useT("settings");
  const thinking = model.thinking;
  const levels = thinking?.supported_levels ?? [];
  const status = thinking?.status ?? (levels.length ? "supported" : "unknown");
  const statusLabel = status === "supported" ? t(($) => $.modelGateway.reasoning_status_supported)
    : status === "unsupported" ? t(($) => $.modelGateway.reasoning_status_unsupported)
      : status === "error" ? t(($) => $.modelGateway.reasoning_status_error)
        : t(($) => $.modelGateway.reasoning_status_unknown);
  const defaultLevel = thinking?.default_level;
  const defaultLabel = levels.find((level) => level.value === defaultLevel)?.label ?? defaultLevel;

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-xs font-medium">{model.label}</span>
        <code className="break-all text-[11px] text-muted-foreground">{model.id}</code>
        {model.default ? <Badge variant="secondary">{t(($) => $.modelGateway.cursor_default_model)}</Badge> : null}
        <Badge variant={status === "error" ? "destructive" : "outline"}>{statusLabel}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t(($) => $.modelGateway.reasoning_levels_label)}:</span>
        {levels.length ? levels.map((level) => (
          <Badge key={level.value} variant="secondary" title={level.description}>
            {level.label === level.value ? level.value : `${level.label} (${level.value})`}
          </Badge>
        )) : <span>{t(($) => $.modelGateway.reasoning_not_declared)}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(($) => $.modelGateway.reasoning_default_label)}: {defaultLabel
          ? defaultLabel === defaultLevel ? defaultLabel : `${defaultLabel} (${defaultLevel})`
          : t(($) => $.modelGateway.cursor_default_unreported)}
      </p>
    </li>
  );
}
