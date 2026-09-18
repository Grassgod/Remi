"use client";

import { useId } from "react";
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
}: {
  value: string;
  levels: RuntimeModelThinkingLevel[];
  onChange: (next: string) => Promise<void> | void;
  thinking?: RuntimeModelThinking;
  isLoading?: boolean;
  isError?: boolean;
  modelUnavailable?: boolean;
  modelExecutionUnknown?: boolean;
}) {
  const { t } = useT("agents");
  const labelId = useId();

  return (
    <div>
      <Label id={labelId} className="text-xs text-muted-foreground">
        {t(($) => $.inspector.prop_thinking)}
      </Label>
      <div
        role="group"
        aria-labelledby={labelId}
        className="mt-1 flex min-h-9 flex-wrap items-center gap-1"
      >
        {(levels.length > 0 || value) && <ThinkingPicker value={value} levels={levels} canEdit={!modelUnavailable && !modelExecutionUnknown} onChange={onChange} />}
        {(thinking || levels.length === 0) && <ThinkingStatus modelUnavailable={modelUnavailable} modelExecutionUnknown={modelExecutionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />}
      </div>
    </div>
  );
}
