import type { TaskMessagePayload } from "@multiremi/core/types/events";
import type { ChatTimelineItem } from "@multiremi/core/chat";
import { buildTimeline } from "../../common/task-transcript";

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
export function toChatTimeline(msgs: TaskMessagePayload[]): ChatTimelineItem[] {
  return buildTimeline(msgs).filter(
    (item): item is ChatTimelineItem => item.type !== "compaction",
  );
}
