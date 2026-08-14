"use client";

import { Bot, SquarePen } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import type { CreateMode } from "@multiremi/core/issues/stores/create-mode-store";
import { useT } from "../i18n";

export function CreateIssueModeSwitch({
  mode,
  onModeChange,
}: {
  mode: CreateMode;
  onModeChange: (mode: CreateMode) => void;
}) {
  const { t } = useT("modals");

  const options: Array<{
    mode: CreateMode;
    label: string;
    ariaLabel: string;
    icon: typeof SquarePen;
  }> = [
    {
      mode: "manual",
      label: t(($) => $.create_issue.manual_breadcrumb),
      ariaLabel: t(($) => $.create_issue.switch_to_manual),
      icon: SquarePen,
    },
    {
      mode: "agent",
      label: t(($) => $.create_issue.agent_breadcrumb),
      ariaLabel: t(($) => $.create_issue.switch_to_agent),
      icon: Bot,
    },
  ];

  return (
    <div className="flex items-center rounded-md bg-muted p-0.5">
      {options.map((option) => {
        const active = option.mode === mode;
        const Icon = option.icon;
        return (
          <button
            key={option.mode}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={active}
            onClick={() => {
              if (!active) onModeChange(option.mode);
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs transition-colors cursor-pointer",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
