import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  createScrollFixture,
  installFakeResizeObserver,
  type FakeResizeObserver,
  type ScrollFixture,
} from "../test/scroll-fixture";
import { useStickToBottom, type UseStickToBottomOptions } from "./use-stick-to-bottom";

/**
 * The hook's two browser dependencies are driven explicitly: the resize observer
 * fires only when a test calls `trigger()`, so "the compensation happened inside
 * the callback" and "before the next paint" are checkable claims, not timings.
 */

describe("useStickToBottom", () => {
  let resize: FakeResizeObserver;
  let fixture: ScrollFixture;
  /** Scroll positions read from inside each resize callback delivery. */
  let scrollTopInCallback: number[];

  beforeEach(() => {
    fixture = createScrollFixture();
    scrollTopInCallback = [];
    resize = installFakeResizeObserver(() => scrollTopInCallback.push(fixture.root.scrollTop));
  });

  afterEach(() => {
    resize.restore();
    fixture.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const renderStick = (props: UseStickToBottomOptions) =>
    renderHook((current: UseStickToBottomOptions) => useStickToBottom(current), { initialProps: props });

  const baseProps = (overrides: Partial<UseStickToBottomOptions> = {}): UseStickToBottomOptions => ({
    scrollEl: fixture.root,
    contentEl: fixture.content,
    mode: { kind: "bottom" },
    enabled: true,
    ...overrides,
  });

  /** Run something that may transition the machine, and flush the render it causes. */
  const fire = (callback: () => void): void => {
    act(callback);
  };

  const wheelUp = (): void => {
    fixture.root.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  };

  it("starts pinned and compensates inside the resize callback, in the same frame", () => {
    // The assertion runs inside the fake ResizeObserver callback itself: the
    // corrected scrollTop has to be there before the callback that the browser
    // delivers between layout and paint returns.
    fixture.userScroll(600);
    const { result } = renderStick(baseProps());
    fire(() => {});
    expect(result.current.state).toBe("pinned");
    expect(resize.countFor(fixture.content)).toBe(1);

    // Content lands above the viewport, so the page has to move down by exactly
    // that much, inside the callback and before anything paints.
    fixture.setScrollHeight(1300);
    fire(() => {
      resize.trigger();
    });

    expect(scrollTopInCallback).toEqual([900]);
    expect(fixture.root.scrollTop).toBe(900);
    expect(result.current.state).toBe("pinned");
    expect(fixture.root.scrollHeight - fixture.root.scrollTop - fixture.root.clientHeight).toBe(0);
  });

  it("preserves the distance to the bottom when the page was not exactly at the bottom", () => {
    const { result } = renderStick(baseProps());
    // 20px from the bottom: inside the default pin window.
    fire(() => {
      fixture.userScroll(580);
    });
    expect(result.current.state).toBe("pinned");

    fixture.setScrollHeight(1200);
    fire(() => {
      resize.trigger();
    });

    expect(fixture.root.scrollTop).toBe(780);
    expect(fixture.root.scrollHeight - fixture.root.scrollTop - fixture.root.clientHeight).toBe(20);
  });

  it("does not fight the user after a release", () => {
    const { result } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(600);
      wheelUp();
    });
    expect(result.current.state).toBe("released");

    const scrollTopAfterRelease = fixture.root.scrollTop;
    fixture.setScrollHeight(1300);
    fire(() => {
      resize.trigger();
    });
    // Released means the content moves above the viewport, not the scroll.
    expect(fixture.root.scrollTop).toBe(scrollTopAfterRelease);
  });

  it.each([
    ["wheel up", (el: HTMLElement) => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))],
    ["touch drag", (el: HTMLElement) => el.dispatchEvent(new Event("touchmove", { bubbles: true }))],
    ["ArrowUp", (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))],
    ["PageUp", (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))],
    ["Home", (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))],
    ["Shift+Space", (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }))],
    [
      "scrollbar grab",
      (el: HTMLElement) => {
        const event = new MouseEvent("pointerdown", { bubbles: true });
        Object.defineProperty(event, "offsetX", { value: el.clientWidth + 4 });
        el.dispatchEvent(event);
      },
    ],
  ])("releases on user scroll intent: %s", (_name, gesture) => {
    fixture.userScroll(600);
    const { result } = renderStick(baseProps());
    fire(() => {
      gesture(fixture.root);
    });
    expect(result.current.state).toBe("released");
  });

  it("ignores wheel-down, clicks inside the content, and keys typed into a field", () => {
    fixture.userScroll(600);
    const { result } = renderStick(baseProps());

    const input = document.createElement("input");
    fixture.content.appendChild(input);

    fire(() => {
      fixture.root.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
      const click = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(click, "offsetX", { value: 10 });
      fixture.root.dispatchEvent(click);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });

    expect(result.current.state).toBe("pinned");
  });

  it("releases when a non-hook scroll leaves the pin window, and re-pins on the way back", () => {
    const { result } = renderStick(baseProps());

    fire(() => {
      fixture.userScroll(300);
    });
    expect(result.current.state).toBe("released");

    fire(() => {
      fixture.userScroll(590);
    });
    expect(result.current.state).toBe("pinned");
  });

  it("honours pinThresholdPx", () => {
    const { result } = renderStick(baseProps({ pinThresholdPx: 100 }));

    fire(() => {
      fixture.userScroll(520);
    });
    expect(result.current.state).toBe("pinned");

    fire(() => {
      fixture.userScroll(400);
    });
    expect(result.current.state).toBe("released");
  });

  it("treats its own compensating scroll as its own, and only that one", () => {
    const { result } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(600);
    });

    // The compensation writes scrollTop and the browser then reports a scroll
    // event for it; the marker is what keeps the machine pinned across it.
    fixture.setScrollHeight(1300);
    fire(() => {
      resize.trigger();
      fixture.root.dispatchEvent(new Event("scroll"));
    });
    expect(fixture.root.scrollTop).toBe(900);
    expect(result.current.state).toBe("pinned");

    // A real scroll after that still counts as the user.
    fire(() => {
      fixture.userScroll(500);
    });
    expect(result.current.state).toBe("released");
  });

  it("keeps element mode pinned across its own compensation too", () => {
    fixture.setScrollHeight(2000);
    const row = fixture.addRow({ id: "comment-42", offset: 700, height: 100 });
    const { result } = renderStick(baseProps({ mode: { kind: "element", id: "comment-42" } }));
    expect(result.current.state).toBe("pinned");

    // The row moves 200px down, so the hook scrolls 200px to hold its offset —
    // inside the callback, before the frame paints.
    const moved = { offset: 900 };
    row.getBoundingClientRect = () => {
      const top = moved.offset - fixture.root.scrollTop;
      return { ...fixture.root.getBoundingClientRect(), top, bottom: top + 100, height: 100, y: top } as DOMRect;
    };
    scrollTopInCallback.length = 0;

    fire(() => {
      resize.trigger();
      fixture.root.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTopInCallback).toEqual([200]);
    expect(fixture.root.scrollTop).toBe(200);
    expect(result.current.state).toBe("pinned");
  });

  it("releases in element mode when the user scrolls away from the row", () => {
    fixture.setScrollHeight(2000);
    fixture.addRow({ id: "comment-42", offset: 700, height: 100 });
    const { result } = renderStick(baseProps({ mode: { kind: "element", id: "comment-42" } }));
    expect(result.current.state).toBe("pinned");

    fire(() => {
      fixture.userScroll(400);
    });
    expect(result.current.state).toBe("released");
  });

  it("mounts released without compensating, as a deep link does", () => {
    fixture.addRow({ id: "comment-42", offset: 700, height: 100 });
    const { result } = renderStick(
      baseProps({ mode: { kind: "element", id: "comment-42" }, initialState: "released" }),
    );
    expect(result.current.state).toBe("released");

    fixture.setScrollHeight(1300);
    fire(() => {
      resize.trigger();
    });
    expect(fixture.root.scrollTop).toBe(0);
    expect(result.current.state).toBe("released");
  });

  it("reports every transition through onStateChange", () => {
    const onStateChange = vi.fn();
    const { result } = renderStick(baseProps({ onStateChange }));
    fire(() => {});
    expect(onStateChange).not.toHaveBeenCalled();

    fire(() => {
      fixture.userScroll(300);
    });
    expect(onStateChange).toHaveBeenLastCalledWith("released");

    fire(() => {
      fixture.userScroll(600);
    });
    expect(onStateChange).toHaveBeenLastCalledWith("pinned");

    vi.useFakeTimers();
    act(() => {
      result.current.returnToBottom();
    });
    expect(onStateChange).toHaveBeenLastCalledWith("returning");

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onStateChange).toHaveBeenLastCalledWith("pinned");
    expect(onStateChange).toHaveBeenCalledTimes(4);
  });

  it("walks released → returning → pinned through returnToBottom", () => {
    const { result } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(200);
    });
    expect(result.current.state).toBe("released");

    vi.useFakeTimers();
    const scrollTo = vi.fn();
    Object.defineProperty(fixture.root, "scrollTo", { configurable: true, value: scrollTo });
    act(() => {
      result.current.returnToBottom();
    });
    expect(result.current.state).toBe("returning");
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });

    // The smooth scroll glides back; the state only decides once it goes quiet.
    act(() => {
      fixture.userScroll(600);
      vi.advanceTimersByTime(99);
    });
    expect(result.current.state).toBe("returning");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("pinned");
  });

  it("returns to released when the glide never reaches the bottom", () => {
    const { result } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(200);
    });

    vi.useFakeTimers();
    Object.defineProperty(fixture.root, "scrollTo", { configurable: true, value: vi.fn() });
    act(() => {
      result.current.returnToBottom();
    });
    expect(result.current.state).toBe("returning");

    // The user grabbed the scrollbar and stopped the glide halfway.
    act(() => {
      fixture.userScroll(100);
      vi.advanceTimersByTime(150);
    });
    expect(result.current.state).toBe("released");
  });

  it("scrolls instantly under prefers-reduced-motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const { result } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(200);
    });

    vi.useFakeTimers();
    const scrollTo = vi.fn();
    Object.defineProperty(fixture.root, "scrollTo", { configurable: true, value: scrollTo });
    act(() => {
      result.current.returnToBottom();
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(fixture.root.scrollTop).toBe(600);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.state).toBe("pinned");
  });

  it("takes a consumer's pin() as its at-the-bottom signal", () => {
    const row = fixture.addRow({ id: "comment-42", offset: 700, height: 100 });
    const { result } = renderStick(
      baseProps({ mode: { kind: "element", id: "comment-42" }, initialState: "released" }),
    );
    expect(result.current.state).toBe("released");

    act(() => {
      result.current.pin();
    });
    expect(result.current.state).toBe("pinned");

    // Pinned element mode holds the row's offset across the next resize.
    const original = row.getBoundingClientRect.bind(row);
    row.getBoundingClientRect = () => {
      const rect = original();
      return { ...rect, top: rect.top + 200, bottom: rect.bottom + 200, y: rect.top + 200 } as DOMRect;
    };
    fire(() => {
      resize.trigger();
    });
    expect(fixture.root.scrollTop).toBe(200);
  });

  it("observes nothing and compensates nothing while disabled", () => {
    const { result, rerender } = renderStick(baseProps({ enabled: false }));
    expect(result.current.state).toBe("pinned");
    expect(resize.countFor(fixture.content)).toBe(0);

    fixture.setScrollHeight(1300);
    fire(() => {
      resize.trigger();
      wheelUp();
    });
    expect(fixture.root.scrollTop).toBe(0);
    expect(result.current.state).toBe("pinned");

    // Enabling starts observing; the baseline it pins is the position the page
    // is at when it is enabled, so the next growth keeps that distance.
    rerender(baseProps({ enabled: true }));
    expect(resize.countFor(fixture.content)).toBe(1);
    fixture.setScrollHeight(1500);
    fire(() => {
      resize.trigger();
    });
    expect(fixture.root.scrollTop).toBe(200);
  });

  it("applies initialState again on each activation, and only then", () => {
    const { result, rerender } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(100);
    });
    expect(result.current.state).toBe("released");

    rerender(baseProps({ enabled: false }));
    rerender(baseProps({ enabled: true, initialState: "released" }));
    expect(result.current.state).toBe("released");

    rerender(baseProps({ enabled: false }));
    rerender(baseProps({ enabled: true, initialState: "pinned" }));
    expect(result.current.state).toBe("pinned");

    // A reader who scrolled away stays released while `enabled` does not move.
    fire(() => {
      fixture.userScroll(100);
    });
    expect(result.current.state).toBe("released");
    rerender(baseProps({ enabled: true, initialState: "pinned" }));
    expect(result.current.state).toBe("released");
  });

  it("stops observing and clears its timer on unmount", () => {
    const { result, unmount } = renderStick(baseProps());
    fire(() => {
      fixture.userScroll(200);
    });

    vi.useFakeTimers();
    Object.defineProperty(fixture.root, "scrollTo", { configurable: true, value: vi.fn() });
    act(() => {
      result.current.returnToBottom();
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(resize.observed).not.toContain(fixture.content);
  });
});
