"use client";

import { GitBranch } from "lucide-react";
import type { WorkspaceRepository } from "@multiremi/core/types";
import { cn } from "@multiremi/ui/lib/utils";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";

export type RepositoryOption = Pick<
  WorkspaceRepository,
  "id" | "name" | "url" | "description" | "default_branch"
>;

export function RepositoryOptionRow({
  repository,
  checked,
  disabled = false,
  statusLabel,
  onToggle,
}: {
  repository: RepositoryOption;
  checked: boolean;
  disabled?: boolean;
  statusLabel?: string;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-start gap-3 border-b px-3 py-2.5 last:border-b-0 transition-colors",
        disabled ? "bg-muted/25" : "cursor-pointer hover:bg-accent/40",
        checked && !disabled && "bg-accent/55",
      )}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const checkboxEvent =
          target.closest('[data-slot="checkbox"]') ||
          (target instanceof HTMLInputElement && target.type === "checkbox");
        if (!disabled && !checkboxEvent) {
          onToggle();
        }
      }}
    >
      <Checkbox
        aria-label={repository.name}
        checked={checked}
        disabled={disabled}
        onCheckedChange={() => {
          if (!disabled) onToggle();
        }}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-sm font-medium"
            title={repository.name}
          >
            {repository.name}
          </span>
          {repository.default_branch && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate" title={repository.default_branch}>
                {repository.default_branch}
              </span>
            </span>
          )}
          {statusLabel && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          )}
        </span>
        <span
          title={repository.url}
          className="mt-0.5 block truncate text-xs text-muted-foreground"
        >
          {repository.url}
        </span>
      </span>
    </div>
  );
}
