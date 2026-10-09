"use client";

import type { ReactNode } from "react";
import { History, LoaderCircle } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multiremi/ui/components/ui/sheet";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { Markdown } from "./markdown";

/** Presentation from the original DecisionCard (f80b10674), with the wider panel. */
export function DecisionPanel({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: ReactNode; description: ReactNode; children: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right"
    className="gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-[720px]" data-issue-decision-overlay>
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

export function DecisionHeading({ title, body, actions }: { title: string; body?: string | null; actions?: ReactNode }) {
  return <div className="flex items-start justify-between gap-2">
    <div className="min-w-0">
      <h4 className="break-words text-sm font-medium">{title}</h4>
      {body && <Markdown mode="minimal" className="mt-1 text-xs text-muted-foreground [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">{body}</Markdown>}
    </div>
    {actions}
  </div>;
}

export function DecisionSubmit({ label, pending, disabled, error, onSubmit }: {
  label: string; pending: boolean; disabled: boolean; error?: string | null; onSubmit: () => void;
}) {
  return <div className="flex min-h-8 items-center justify-between gap-2" data-decision-submit>
    <span role={error ? "alert" : undefined} className={cn("min-w-0 truncate text-xs text-destructive", !error && "invisible")}>{error ?? "\u00a0"}</span>
    <Button type="button" size="sm" className="shrink-0" disabled={disabled || pending} onClick={onSubmit}>
      {pending && <LoaderCircle className="size-3.5 animate-spin" />}{label}
    </Button>
  </div>;
}

export function DecisionHistory({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mt-3 space-y-2 border-t pt-2.5" data-decision-history>
    <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><History className="size-3.5" />{title}</div>
    {children}
  </div>;
}

export function DecisionHistoryEntry({ actor, answer, reason, reasonLabel, overturn, overturnLabel }: {
  actor: string; answer: string; reason?: string | null; reasonLabel: string; overturn?: string | null; overturnLabel: string;
}) {
  return <div className="rounded bg-muted/50 p-2 text-xs" data-decision-answer>
    <div className="truncate font-medium" title={actor}>{actor}</div>
    <div className="mt-1 whitespace-pre-wrap break-words">{answer}</div>
    {reason && <div className="mt-1 text-muted-foreground"><span className="font-medium">{reasonLabel}: </span>{reason}</div>}
    {overturn && <div className="mt-1 text-muted-foreground"><span className="font-medium">{overturnLabel}: </span>{overturn}</div>}
  </div>;
}

export function DecisionSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2.5" aria-label={title}>
    <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>{children}
  </section>;
}

export function DecisionListSkeleton() {
  return <div className="space-y-3" aria-hidden="true">{[0, 1, 2].map(index => <div key={index} className="rounded-md border p-3">
    <Skeleton className="h-4 w-2/3" /><Skeleton className="mt-2 h-3 w-full" /><Skeleton className="mt-1 h-3 w-4/5" /><Skeleton className="mt-3 h-8 w-full" />
  </div>)}</div>;
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
