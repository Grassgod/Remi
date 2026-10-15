"use client";

import type { TraceLateSubagent } from "@multiremi/contracts/trace";
import { useChatStore } from "@multiremi/core/chat";
import { cn } from "@multiremi/ui/lib/utils";
import { CircleCheck, CircleStop, CircleX, Layers } from "lucide-react";
import { useT } from "../../i18n";
import type { SubagentTraceSource } from "./subagent-context";
import { formatSubagentElapsed } from "./subagent-step-row";

// Subagents that ended after the turn's reply started (PR 5 §6.4): one line
// each under the reply, 「✓ X 已在后台完成 · 24s · 查看结果」, opening the
// subagent's detail in the panel. A live turn derives them from its trace; a
// finished turn reads its card's `late_subagents` and no trace (MUL-472).

/**
 * Rows drawn one by one; any more fold into one line without a number,
 * 「另有更多子代理在后台结束」, which opens the overview. A stored card keeps at
 * most five entries, so a count would disagree with the live turn's.
 */
export const LATE_ROWS_SHOWN = 3;

const ROW = "group/late flex max-w-full min-w-0 items-center gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function SubagentCompletionRows({ late, source }: {
  late: readonly TraceLateSubagent[];
  source: SubagentTraceSource & { attemptId: string };
}) {
  const { t } = useT("chat");
  const panel = useChatStore((s) => s.subagentPanel);
  const open = useChatStore((s) => s.openSubagentPanel);
  if (!late.length) return null;
  const openPath = (path: string[]) => open({
    sessionId: source.sessionId, attemptId: source.attemptId, turnId: source.turnId, live: source.live, path,
  });
  const shown = late.length > LATE_ROWS_SHOWN ? late.slice(0, LATE_ROWS_SHOWN) : late;
  const more = late.length > shown.length;
  return (
    <div data-subagent-late className="flex flex-col items-start gap-1.5">
      {shown.map((entry) => {
        const name = entry.name.trim() || t(($) => $.subagents.unnamed);
        const done = entry.status === "completed";
        const failed = entry.status === "failed";
        const Icon = failed ? CircleX : done ? CircleCheck : CircleStop;
        const selected = panel?.attemptId === source.attemptId && panel.path[0] === entry.item_id;
        return (
          <button key={entry.item_id} type="button" data-subagent-late-row={entry.item_id} data-late-status={entry.status}
            onClick={() => openPath([entry.item_id])} className={cn(ROW, selected && "text-foreground")}>
            <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : done ? "text-emerald-600 dark:text-emerald-400" : "")} aria-hidden="true" />
            <span className="min-w-0 truncate">
              {failed ? t(($) => $.subagents.late_failed, { name })
                : done ? t(($) => $.subagents.late_done, { name }) : t(($) => $.subagents.late_stopped, { name })}
              {done && entry.duration_ms != null && <span className="tabular-nums"> · {formatSubagentElapsed(entry.duration_ms)}</span>}
              <span aria-hidden="true"> · </span>
              <span className="text-foreground/80 underline underline-offset-2 group-hover/late:text-foreground">
                {done ? t(($) => $.subagents.view_result) : t(($) => $.subagents.view_details)}
              </span>
            </span>
          </button>
        );
      })}
      {more && (
        <button type="button" data-subagent-late-more onClick={() => openPath([])}
          className={cn(ROW, panel?.attemptId === source.attemptId && panel.path.length === 0 && "text-foreground")}>
          <Layers className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate underline-offset-2 group-hover/late:underline">
            {t(($) => $.subagents.late_more)}
          </span>
        </button>
      )}
    </div>
  );
}
