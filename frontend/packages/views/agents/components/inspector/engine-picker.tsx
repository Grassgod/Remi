"use client";

import { useState } from "react";
import {
  PickerItem,
  PropertyPicker,
} from "../../../issues/components/pickers";
import { ProviderLogo } from "../../../runtimes/components/provider-logo";
import { CHIP_CLASS } from "./chip";
import { useT } from "../../../i18n";

// The engines a pool agent can run on. Mirrors the create dialog's toggle.
const ENGINES = ["claude", "codex"] as const;

/**
 * Inline engine (provider) picker for the agent inspector. Replaces the old
 * runtime picker: agents are pool workers now — they carry an engine, and
 * the scheduler places their tasks on any online runtime of that engine.
 * Switching engines re-validates the model / thinking level server-side.
 */
export function EnginePicker({
  value,
  canEdit = true,
  onChange,
}: {
  value: string;
  /** When false, render a static read-only display and skip the popover. */
  canEdit?: boolean;
  onChange: (provider: string) => Promise<void> | void;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);

  const triggerTitle = t(($) => $.pickers.engine_tooltip, { value });

  if (!canEdit) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-xs text-muted-foreground">
        <ProviderLogo provider={value} className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono capitalize">{value}</span>
      </span>
    );
  }

  const select = async (engine: string) => {
    setOpen(false);
    if (engine !== value) await onChange(engine);
  };

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-auto min-w-[12rem] max-w-md"
      align="start"
      tooltip={triggerTitle}
      triggerRender={
        <button type="button" className={CHIP_CLASS} aria-label={triggerTitle} />
      }
      trigger={
        <>
          <ProviderLogo provider={value} className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate font-mono capitalize">{value}</span>
        </>
      }
    >
      {ENGINES.map((engine) => (
        <PickerItem
          key={engine}
          selected={engine === value}
          onClick={() => void select(engine)}
        >
          <ProviderLogo provider={engine} className="h-4 w-4 shrink-0" />
          <span className="truncate text-sm font-medium capitalize">{engine}</span>
        </PickerItem>
      ))}
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        {t(($) => $.pickers.engine_hint)}
      </p>
    </PropertyPicker>
  );
}
