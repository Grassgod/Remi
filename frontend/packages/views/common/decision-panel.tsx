"use client";

import type { ReactNode } from "react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multiremi/ui/components/ui/sheet";

/** The existing Issue Decision presentation, shared by runtime questions. */
export function DecisionPanel({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: ReactNode; description: ReactNode; children: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right"
    className="inset-y-2 right-2 h-auto max-h-[calc(100vh-1rem)] gap-0 overflow-hidden rounded-md border sm:top-8 sm:bottom-auto sm:h-[610px] data-[side=right]:w-[calc(100%-1rem)] data-[side=right]:sm:w-[720px] data-[side=right]:sm:max-w-[calc(100%-1rem)]" data-issue-decision-overlay>
    <SheetHeader className="shrink-0 border-b pr-12"><SheetTitle>{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription></SheetHeader>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
  </SheetContent></Sheet>;
}

export function DecisionCardFrame({ id, children }: { id: string; children: ReactNode }) {
  return <article className="min-w-0 rounded-md border bg-background p-3" data-decision-entry={id}>{children}</article>;
}

export function DecisionAnswerArea({ children }: { children: ReactNode }) {
  return <div className="mt-3 space-y-2 border-t pt-2.5">{children}</div>;
}

/** The original Decision option buttons; native AUQ only supplies selection semantics. */
export function DecisionOptions({ options, selected, onSelect, disabled, readOnly }: {
  options: readonly { value: string; label: string; description?: string }[];
  selected: readonly string[]; onSelect: (value: string) => void;
  disabled?: boolean; readOnly?: boolean;
}) {
  return <div className="flex flex-wrap gap-1.5">{options.map(option => readOnly
    ? <span key={option.value} className="max-w-full rounded border px-2 py-1 text-xs text-muted-foreground" title={option.description}>{option.label}</span>
    : <Button key={option.value} size="sm" variant={selected.includes(option.value) ? "default" : "outline"}
      aria-pressed={selected.includes(option.value)} disabled={disabled} title={option.description}
      className="h-auto max-w-full whitespace-normal break-words text-left" onClick={() => onSelect(option.value)}>{option.label}</Button>)}</div>;
}
