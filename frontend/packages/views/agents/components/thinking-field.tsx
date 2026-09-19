"use client";

import { useId } from "react";
import { X } from "lucide-react";
import type { RuntimeModelThinking, RuntimeModelThinkingLevel } from "@multiremi/core/types";
import { Label } from "@multiremi/ui/components/ui/label";
import { useT } from "../../i18n";
import { ThinkingPicker } from "./inspector/thinking-picker";
import { ThinkingStatus } from "./inspector/thinking-status";

export function ThinkingField({
  value,
  levels,
  onChange,
  thinking,
  isLoading,
  isError,
  modelUnavailable,
  modelExecutionUnknown,
  label,
}: {
  value: string;
  levels: RuntimeModelThinkingLevel[];
  onChange: (next: string) => Promise<void> | void;
  thinking?: RuntimeModelThinking;
  isLoading?: boolean;
  isError?: boolean;
  modelUnavailable?: boolean;
  modelExecutionUnknown?: boolean;
  label?: string;
}) {
  const { t } = useT("agents");
  const labelId = useId();

  // A failed capability load is not an authoritative "this model has no
  // levels" verdict, so it keeps the picker (and its clear row) reachable —
  // the same rule ThinkingPropRow applies to the inspector row.
  const loadFailed = isError || thinking?.status === "error";
  const editable = !modelUnavailable && !modelExecutionUnknown;
  // A saved effort with no selectable level is the stale-orphan state: the
  // model either declares no reasoning levels at all or the gateway never
  // reported any (Claude's /v1/models carries no effort field). Mounting an
  // editable picker there leaves an empty popover whose only row is "clear",
  // so show what is persisted instead and keep the clear affordance explicit.
  const orphanedValue = levels.length === 0 && !loadFailed && value !== "";
  const showPicker = !orphanedValue && (levels.length > 0 || value !== "");

  return (
    <div>
      <Label id={labelId} className="text-xs text-muted-foreground">
        {label ?? t(($) => $.inspector.prop_thinking)}
      </Label>
      <div
        role="group"
        aria-labelledby={labelId}
        className="mt-1 flex min-h-9 flex-wrap items-center gap-1"
      >
        {showPicker && (
          <ThinkingPicker
            value={value}
            levels={levels}
            canEdit={editable}
            onChange={onChange}
          />
        )}
        {orphanedValue && (
          <>
            <span
              className="min-w-0 truncate px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={t(($) => $.pickers.thinking_tooltip, { value })}
            >
              {value}
            </span>
            {editable && (
              <button
                type="button"
                onClick={() => void onChange("")}
                className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t(($) => $.pickers.thinking_clear_title)}
                aria-label={t(($) => $.pickers.thinking_clear_title)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </>
        )}
        {(thinking || levels.length === 0) && <ThinkingStatus modelUnavailable={modelUnavailable} modelExecutionUnknown={modelExecutionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />}
      </div>
    </div>
  );
}
