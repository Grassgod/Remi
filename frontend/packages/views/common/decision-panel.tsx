"use client";

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multiremi/ui/components/ui/sheet";

/** The existing Issue Decision presentation, shared by runtime questions. */
export function DecisionPanel({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: ReactNode; description: ReactNode; children: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right"
    className="inset-y-2 right-2 h-auto max-h-[calc(100vh-1rem)] w-[calc(100%-1rem)] gap-0 overflow-hidden rounded-md border sm:top-8 sm:bottom-auto sm:h-[610px] sm:w-[440px] sm:max-w-[440px]" data-issue-decision-overlay>
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
