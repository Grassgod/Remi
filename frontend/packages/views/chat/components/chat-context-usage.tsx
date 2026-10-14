"use client";

import type { TraceContextUsage } from "@multiremi/contracts/trace";
import {
  Context,
  ContextContent,
  ContextTrigger,
  contextUsageParts,
} from "@multiremi/ui/components/ai-elements/context";
import { useT } from "../../i18n";

/**
 * Context-window ring beside the composer (PLAN §3, spec §4.2). The provider
 * session carries over between turns, so one value stands for the session:
 * the running turn's latest `turn.context_usage` from its live trace, else
 * the newest finished turn card's `metadata.context_usage`. The ring never
 * reads a finished trace (MUL-472), and hides when the window is unknown.
 */
export function ChatContextUsage({ live, last }: { live: TraceContextUsage | null; last: TraceContextUsage | null }) {
  const { t } = useT("chat");
  const usage = live ?? last;
  if (!usage || !(usage.size > 0)) return null;
  const value = { usedTokens: usage.used, maxTokens: usage.size };
  return (
    <Context {...value}>
      <ContextTrigger aria-label={t(($) => $.input.context_label)} data-chat-context={live ? "live" : "last"} />
      <ContextContent>
        <span className="tabular-nums">{t(($) => $.input.context_usage, contextUsageParts(value))}</span>
      </ContextContent>
    </Context>
  );
}
