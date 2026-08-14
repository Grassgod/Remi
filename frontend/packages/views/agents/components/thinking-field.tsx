"use client";

import { useId } from "react";
import type { RuntimeModelThinkingLevel } from "@multiremi/core/types";
import { Label } from "@multiremi/ui/components/ui/label";
import { useT } from "../../i18n";
import { ThinkingPicker } from "./inspector/thinking-picker";

export function ThinkingField({
  value,
  levels,
  onChange,
}: {
  value: string;
  levels: RuntimeModelThinkingLevel[];
  onChange: (next: string) => Promise<void> | void;
}) {
  const { t } = useT("agents");
  const labelId = useId();

  if (levels.length === 0 && !value) return null;

  return (
    <div>
      <Label id={labelId} className="text-xs text-muted-foreground">
        {t(($) => $.inspector.prop_thinking)}
      </Label>
      <div
        role="group"
        aria-labelledby={labelId}
        className="mt-1 flex h-9 items-center"
      >
        <ThinkingPicker value={value} levels={levels} onChange={onChange} />
      </div>
    </div>
  );
}
