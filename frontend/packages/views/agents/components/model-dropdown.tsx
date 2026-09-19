"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Cpu, Loader2, Plus, Check } from "lucide-react";
import { isFallbackModelUnavailable, isModelCatalogRestricted, isModelExecutionUnknown, isModelUnavailable, useExecutionTargetModels } from "@multiremi/core/runtimes";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@multiremi/ui/components/ui/popover";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { useT } from "../../i18n";

// Model routing uses the workspace pool; explicit targets scope the catalog.
export function ModelDropdown({
  wsId,
  runtimeId,
  executionGroupId,
  agentId,
  provider,
  value,
  onChange,
  fallback = false,
  excludedModel,
}: {
  wsId: string;
  runtimeId?: string | null;
  executionGroupId?: string | null;
  agentId?: string;
  provider: string;
  value: string;
  onChange: (value: string) => void;
  fallback?: boolean;
  excludedModel?: string;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { models, modelCatalogStatus, isLoading, isError } = useExecutionTargetModels(wsId, provider, runtimeId, executionGroupId, agentId);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        m.label.toLowerCase().includes(needle),
    );
  }, [models, search]);

  const trimmedSearch = search.trim();
  const exactMatch = models.some(
    (m) => m.id === trimmedSearch || m.label === trimmedSearch,
  );
  const authoritative = isModelCatalogRestricted(provider, models, modelCatalogStatus);
  const unknown = !!value && isModelExecutionUnknown(provider, value, models, modelCatalogStatus);
  const isUnavailable = (id: string) => fallback
    ? isFallbackModelUnavailable(provider, id, models, modelCatalogStatus)
    : isModelUnavailable(provider, id, models, modelCatalogStatus);
  const unavailable = isUnavailable(value);
  const canCreate = !isLoading && !authoritative && trimmedSearch.length > 0 && !exactMatch && trimmedSearch !== excludedModel && !isUnavailable(trimmedSearch);

  const select = (id: string) => {
    if (id && (id === excludedModel || isUnavailable(id))) return;
    onChange(id);
    setOpen(false);
    setSearch("");
  };

  const triggerLabel = value || (fallback ? t(($) => $.fallback.unconfigured) : t(($) => $.model_dropdown.default_provider));

  return (
    <div className="flex flex-col min-w-0">
      <div className="flex h-6 items-center justify-between">
        <Label className="text-xs text-muted-foreground">{fallback ? t(($) => $.fallback.model_label) : t(($) => $.model_dropdown.label)}</Label>
        {isError && (
          <span className="text-xs text-muted-foreground">{t(($) => $.model_dropdown.discovery_failed)}</span>
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={fallback ? t(($) => $.fallback.model_label) : undefined}
          // Model routing has no Runtime or group binding; the fleet
          // catalog still answers for the provider, so only a missing
          // provider disables the dropdown.
          disabled={!provider}
          className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 mt-1.5 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{triggerLabel}</span>
            </div>
            {value && (
              <div className="truncate text-xs text-muted-foreground">
                {provider}
              </div>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--anchor-width)] p-0 overflow-hidden"
        >
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              placeholder={t(($) => $.pickers.model_search_placeholder)}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {isLoading && (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t(($) => $.pickers.model_discovering)}
              </div>
            )}

            {!isLoading &&
              filtered.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  disabled={m.id === excludedModel || isUnavailable(m.id)}
                  title={m.id === excludedModel ? t(($) => $.fallback.same_as_primary) : undefined}
                  onClick={() => select(m.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    m.id === value ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{m.label}</div>
                    {m.label !== m.id && (
                      <div className="truncate text-xs text-muted-foreground">
                        {m.id}
                      </div>
                    )}
                    {m.id === excludedModel ? (
                      <div className="text-xs text-muted-foreground">{t(($) => $.fallback.same_as_primary)}</div>
                    ) : isUnavailable(m.id) && (
                      <div className="text-xs text-muted-foreground">
                        {isModelExecutionUnknown(provider, m.id, models, modelCatalogStatus)
                          ? t(($) => $.pickers.model_execution_unknown) : t(($) => $.pickers.model_unavailable)}
                      </div>
                    )}
                  </div>
                  {m.id === value && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              ))}

            {!isLoading && filtered.length === 0 && !canCreate && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t(($) => $.pickers.model_empty_with_dot)}
              </div>
            )}

            {canCreate && (
              <button
                type="button"
                onClick={() => select(trimmedSearch)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-primary transition-colors hover:bg-accent/50"
              >
                <Plus className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {t(($) => $.pickers.model_custom_use, { value: trimmedSearch })}
                </span>
              </button>
            )}

            {value && (
              <button
                type="button"
                onClick={() => select("")}
                className="mt-1 flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50"
              >
                {fallback ? t(($) => $.fallback.clear) : t(($) => $.model_dropdown.clear_full)}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {(unavailable || unknown) && <span className="mt-1 text-xs text-destructive" role="status">
        {unknown ? t(($) => $.pickers.model_execution_unknown) : t(($) => $.pickers.model_unavailable)}
      </span>}
    </div>
  );
}
