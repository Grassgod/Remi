"use client"

// Adapted from AI Elements `context.tsx`
// (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
// licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0).
//
// Changes from the original: a Base UI preview card instead of Radix; the
// trigger is the ring alone (12px, 2px stroke, a 16% track, no percentage
// text) and turns destructive at 90%; the card shows one "used / total · %"
// line; the AI SDK usage type, the progress bar, the per-category token rows
// and the tokenlens cost estimate are dropped.

import { createContext, useContext, useMemo, type ComponentProps } from "react"

import { cn } from "../../lib/utils"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"

interface ContextValue {
  usedTokens: number
  maxTokens: number
}

const ContextValueContext = createContext<ContextValue | null>(null)

function useContextValue(): ContextValue {
  const value = useContext(ContextValueContext)
  if (!value) throw new Error("Context components must be used within Context")
  return value
}

/** Share of the window in use, clamped to [0, 1]. */
export function contextUsedFraction({ usedTokens, maxTokens }: ContextValue): number {
  return maxTokens > 0 ? Math.min(1, Math.max(0, usedTokens / maxTokens)) : 0
}

/** At or past this share the ring turns destructive. */
export const CONTEXT_DANGER_FRACTION = 0.9

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const wholePercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
})

/** The compact pieces of "120K / 200K · 60%", for callers that localize the line. */
export function contextUsageParts(value: ContextValue): { used: string; size: string; percent: string } {
  return {
    used: compactTokens.format(value.usedTokens),
    size: compactTokens.format(value.maxTokens),
    percent: wholePercent.format(contextUsedFraction(value)),
  }
}

/** "120K / 200K · 60%". */
export function formatContextUsage(value: ContextValue): string {
  const { used, size, percent } = contextUsageParts(value)
  return `${used} / ${size} · ${percent}`
}

export type ContextProps = ComponentProps<typeof HoverCard> & ContextValue

export function Context({ usedTokens, maxTokens, ...props }: ContextProps) {
  const value = useMemo(() => ({ usedTokens, maxTokens }), [usedTokens, maxTokens])
  return (
    <ContextValueContext.Provider value={value}>
      <HoverCard {...props} />
    </ContextValueContext.Provider>
  )
}

const RING_SIZE = 12
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2

export function ContextIcon({ className }: { className?: string }) {
  const fraction = contextUsedFraction(useContextValue())
  const circumference = 2 * Math.PI * RING_RADIUS
  return (
    <svg
      aria-hidden="true"
      data-slot="context-ring"
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className={cn("size-3 -rotate-90", className)}
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        opacity="0.16"
      />
      <circle
        data-slot="context-ring-arc"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - fraction)}
        className="transition-[stroke-dashoffset] duration-[120ms] ease-out motion-reduce:transition-none"
      />
    </svg>
  )
}

export type ContextTriggerProps = ComponentProps<typeof HoverCardTrigger>

export function ContextTrigger({ className, children, ...props }: ContextTriggerProps) {
  const value = useContextValue()
  const danger = contextUsedFraction(value) >= CONTEXT_DANGER_FRACTION
  return (
    <HoverCardTrigger
      delay={150}
      render={<button type="button" />}
      data-slot="context-trigger"
      data-danger={danger ? "" : undefined}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        danger && "text-destructive hover:text-destructive",
        className
      )}
      {...props}
    >
      {children ?? <ContextIcon />}
    </HoverCardTrigger>
  )
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>

export function ContextContent({ className, children, ...props }: ContextContentProps) {
  const value = useContextValue()
  return (
    <HoverCardContent
      side="top"
      align="end"
      data-slot="context-content"
      className={cn("w-auto px-2.5 py-1.5 text-xs", className)}
      {...props}
    >
      {children ?? <span className="tabular-nums">{formatContextUsage(value)}</span>}
    </HoverCardContent>
  )
}
