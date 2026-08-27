"use client";

import type { FeishuStateTone } from "@multiremi/core/feishu";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { cn } from "@multiremi/ui/lib/utils";

const DOT_CLASS: Record<FeishuStateTone, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
};

const BADGE_VARIANT: Record<FeishuStateTone, "secondary" | "outline" | "destructive"> = {
  ok: "outline",
  warning: "outline",
  danger: "destructive",
  neutral: "secondary",
};

/**
 * Status pill. The dot is decorative and `aria-hidden`: colour never carries
 * the state on its own, the label always does.
 */
export function StateBadge({ tone, label }: { tone: FeishuStateTone; label: string }) {
  return (
    <Badge variant={BADGE_VARIANT[tone]} className="gap-1.5">
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} />
      {label}
    </Badge>
  );
}

/** Absolute local time for `title`, so the visible relative time stays short
 *  while the exact instant is still recoverable. */
export function absoluteTime(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/** Middle-truncates a chat ID so a 320px column never overflows and the
 *  distinguishing tail stays visible. */
export function truncateId(id: string, keep = 6): string {
  if (id.length <= keep * 2 + 1) return id;
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

export function senderName(sender: Record<string, unknown>, fallback: string): string {
  const name = sender.name ?? sender.senderName ?? sender.sender_id ?? sender.senderId;
  return typeof name === "string" && name.length > 0 ? name : fallback;
}
