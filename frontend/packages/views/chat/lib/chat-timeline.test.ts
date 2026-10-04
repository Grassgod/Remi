import { describe, it, expect } from "vitest";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { toChatTimeline } from "./chat-timeline";
import { splitTimeline } from "./copy-text";

const msg = (seq: number, type: string, content: string): TraceEvent => ({
  seq,
  ts: "2026-09-30T00:00:00Z",
  type,
  content,
});

describe("toChatTimeline", () => {
  it("merges the complete answer across usage and execution metadata", () => {
    const items = toChatTimeline([
      msg(1, "thinking", "Checking."),
      msg(2, "text", "Fixed the bug "),
      { ...msg(3, "usage", ""), meta: { used: 210908, size: 1000000 } },
      msg(4, "execution", ""),
      msg(5, "text", "and added tests."),
    ]);
    expect(items.map((item) => item.type)).toEqual(["thinking", "text"]);
    expect(splitTimeline(items).final.map((item) => item.content)).toEqual(["Fixed the bug and added tests."]);
  });

  it("redacts an answer credential after fragments separated by usage are joined", () => {
    const items = toChatTimeline([
      msg(1, "text", "Authorization: Bearer abc123xyz."),
      msg(2, "usage", ""),
      msg(3, "text", "def456"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("Authorization: Bearer [REDACTED]");
  });

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
