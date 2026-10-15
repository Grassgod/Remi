"use client"

// Adapted from AI Elements `chain-of-thought.tsx`
// (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
// licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0).
//
// Changes from the original: one Base UI Collapsible owns the open state
// instead of two Radix roots kept in sync through context; the header has no
// leading icon, its chevron sits beside the label and a hairline fills the rest
// of the row; the panel animates its height (300ms, collapsing in 150ms); the
// step, search-result and image parts are dropped (callers render their own
// rows).

import { ChevronRightIcon } from "lucide-react"
import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible"

export type ChainOfThoughtProps = ComponentProps<typeof Collapsible>

export function ChainOfThought({ className, ...props }: ChainOfThoughtProps) {
  return (
    <Collapsible
      data-slot="chain-of-thought"
      className={cn("not-prose w-full", className)}
      {...props}
    />
  )
}

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger>

export function ChainOfThoughtHeader({
  className,
  children,
  ...props
}: ChainOfThoughtHeaderProps) {
  return (
    <div data-slot="chain-of-thought-row" className="flex min-w-0 items-center gap-2">
      <CollapsibleTrigger
        data-slot="chain-of-thought-header"
        className={cn(
          "group/cot-header flex min-w-0 max-w-full items-center gap-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          className
        )}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronRightIcon
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]/cot-header:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
    </div>
  )
}

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>

export function ChainOfThoughtContent({
  className,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent
      data-slot="chain-of-thought-content"
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(.19,1,.22,1)] data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:h-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}
