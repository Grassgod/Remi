"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useExecutionTargetModels } from "@multiremi/core/runtimes";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  PickerItem,
  PropertyPicker,
} from "../../../issues/components/pickers";
import { CHIP_CLASS } from "./chip";
import { useT } from "../../../i18n";

// The catalog is scoped to the selected machine and Runtime type.
export function ModelPicker({
  wsId,
  runtimeId,
  executionGroupId,
  agentId,
  provider,
  value,
  canEdit = true,
  onChange,
}: {
  wsId: string;
  runtimeId?: string | null;
  executionGroupId?: string | null;
  agentId?: string;
  provider: string;
  value: string;
  /** When false, render a static read-only display and skip the popover. */
  canEdit?: boolean;
  onChange: (next: string) => Promise<void> | void;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { models, isLoading } = useExecutionTargetModels(wsId, provider, runtimeId, executionGroupId, agentId);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(s) || m.label.toLowerCase().includes(s),
    );
  }, [models, search]);

  const trimmedSearch = search.trim();
  const exactMatch = models.some(
    (m) => m.id === trimmedSearch || m.label === trimmedSearch,
  );
  const canCreate = trimmedSearch.length > 0 && !exactMatch;

  const triggerLabel = value || t(($) => $.pickers.model_default);
  const triggerTitle = t(($) => $.pickers.model_tooltip, { value: triggerLabel });

  const select = async (id: string) => {
    setOpen(false);
    setSearch("");
    if (id !== value) await onChange(id);
  };

  // Automatic scheduling binds neither a Runtime nor a group, yet the fleet
  // catalog still answers for the selected provider — only a missing provider
  // means there is no execution target to pick a model for.
  if (!canEdit || !provider) {
    return (
      <span
        className="min-w-0 truncate px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
        title={triggerTitle}
      >
        {triggerLabel}
      </span>
    );
  }

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-auto min-w-[16rem] max-w-md"
      align="start"
      tooltip={triggerTitle}
      triggerRender={
        <button
          type="button"
          className={CHIP_CLASS}
          aria-label={triggerTitle}
        />
      }
      trigger={
        <span className="min-w-0 truncate font-mono text-[11px]">
          {triggerLabel}
        </span>
      }
      header={
        <div className="p-1.5">
          <Input
            autoFocus
            placeholder={t(($) => $.pickers.model_search_placeholder)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
      }
    >
      {isLoading && (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t(($) => $.pickers.model_discovering)}
        </div>
      )}

      {!isLoading &&
        filtered.map((m) => (
          <PickerItem
            key={m.id}
            selected={m.id === value}
            onClick={() => void select(m.id)}
            // Tooltip carries the canonical model id even when the chip
            // shows the friendlier label, so users can always see what
            // string actually ships to the agent.
            tooltip={m.label !== m.id ? `${m.label} · ${m.id}` : m.id}
          >
            {/* PickerItem wraps children in a flex `<span>`. Putting a
                `<div>` inside that <span> is block-in-inline (invalid
                HTML5) and triggers the browser-default centering quirk
                that pushes descendants off-axis (model IDs floated to the
                center instead of left-aligning under their labels). Use
                `<span block text-left>` to keep layout deterministic —
                matches the fix already applied in thinking-picker.tsx. */}
            <span className="block min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-medium">{m.label}</span>
              {m.label !== m.id && (
                <span className="mt-0.5 block truncate font-mono text-[10px] leading-snug text-muted-foreground">
                  {m.id}
                </span>
              )}
            </span>
          </PickerItem>
        ))}

      {!isLoading && filtered.length === 0 && !canCreate && (
        <p className="px-3 py-3 text-center text-xs text-muted-foreground">
          {t(($) => $.pickers.model_empty)}
        </p>
      )}

      {canCreate && (
        <PickerItem
          selected={false}
          onClick={() => void select(trimmedSearch)}
          tooltip={t(($) => $.pickers.model_custom_tooltip, { value: trimmedSearch })}
        >
          <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate text-primary">
            {t(($) => $.pickers.model_custom_use, { value: trimmedSearch })}
          </span>
        </PickerItem>
      )}

      {value && (
        <button
          type="button"
          onClick={() => void select("")}
          className="mt-1 flex w-full items-center border-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50"
          title={t(($) => $.pickers.model_clear_title)}
        >
          {t(($) => $.pickers.model_clear)}
        </button>
      )}
    </PropertyPicker>
  );
}
