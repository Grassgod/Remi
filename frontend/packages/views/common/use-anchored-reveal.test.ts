import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createScrollFixture, installManualRaf, type ManualRaf, type ScrollFixture } from "../test/scroll-fixture";
import { useAnchoredReveal, type UseAnchoredRevealOptions } from "./use-anchored-reveal";

/**
 * The hook is driven through the two browser APIs it depends on, both made
 * deterministic here: animation frames run only when a test asks for one, so
 * "which frame revealed" is an assertion instead of a race, and the scroll root
 * clamps `scrollTop` the way a real element does.
 */

describe("useAnchoredReveal", () => {
  let raf: ManualRaf;
  let fixture: ScrollFixture;

  beforeEach(() => {
    raf = installManualRaf();
    fixture = createScrollFixture();
  });

  afterEach(() => {
    raf.restore();
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  const renderReveal = (props: UseAnchoredRevealOptions) =>
    renderHook((current: UseAnchoredRevealOptions) => useAnchoredReveal(current), { initialProps: props });

  const baseProps = (overrides: Partial<UseAnchoredRevealOptions> = {}): UseAnchoredRevealOptions => ({
    scrollEl: fixture.root,
    contentEl: fixture.content,
    resetKey: "issue:1:latest",
    dataReady: false,
    anchor: { kind: "bottom" },
    ...overrides,
  });

  /** Run `count` animation frames, each one its own turn. */
  const runFrames = (count: number): void => {
    for (let frame = 0; frame < count; frame += 1) {
      act(() => {
        raf.runFrame();
      });
    }
  };

  it("hides the content and publishes pending while gate (i) is closed", () => {
    const { result } = renderReveal(baseProps());

    expect(fixture.content.style.visibility).toBe("hidden");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("pending");
    expect(fixture.root.hasAttribute("data-perf-fresh")).toBe(false);
    expect(result.current).toEqual({ state: "pending", revealed: false });
    // Nothing is measured before the consumer declares the data ready.
    expect(raf.pending()).toBe(0);
    expect(fixture.root.scrollTop).toBe(0);
  });

  it("aims before the next frame and reveals on the second stable frame", async () => {
    const props = baseProps();
    const { result, rerender } = renderReveal(props);

    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName ?? "?";
        mutations.push(`${name}:${(record.target as Element).getAttribute(name) ?? ""}`);
      }
    });
    observer.observe(fixture.root, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style", "data-perf-state", "data-perf-fresh"],
    });
    await Promise.resolve();
    mutations.length = 0;

    rerender({ ...props, dataReady: true });
    // The target is applied before the frame after the gate opened.
    expect(fixture.root.scrollTop).toBe(600);

    runFrames(1);
    expect(result.current.state).toBe("pending");

    runFrames(1);
    expect(result.current).toEqual({ state: "ready", revealed: true });
    expect(fixture.content.style.visibility).toBe("");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("ready");

    // The reveal frame clears the hidden flag and publishes the state, both
    // before React commits inside the same frame.
    await Promise.resolve();
    expect(mutations).toEqual(["style:", "data-perf-state:ready"]);
    observer.disconnect();

    runFrames(3);
    expect(mutations).toHaveLength(2);
    expect(raf.pending()).toBe(0);

    // A later gate failure does not hide the content again; only `resetKey`
    // restarts the machine.
    rerender({ ...props, dataReady: false });
    expect(result.current.state).toBe("ready");
    expect(fixture.content.style.visibility).toBe("");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("ready");
  });

  it("re-applies the target when the content height changes while settling", () => {
    const { result } = renderReveal(baseProps({ dataReady: true }));
    expect(fixture.root.scrollTop).toBe(600);

    runFrames(1);
    expect(result.current.state).toBe("pending");

    // Content lands above the anchor: the target moves and the count restarts.
    fixture.setScrollHeight(1400);
    runFrames(1);
    expect(fixture.root.scrollTop).toBe(1000);
    expect(result.current.state).toBe("pending");

    runFrames(1);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.scrollTop).toBe(1000);
  });

  it("reveals as ready-forced when the budget expires with a gate unmet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderReveal(
      baseProps({ dataReady: true, layoutSettled: false, budgetMs: 0 }),
    );

    runFrames(1);

    expect(result.current).toEqual({ state: "ready-forced", revealed: true });
    expect(fixture.root.getAttribute("data-perf-state")).toBe("ready-forced");
    expect(fixture.content.style.visibility).toBe("");
    // The forced path aims one last time before showing.
    expect(fixture.root.scrollTop).toBe(600);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("layoutSettled");
    expect(raf.pending()).toBe(0);
  });

  it("names the unloaded in-viewport image when the budget forces the reveal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const image = document.createElement("img");
    image.setAttribute("src", "/pending.png");
    image.getBoundingClientRect = () => fixture.root.getBoundingClientRect();
    fixture.content.appendChild(image);

    const { result } = renderReveal(baseProps({ dataReady: true, budgetMs: 0 }));
    runFrames(1);

    expect(result.current.state).toBe("ready-forced");
    expect(String(warn.mock.calls[0]?.[0])).toContain("images");
  });

  it("holds the reveal for an unloaded in-viewport image until its wait budget is spent", () => {
    const image = document.createElement("img");
    image.setAttribute("src", "/pending.png");
    image.getBoundingClientRect = () => fixture.root.getBoundingClientRect();
    fixture.content.appendChild(image);

    const props = baseProps({ dataReady: true });
    const { result, rerender } = renderReveal(props);

    runFrames(6);
    expect(result.current.state).toBe("pending");
    expect(fixture.content.style.visibility).toBe("hidden");
    expect(raf.pending()).toBeGreaterThan(0);

    // Once the image wait is over, the reveal proceeds without the budget.
    rerender({ ...props, imageWaitMs: 0 });
    runFrames(2);
    expect(result.current.state).toBe("ready");
  });

  it("does not wait for an image outside the viewport", () => {
    const image = document.createElement("img");
    image.setAttribute("src", "/off-screen.png");
    image.getBoundingClientRect = () =>
      ({ ...fixture.root.getBoundingClientRect(), top: 5000, bottom: 5100 }) as DOMRect;
    fixture.content.appendChild(image);

    const { result } = renderReveal(baseProps({ dataReady: true }));
    runFrames(2);

    expect(result.current.state).toBe("ready");
  });

  it("restarts on resetKey and hides the content again", () => {
    const props = baseProps({ dataReady: true });
    const { result, rerender } = renderReveal(props);
    runFrames(2);
    expect(result.current.state).toBe("ready");

    fixture.setScrollHeight(1600);
    rerender({ ...props, resetKey: "issue:2:latest" });
    expect(result.current.state).toBe("pending");
    expect(fixture.content.style.visibility).toBe("hidden");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("pending");
    expect(fixture.root.scrollTop).toBe(1200);

    runFrames(2);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.scrollTop).toBe(1200);
  });

  it("keeps fresh undeclared by removing data-perf-fresh", () => {
    // A previous page may have left the attribute behind; the pending frame of
    // a new activation is where it has to go.
    fixture.root.setAttribute("data-perf-fresh", "1");
    const { result } = renderReveal(baseProps({ dataReady: true }));

    expect(result.current.state).toBe("pending");
    expect(fixture.root.hasAttribute("data-perf-fresh")).toBe(false);

    runFrames(2);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.hasAttribute("data-perf-fresh")).toBe(false);
  });

  it("removes data-perf-fresh again when a later activation omits it", () => {
    const props = baseProps({ dataReady: true, fresh: true });
    const { rerender } = renderReveal(props);
    expect(fixture.root.getAttribute("data-perf-fresh")).toBe("1");

    rerender({ ...props, fresh: undefined });
    expect(fixture.root.hasAttribute("data-perf-fresh")).toBe(false);
  });

  it("publishes data-perf-fresh=0/1 on the same frames as the state", async () => {
    const props = baseProps({ dataReady: true, fresh: false });
    const { result, rerender } = renderReveal(props);
    expect(fixture.root.getAttribute("data-perf-fresh")).toBe("0");

    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName ?? "?";
        mutations.push(`${name}:${(record.target as Element).getAttribute(name) ?? ""}`);
      }
    });
    observer.observe(fixture.root, { attributes: true, attributeFilter: ["data-perf-state", "data-perf-fresh"] });
    await Promise.resolve();
    mutations.length = 0;

    // A page that learns it is stale while still hidden says so before revealing.
    rerender({ ...props, fresh: true });
    expect(result.current.state).toBe("pending");
    expect(fixture.root.getAttribute("data-perf-fresh")).toBe("1");

    runFrames(2);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.getAttribute("data-perf-fresh")).toBe("1");
    // The reveal frame carries the freshness bit it published.
    await Promise.resolve();
    expect(mutations).toEqual(["data-perf-fresh:1", "data-perf-state:ready"]);
    observer.disconnect();
  });

  it("does not touch `data-perf-state` after the reveal", async () => {
    const { result, rerender } = renderReveal(baseProps({ dataReady: true }));
    runFrames(2);
    expect(result.current.state).toBe("ready");

    const observer = new MutationObserver(() => {});
    observer.observe(fixture.root, { attributes: true, attributeFilter: ["data-perf-state", "data-perf-fresh"] });
    await Promise.resolve();

    // A consumer re-render with a fresh `anchor` object must not re-publish.
    rerender(baseProps({ dataReady: true, anchor: { kind: "bottom" } }));
    runFrames(3);
    await Promise.resolve();
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it("passes through when enabled is false, and hides again when it turns on", () => {
    const props = baseProps({ dataReady: true, enabled: false });
    const { result, rerender } = renderReveal(props);

    expect(result.current).toEqual({ state: "ready", revealed: true });
    expect(fixture.content.style.visibility).toBe("");
    expect(fixture.root.hasAttribute("data-perf-state")).toBe(false);
    expect(fixture.root.hasAttribute("data-perf-fresh")).toBe(false);
    expect(raf.pending()).toBe(0);
    expect(fixture.root.scrollTop).toBe(0);

    rerender({ ...props, enabled: true });
    expect(result.current.state).toBe("pending");
    expect(fixture.content.style.visibility).toBe("hidden");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("pending");

    runFrames(2);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.scrollTop).toBe(600);
  });

  it("stays pending, without touching the DOM, until its elements exist", () => {
    const content = document.createElement("div");
    const { result, rerender } = renderHook(
      (current: UseAnchoredRevealOptions) => useAnchoredReveal(current),
      {
        initialProps: {
          scrollEl: null,
          contentEl: null,
          resetKey: "issue:1:latest",
          dataReady: true,
          anchor: { kind: "bottom" },
        } as UseAnchoredRevealOptions,
      },
    );
    expect(result.current).toEqual({ state: "pending", revealed: false });
    expect(raf.pending()).toBe(0);
    expect(content.style.visibility).toBe("");

    // With a scroll root but no content wrapper, the attribute still reports the
    // hidden phase rather than disappearing.
    rerender({
      scrollEl: fixture.root,
      contentEl: null,
      resetKey: "issue:1:latest",
      dataReady: true,
      anchor: { kind: "bottom" },
    });
    expect(fixture.root.getAttribute("data-perf-state")).toBe("pending");
    expect(raf.pending()).toBe(0);

    // The consumer mounts its scroll root on a later render.
    rerender(baseProps({ dataReady: true }));
    expect(result.current.state).toBe("pending");
    expect(fixture.content.style.visibility).toBe("hidden");
    expect(fixture.root.getAttribute("data-perf-state")).toBe("pending");

    runFrames(2);
    expect(result.current.state).toBe("ready");
  });

  it("centres an element anchor and aligns a taller-than-viewport row to its top", () => {
    const row = fixture.addRow({ id: "comment-42", offset: 500, height: 100 });
    const props = baseProps({
      dataReady: true,
      resetKey: "issue:1:comment-42",
      anchor: { kind: "element", id: "comment-42" },
    });
    const { result, rerender } = renderReveal(props);

    // 500 (row offset) - (400 - 100) / 2 = 350.
    expect(fixture.root.scrollTop).toBe(350);
    runFrames(2);
    expect(result.current.state).toBe("ready");

    // A row taller than the viewport can only show its top edge.
    const tall = document.createElement("div");
    tall.id = "comment-43";
    tall.getBoundingClientRect = () =>
      ({ ...row.getBoundingClientRect(), top: 500 - fixture.root.scrollTop, height: 800, bottom: 1300 - fixture.root.scrollTop }) as DOMRect;
    fixture.content.appendChild(tall);

    rerender({ ...props, resetKey: "issue:1:comment-43", anchor: { kind: "element", id: "comment-43" } });
    expect(result.current.state).toBe("pending");
    expect(fixture.root.scrollTop).toBe(500);
    runFrames(2);
    expect(result.current.state).toBe("ready");
  });

  it("honours an explicit start alignment", () => {
    fixture.setScrollHeight(2000);
    fixture.addRow({ id: "comment-7", offset: 900, height: 100 });
    renderReveal(
      baseProps({
        dataReady: true,
        resetKey: "issue:1:comment-7",
        anchor: { kind: "element", id: "comment-7", align: "start" },
      }),
    );
    // Centring would be 900 - (400 - 100) / 2 = 750; start alignment asks for 900.
    expect(fixture.root.scrollTop).toBe(900);
  });

  it("clamps an element anchor above the content origin", () => {
    // The row sits close enough to the top that centring it would ask for a
    // negative scroll position; a real element clamps to 0.
    fixture.addRow({ id: "comment-1", offset: 20, height: 100 });
    renderReveal(
      baseProps({
        dataReady: true,
        resetKey: "issue:1:comment-1",
        anchor: { kind: "element", id: "comment-1" },
      }),
    );
    expect(fixture.root.scrollTop).toBe(0);
  });

  it("keeps waiting for an element anchor that is not mounted yet", () => {
    const props = baseProps({
      dataReady: true,
      resetKey: "issue:1:comment-99",
      anchor: { kind: "element", id: "comment-99" },
    });
    const { result, rerender } = renderReveal(props);
    runFrames(4);
    expect(result.current.state).toBe("pending");
    expect(fixture.content.style.visibility).toBe("hidden");

    fixture.addRow({ id: "comment-99", offset: 700, height: 100 });
    rerender({ ...props });
    runFrames(2);
    expect(result.current.state).toBe("ready");
    expect(fixture.root.scrollTop).toBe(550);
  });

  it("starts the budget when the data becomes ready, not when the first frame runs", () => {
    // A slow render after gate (i) must not eat the reveal's budget: the state
    // still reaches a plain `ready` rather than `ready-forced`.
    const props = baseProps({ dataReady: false, budgetMs: 1000 });
    const { result, rerender } = renderReveal(props);
    rerender({ ...props, dataReady: true });
    expect(result.current.state).toBe("pending");

    runFrames(2);
    expect(result.current).toEqual({ state: "ready", revealed: true });
  });

  it("keeps the previous activation's frame from revealing the new anchor", () => {
    const props = baseProps({ dataReady: true, budgetMs: 0 });
    const { result, rerender } = renderReveal(props);
    rerender({ ...props, resetKey: "issue:2:latest" });
    expect(result.current.state).toBe("pending");

    // Nothing from the first activation is left in flight to fire.
    runFrames(2);
    expect(result.current.state).toBe("ready-forced");
  });
});
