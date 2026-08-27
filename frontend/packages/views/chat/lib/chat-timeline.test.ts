import { describe, it, expect } from "vitest";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import { toChatTimeline } from "./chat-timeline";
import { splitTimeline } from "./copy-text";

const msg = (seq: number, type: string, content: string): TaskMessagePayload => ({
  task_id: "t1",
  issue_id: "i1",
  seq,
  type,
  content,
});

describe("toChatTimeline", () => {
  it("drops bridge compaction status rows", () => {
    const items = toChatTimeline([
      msg(1, "text", "Looking into it."),
      msg(2, "compaction", "Compacting..."),
      msg(3, "text", "Fixed the bug and added tests."),
    ]);
    expect(items.map((i) => i.type)).toEqual(["text", "text"]);
    expect(items.map((i) => i.content)).toEqual([
      "Looking into it.",
      "Fixed the bug and added tests.",
    ]);
  });

  it("keeps the real answer below the fold when a run ends on compaction", () => {
    // Without the filter, the trailing compaction row would be the last
    // non-text item, so splitTimeline would return an empty `final` and the
    // answer would be hidden inside the collapsed fold.
    const items = toChatTimeline([
      msg(1, "thinking", "..."),
      msg(2, "text", "Fixed the bug and added tests."),
      msg(3, "compaction", "Compacting completed."),
    ]);
    const { final } = splitTimeline(items);
    expect(final.map((i) => i.content)).toEqual(["Fixed the bug and added tests."]);
  });

  it("leaves prose that merely mentions compaction alone", () => {
    const items = toChatTimeline([msg(1, "text", "The run hit Compacting... midway.")]);
    expect(items.map((i) => i.type)).toEqual(["text"]);
  });
});
