"use client";

import { useMemo, useState } from "react";
import { ChevronsUpDown, GitBranch, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@multiremi/ui/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multiremi/ui/components/ui/popover";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../i18n";

interface BranchPickerProps {
  id?: string;
  value: string;
  branches: string[];
  remoteDefaultBranch?: string | null;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  allowCustomValue?: boolean;
  customValueHeading?: string;
  searchPlaceholder?: string;
  onOpenChange?: (open: boolean) => void;
  onValueChange: (value: string) => void | Promise<void>;
}

export function BranchPicker({
  id,
  value,
  branches,
  remoteDefaultBranch,
  placeholder,
  ariaLabel,
  disabled = false,
  loading = false,
  compact = false,
  triggerClassName,
  contentClassName,
  allowCustomValue = false,
  customValueHeading,
  searchPlaceholder,
  onOpenChange,
  onValueChange,
}: BranchPickerProps) {
  const { t } = useT("repositories");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const uniqueBranches = useMemo(() => {
    const values = new Set(branches);
    if (remoteDefaultBranch) values.add(remoteDefaultBranch);
    if (!allowCustomValue && value) values.add(value);
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [allowCustomValue, branches, remoteDefaultBranch, value]);
  const otherBranches = remoteDefaultBranch
    ? uniqueBranches.filter((branch) => branch !== remoteDefaultBranch)
    : uniqueBranches;
  const customValue = search.trim();
  const showCustomValue = allowCustomValue
    && customValue.length > 0
    && !uniqueBranches.includes(customValue);
  const currentCustomValue = allowCustomValue
    && value
    && !uniqueBranches.includes(value)
    ? value
    : "";
  const displayedCustomValue = showCustomValue ? customValue : currentCustomValue;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
    onOpenChange?.(nextOpen);
  };

  const handleSelect = async (branch: string) => {
    setOpen(false);
    setSearch("");
    if (branch !== value) await onValueChange(branch);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "min-w-0 justify-between gap-1.5 font-mono font-normal",
              compact ? "h-7 px-2 text-xs" : "w-full",
              triggerClassName,
            )}
          />
        }
      >
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            !value && "font-sans text-muted-foreground",
          )}
          title={value || undefined}
        >
          {value || placeholder}
        </span>
        {loading ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className={cn(
          "w-96 max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden p-0",
          contentClassName,
        )}
      >
        <Command shouldFilter>
          <CommandInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder ?? t(($) => $.branch_picker.search_placeholder)}
          />
          <CommandList className="max-h-72">
            {loading ? (
              <div
                className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <LoaderCircle className="size-4 animate-spin" />
                {t(($) => $.branch_picker.loading)}
              </div>
            ) : (
              <>
                <CommandEmpty>{t(($) => $.branch_picker.empty)}</CommandEmpty>
                {displayedCustomValue && (
                  <CommandGroup heading={customValueHeading}>
                    <CommandItem
                      value={`custom ${displayedCustomValue}`}
                      data-checked={displayedCustomValue === value}
                      onSelect={() => void handleSelect(displayedCustomValue)}
                    >
                      <GitCommitHorizontal className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono" title={displayedCustomValue}>
                        {displayedCustomValue}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {displayedCustomValue && uniqueBranches.length > 0 && <CommandSeparator />}
                {remoteDefaultBranch && (
                  <CommandGroup heading={t(($) => $.branch_picker.remote_default)}>
                    <CommandItem
                      value={remoteDefaultBranch}
                      data-checked={remoteDefaultBranch === value}
                      onSelect={() => void handleSelect(remoteDefaultBranch)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono" title={remoteDefaultBranch}>
                        {remoteDefaultBranch}
                      </span>
                      <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {t(($) => $.branch_picker.remote_default)}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {remoteDefaultBranch && otherBranches.length > 0 && <CommandSeparator />}
                {otherBranches.length > 0 && (
                  <CommandGroup heading={t(($) => $.branch_picker.other_branches)}>
                    {otherBranches.map((branch) => (
                      <CommandItem
                        key={branch}
                        value={branch}
                        data-checked={branch === value}
                        onSelect={() => void handleSelect(branch)}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono" title={branch}>
                          {branch}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
