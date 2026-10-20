import { describe, expect, it } from "vitest";
import { CHAT_COLUMN_CLASS, CHAT_PANE_CLASS } from "./chat-column";

/** The column's box width in a Chat page pane `pane` px wide, read from its classes. */
function columnWidth(pane: number): number {
  const wide = /@min-\[(\d+)px\]\/chat-pane:max-w-\[clamp\((\d+)px,(\d+)cqi,(\d+)px\)\]/.exec(CHAT_COLUMN_CLASS)!;
  const [from, min, percent, max] = wide.slice(1).map(Number) as [number, number, number, number];
  const base = Number(/(?:^|\s)max-w-\[(\d+)px\]/.exec(CHAT_COLUMN_CLASS)![1]);
  return pane >= from ? Math.min(max, Math.max(min, (percent * pane) / 100)) : Math.min(pane, base);
}

describe("Chat column", () => {
  it("is 768px up to a 1200px pane, then grows with the pane to 960px at 1500px", () => {
    expect(CHAT_COLUMN_CLASS.split(" ")).toEqual([
      "mx-auto", "w-full", "max-w-[768px]", "px-4",
      "@min-[1200px]/chat-pane:max-w-[clamp(768px,64cqi,960px)]",
    ]);
    expect(CHAT_PANE_CLASS).toBe("@container/chat-pane");
    expect([600, 1000, 1199, 1200, 1250, 1400, 1499, 1500, 1920].map(columnWidth))
      .toEqual([600, 768, 768, 768, 800, 896, 959.36, 960, 960]);
  });
});
