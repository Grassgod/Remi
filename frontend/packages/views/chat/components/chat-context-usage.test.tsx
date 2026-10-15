import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { contextRingSource } from "../lib/turn-card";
import { ChatContextUsage } from "./chat-context-usage";

const ring = () => document.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]');

describe("ChatContextUsage", () => {
  it("draws the ring only, without a percentage, and prefers the live value", () => {
    renderWithI18n(<ChatContextUsage live={{ used: 50_000, size: 200_000 }} last={{ used: 190_000, size: 200_000 }} />);
    expect(ring()).toHaveAttribute("data-chat-context", "live");
    expect(ring()).toHaveAccessibleName("Context window usage: 50K / 200K used · 25%");
    expect(ring()!.textContent).toBe("");
    expect(ring()!.hasAttribute("data-danger")).toBe(false);
    const arc = ring()!.querySelector<SVGCircleElement>('[data-slot="context-ring-arc"]')!;
    const circumference = 2 * Math.PI * 5;
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.75);
  });

  it("falls back to the last finished turn and turns destructive at 90%", () => {
    renderWithI18n(<ChatContextUsage live={null} last={{ used: 180_000, size: 200_000 }} />);
    expect(ring()).toHaveAttribute("data-chat-context", "last");
    expect(ring()!.hasAttribute("data-danger")).toBe(true);
    expect(ring()!.className).toContain("text-destructive");
  });

  it("shows used / total · % on hover", async () => {
    renderWithI18n(<ChatContextUsage live={{ used: 120_000, size: 200_000 }} last={null} />, { locale: "zh-Hans" });
    fireEvent.focus(ring()!);
    fireEvent.mouseEnter(ring()!);
    fireEvent.pointerEnter(ring()!);
    await waitFor(() => expect(screen.getByText("已用 120K / 200K · 60%")).toBeInTheDocument());
  });

  it.each([
    [null, null],
    [{ used: 10, size: 0 }, null],
    [null, { used: 10, size: 0 }],
  ])("hides when the window is unknown (%j, %j)", (live, last) => {
    renderWithI18n(<ChatContextUsage live={live} last={last} />);
    expect(ring()).toBeNull();
  });
});

describe("contextRingSource", () => {
  const card = (taskId: string, metadata: Record<string, unknown>) => ({ kind: "turn", task_id: taskId, metadata });

  it("follows the running pending task's live trace", () => {
    expect(contextRingSource([card("att_0", { status: "completed", context_usage: { used: 1, size: 10 } })], "att_1"))
      .toEqual({ liveTaskId: "att_1", last: { used: 1, size: 10 } });
  });

  it("reads the newest terminal card once the pending task's card landed, never its trace", () => {
    const rows = [
      card("att_0", { status: "completed", context_usage: { used: 1, size: 10 } }),
      { kind: "message", metadata: {} },
      card("att_1", { status: "completed", context_usage: { used: 7, size: 10 } }),
    ];
    expect(contextRingSource(rows, "att_1")).toEqual({ liveTaskId: null, last: { used: 7, size: 10 } });
    expect(contextRingSource(rows, null)).toEqual({ liveTaskId: null, last: { used: 7, size: 10 } });
  });

  it("keeps the last live value until the turn's own card lands", () => {
    const previous = card("att_0", { status: "completed", context_usage: { used: 1, size: 10 } });
    const held = { taskId: "att_1", usage: { used: 6, size: 10 } };
    // Chat-done cleared the pending task; the card is missing or not terminal yet.
    expect(contextRingSource([previous], null, held)).toEqual({ liveTaskId: null, last: { used: 6, size: 10 } });
    expect(contextRingSource([previous, card("att_1", { status: "running" })], null, held).last).toEqual({ used: 6, size: 10 });
    // While the turn runs, the live trace is the source.
    expect(contextRingSource([previous], "att_1", held)).toEqual({ liveTaskId: "att_1", last: { used: 1, size: 10 } });
    // Once its card lands, the card wins; so does any later card.
    const landed = [previous, card("att_1", { status: "completed", context_usage: { used: 7, size: 10 } })];
    expect(contextRingSource(landed, null, held).last).toEqual({ used: 7, size: 10 });
    expect(contextRingSource([...landed, card("att_2", { status: "completed" })], null, held).last).toBeNull();
  });

  it("skips nonterminal cards, reads null for an old card and ignores optimistic ids", () => {
    const rows = [
      card("att_0", { status: "completed", context_usage: { used: 1, size: 10 } }),
      card("att_1", { status: "completed" }),
      card("att_2", { status: "running", context_usage: { used: 9, size: 10 } }),
    ];
    expect(contextRingSource(rows, "optimistic-1")).toEqual({ liveTaskId: null, last: null });
    expect(contextRingSource([card("att_0", { status: "failed", context_usage: { used: "x", size: 10 } })], null).last).toBeNull();
  });
});
