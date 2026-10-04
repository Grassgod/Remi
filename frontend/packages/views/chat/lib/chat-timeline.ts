import type { TraceEvent } from "@multiremi/contracts/trace";
import type { ChatTimelineItem } from "@multiremi/core/chat";
import { buildTraceTimeline } from "../../common/task-transcript/build-timeline";

/**
 * Adapt a task transcript to what the compact chat surface can render.
 *
 * Bridge context-compaction status lines (`type: "compaction"`) are
 * transcript-only diagnostics: the full transcript dialog gives them their own
 * event row, but chat has no row for them — and leaving them in would be worse
 * than useless, because `splitTimeline` treats every non-text item as a fold
 * boundary. A run whose last event is a compaction chunk would push the real
 * final answer inside the fold and leave `final` empty.
 */
export function toChatTimeline(events: readonly TraceEvent[]): ChatTimelineItem[] {
  return buildTraceTimeline(events).filter(
    (item) => item.type !== "compaction",
  ) as ChatTimelineItem[];
}
