import { vi } from "vitest";

/**
 * A scroll root that behaves like the browser's: `scrollTop` is clamped to the
 * content, and element rows report a viewport rect that follows `scrollTop`.
 * jsdom leaves `scrollTop` unbounded and reports every rect as `0x0`, which
 * would let a broken target position look like a working one.
 */
export interface ScrollFixture {
  root: HTMLDivElement;
  content: HTMLDivElement;
  /** Replace the content height, as late content above the anchor would. */
  setScrollHeight(value: number): void;
  setClientHeight(value: number): void;
  setClientWidth(value: number): void;
  /** Set the scroll position directly and fire the event a real scroll would. */
  userScroll(top: number): void;
  /** Append a row whose rect follows `scrollTop`; returns its id. */
  addRow(options: { id: string; offset: number; height: number }): HTMLElement;
  cleanup(): void;
}

export function createScrollFixture(
  options: { scrollHeight?: number; clientHeight?: number; scrollTop?: number } = {},
): ScrollFixture {
  const root = document.createElement("div");
  const content = document.createElement("div");
  root.appendChild(content);
  document.body.appendChild(root);

  let scrollHeight = options.scrollHeight ?? 1000;
  let clientHeight = options.clientHeight ?? 400;
  // The scrollbar lives in the gutter beyond the client box, so the width has to
  // be realistic: `pointerdown` inside the content must not read as a grab.
  let clientWidth = 800;
  let scrollTop = Math.max(0, Math.min(options.scrollTop ?? 0, Math.max(0, scrollHeight - clientHeight)));

  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)));
    },
  });
  root.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: clientHeight,
      height: clientHeight,
      left: 0,
      right: 800,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const fixture: ScrollFixture = {
    root,
    content,
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    setClientHeight: (value) => {
      clientHeight = value;
    },
    setClientWidth: (value) => {
      clientWidth = value;
    },
    userScroll: (value) => {
      root.scrollTop = value;
      root.dispatchEvent(new Event("scroll"));
    },
    addRow: ({ id, offset, height }) => {
      const row = document.createElement("div");
      row.id = id;
      row.getBoundingClientRect = () => {
        // Viewport-relative, i.e. shifted up by the current scroll position.
        const top = offset - root.scrollTop;
        return {
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 800,
          width: 800,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      };
      content.appendChild(row);
      return row;
    },
    cleanup: () => root.remove(),
  };
  return fixture;
}

export interface ManualRaf {
  /** Frames queued but not yet run. */
  pending(): number;
  /** Run every frame queued at the time of the call; frames they queue wait for the next run. */
  runFrame(): void;
  restore(): void;
}

/** `requestAnimationFrame` as a queue the test pops one frame at a time. */
export function installManualRaf(): ManualRaf {
  let queue: Array<{ id: number; callback: FrameRequestCallback }> = [];
  let nextId = 1;
  const raf = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback): number => {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback });
      return id;
    });
  const cancel = vi
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((id: number): void => {
      queue = queue.filter((entry) => entry.id !== id);
    });
  return {
    pending: () => queue.length,
    runFrame: () => {
      const frame = queue;
      queue = [];
      for (const entry of frame) entry.callback(0);
    },
    restore: () => {
      raf.mockRestore();
      cancel.mockRestore();
    },
  };
}

export interface FakeResizeObserver {
  /** Call each observer for its most recent target, as a resize would. */
  trigger(): void;
  /** Observers currently observing the given element. */
  countFor(element: Element): number;
  /** Elements the observers are watching. */
  observed: Element[];
  restore(): void;
}

/** `ResizeObserver` with an explicit `trigger()`, so compensation is asserted, not raced. */
export function installFakeResizeObserver(): FakeResizeObserver {
  const instances: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  class Observer implements ResizeObserver {
    private readonly state: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
      this.state = { callback, targets: [] };
      instances.push(this.state);
    }
    observe(target: Element): void {
      this.state.targets.push(target);
    }
    unobserve(target: Element): void {
      this.state.targets = this.state.targets.filter((candidate) => candidate !== target);
    }
    disconnect(): void {
      this.state.targets = [];
    }
  }
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;

  return {
    trigger: () => {
      for (const instance of instances) {
        for (const target of instance.targets) {
          instance.callback(
            [{ target, contentRect: target.getBoundingClientRect() } as unknown as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }
      }
    },
    countFor: (element) => instances.filter((instance) => instance.targets.includes(element)).length,
    get observed() {
      return instances.flatMap((instance) => instance.targets);
    },
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
}
