import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemorySessionReplica, rowHeightKey } from "@multiremi/core/replica";
import type { SessionLogEntry } from "@multiremi/core/replica";
import {
  createScrollFixture,
  installManualRaf,
  type ManualRaf,
  type ScrollFixture,
} from "../../test/scroll-fixture";
import {
  reservedRowHeight,
  rowIntersectsViewport,
  useRowHeights,
  type MeasurableRow,
} from "./use-row-heights";

const SESSION = "ises_1";

function entry(seq: number, overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    session_id: SESSION,
    seq,
    id: `cmt_${seq}`,
    revision: 1,
    kind: "message",
    body_html: `<p>${seq}</p>`,
    render_version: "md-abc",
    body_md: `body ${seq}`,
    ...overrides,
  };
}

/** A resize observer a test triggers by hand, so measurement is an assertion. */
function installResizeObserver() {
  const instances: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  const original = globalThis.ResizeObserver;
  class Observer implements ResizeObserver {
    private readonly state = { callback: null as unknown as ResizeObserverCallback, targets: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) {
      this.state.callback = callback;
      instances.push(this.state);
    }
    observe(target: Element): void {
      this.state.targets.add(target);
    }
    unobserve(target: Element): void {
      this.state.targets.delete(target);
    }
    disconnect(): void {
      this.state.targets.clear();
    }
  }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  return {
    observed: () => instances.flatMap((state) => [...state.targets]),
    /** Deliver a resize for every currently observed target. */
    trigger: (): void => {
      for (const state of instances) {
        for (const target of state.targets) {
          state.callback(
            [{ target, contentRect: target.getBoundingClientRect() } as unknown as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }
      }
    },
    restore: (): void => {
      globalThis.ResizeObserver = original;
    },
  };
}

describe("rowIntersectsViewport", () => {
  const viewport = { top: 0, bottom: 400 } as DOMRect;
  it("is true for a row overlapping the box, including a partially visible one", () => {
    expect(rowIntersectsViewport({ top: -50, bottom: 10 } as DOMRect, viewport)).toBe(true);
    expect(rowIntersectsViewport({ top: 399, bottom: 500 } as DOMRect, viewport)).toBe(true);
  });
  it("is false for a row entirely outside", () => {
    expect(rowIntersectsViewport({ top: 401, bottom: 500 } as DOMRect, viewport)).toBe(false);
    expect(rowIntersectsViewport({ top: -100, bottom: 0 } as DOMRect, viewport)).toBe(false);
  });
});

describe("reservedRowHeight", () => {
  it("returns the cached height for the row's own variant and width bucket", () => {
    const replica = new MemorySessionReplica();
    replica.writeRowHeight(SESSION, 3, rowHeightKey({ revision: 2, renderVersion: "md-x", widthPx: 800 }), 120);
    expect(reservedRowHeight(replica, SESSION, entry(3, { revision: 2, render_version: "md-x" }), 800)).toBe(120);
  });

  it("is a miss after an edit, a re-render or a width change", () => {
    const replica = new MemorySessionReplica();
    replica.writeRowHeight(SESSION, 3, rowHeightKey({ revision: 2, renderVersion: "md-x", widthPx: 800 }), 120);
    const base = entry(3, { revision: 2, render_version: "md-x" });
    expect(reservedRowHeight(replica, SESSION, { ...base, revision: 3 }, 800)).toBeNull();
    expect(reservedRowHeight(replica, SESSION, { ...base, render_version: "md-y" }, 800)).toBeNull();
    // Anything below 800 floors into a lower bucket and must not inherit a
    // height measured at 800: 792 is its own bucket, and 799 floors to 792.
    expect(reservedRowHeight(replica, SESSION, base, 792)).toBeNull();
    expect(reservedRowHeight(replica, SESSION, base, 799)).toBeNull();
    // 800 through 807 are the same bucket, so they do hit — a single pixel of
    // layout noise must not throw the cache away.
    expect(reservedRowHeight(replica, SESSION, base, 800)).toBe(120);
    expect(reservedRowHeight(replica, SESSION, base, 807)).toBe(120);
  });

  it("treats a zero or missing entry as no reservation", () => {
    const replica = new MemorySessionReplica();
    replica.writeRowHeight(SESSION, 3, rowHeightKey({ revision: 2, renderVersion: "md-x", widthPx: 800 }), 0);
    expect(reservedRowHeight(replica, SESSION, entry(3, { revision: 2, render_version: "md-x" }), 800)).toBeNull();
  });
});

describe("useRowHeights", () => {
  let fixture: ScrollFixture;
  let observer: ReturnType<typeof installResizeObserver>;
  let raf: ManualRaf;

  beforeEach(() => {
    fixture = createScrollFixture({ scrollHeight: 2000, clientHeight: 400 });
    observer = installResizeObserver();
    raf = installManualRaf();
  });

  afterEach(() => {
    observer.restore();
    raf.restore();
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  /** Run the frames a scroll schedules. */
  const runFrames = (): void => {
    act(() => {
      raf.runFrame();
    });
  };

  /** Rows whose rects follow the scroll position, the way a laid-out list would. */
  function buildRows(count: number): { rows: MeasurableRow[]; nodes: HTMLElement[] } {
    const nodes: HTMLElement[] = [];
    const rows: MeasurableRow[] = [];
    for (let index = 0; index < count; index += 1) {
      const node = fixture.addRow({ id: `row-${index}`, offset: index * 100, height: 100 });
      node.getBoundingClientRect = () => {
        const top = index * 100 - fixture.root.scrollTop;
        return { top, bottom: top + 100, height: 100, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
      nodes.push(node);
      rows.push({ element: node, revision: 1, renderVersion: "md-abc", seq: index + 1 });
    }
    return { rows, nodes };
  }

  it("observes only rows inside the viewport, and measures them on the spot", () => {
    const replica = new MemorySessionReplica();
    const { rows } = buildRows(20);
    renderHook(() => useRowHeights({
      replica,
      sessionId: SESSION,
      scrollEl: fixture.root,
      widthPx: 800,
      getRows: () => rows,
      version: 1,
      enabled: true,
    }));

    // Four 100px rows fit in a 400px box; the other sixteen must not be watched.
    expect(observer.observed()).toHaveLength(4);
    const key = rowHeightKey({ revision: 1, renderVersion: "md-abc", widthPx: 800 });
    expect(replica.readRowHeight(SESSION, 1, key)).toBe(100);
    expect(replica.readRowHeight(SESSION, 6, key)).toBeNull();
  });

  it("re-scans on scroll and drops the rows that left the viewport", () => {
    const replica = new MemorySessionReplica();
    const { rows } = buildRows(20);
    renderHook(() => useRowHeights({
      replica,
      sessionId: SESSION,
      scrollEl: fixture.root,
      widthPx: 800,
      getRows: () => rows,
      version: 1,
      enabled: true,
    }));

    fixture.userScroll(900);
    runFrames();
    const observed = observer.observed();
    expect(observed).toContain(rows[9]!.element);
    expect(observed).not.toContain(rows[0]!.element);
  });

  it("does nothing until the reveal has happened", () => {
    const replica = new MemorySessionReplica();
    const { rows } = buildRows(5);
    renderHook(() => useRowHeights({
      replica,
      sessionId: SESSION,
      scrollEl: fixture.root,
      widthPx: 800,
      getRows: () => rows,
      version: 1,
      enabled: false,
    }));

    expect(observer.observed()).toHaveLength(0);
    expect(replica.readRowHeight(SESSION, 1, rowHeightKey({ revision: 1, renderVersion: "md-abc", widthPx: 800 }))).toBeNull();
  });

  it("writes the measured height on a resize, under the current width bucket", () => {
    const replica = new MemorySessionReplica();
    const { rows } = buildRows(1);
    renderHook(() => useRowHeights({
      replica,
      sessionId: SESSION,
      scrollEl: fixture.root,
      widthPx: 400,
      getRows: () => rows,
      version: 1,
      enabled: true,
    }));

    rows[0]!.element.getBoundingClientRect = () => ({ top: 0, bottom: 250, height: 250, left: 0, right: 400, width: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    act(() => { observer.trigger(); });
    expect(replica.readRowHeight(SESSION, 1, rowHeightKey({ revision: 1, renderVersion: "md-abc", widthPx: 400 }))).toBe(250);
  });
});
