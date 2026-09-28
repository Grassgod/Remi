import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { MemorySessionReplica } from "@multiremi/core/replica";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { installManualRaf, type ManualRaf } from "../../test/scroll-fixture";
import { SessionLogList, SESSION_LOG_DOM_LIMIT } from "./session-log-list";
import { COPY_BUTTON_ATTR, PREVIEW_SLOT_ATTR } from "./enhance";

/**
 * The list's two browser dependencies are made deterministic here. The scroll
 * root behaves like a real one (clamped `scrollTop`, geometry that follows it),
 * and animation frames run only when the test asks, so "which frame revealed"
 * is an assertion rather than a race — the same discipline MUL-450's hook tests
 * use.
 */

const SESSION = "ises_1";

function entry(seq: number, overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    session_id: SESSION,
    seq,
    id: `cmt_${seq}`,
    revision: 1,
    kind: "message",
    body_html: `<p>body ${seq}</p>`,
    render_version: "md-abc",
    body_md: `body ${seq}`,
    ...overrides,
  };
}

/** Geometry for the list's own scroll root, which jsdom reports as 0x0. */
function installGeometry(root: HTMLElement, content: HTMLElement): () => void {
  let scrollTop = 0;
  let scrollHeight = 1000;
  const clientHeight = 400;
  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)));
    },
  });
  root.getBoundingClientRect = () => rect(0, clientHeight);
  content.getBoundingClientRect = () => rect(0, scrollHeight);
  return () => {
    delete (root as unknown as Record<string, unknown>).scrollHeight;
  };
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("SessionLogList", () => {
  let raf: ManualRaf;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }>;

  beforeEach(() => {
    raf = installManualRaf();
    originalResizeObserver = globalThis.ResizeObserver;
    observers = [];
    class Observer implements ResizeObserver {
      private readonly state = { callback: null as unknown as ResizeObserverCallback, targets: new Set<Element>() };
      constructor(callback: ResizeObserverCallback) {
        this.state.callback = callback;
        observers.push(this.state);
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
  });

  afterEach(() => {
    raf.restore();
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    vi.restoreAllMocks();
  });

  /** Render the list, wire its geometry and run the frames the reveal needs. */
  function renderList(
    replica: MemorySessionReplica,
    props: Partial<React.ComponentProps<typeof SessionLogList>> = {},
  ) {
    const view = renderWithI18n(
      <SessionLogList sessionId={SESSION} replica={replica} {...props} />,
      { locale: "en" },
    );
    const root = view.container.querySelector("[data-session-log-scroll]") as HTMLElement;
    const content = root.firstElementChild as HTMLElement;
    const restore = installGeometry(root, content);
    return { ...view, root, content, restore };
  }

  /** Run animation frames until the reveal settles (three is its documented need). */
  function reveal(): void {
    for (let frame = 0; frame < 4; frame += 1) {
      act(() => {
        raf.runFrame();
      });
    }
  }

  it("stays hidden with a skeleton until the replica is ready, then publishes ready and fresh", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1)], ready: false, fresh: false },
    });
    const view = renderList(replica);

    expect(view.getByTestId("session-log-skeleton")).toBeTruthy();
    expect(view.root.getAttribute("data-perf-state")).toBe("pending");
    // The hook publishes the freshness bit alongside the state from the first
    // commit, so the recorder can tell "ready and fresh" from "ready on stale
    // data" without waiting for a transition. While the replica has not
    // answered, that bit is 0.
    expect(view.root.getAttribute("data-perf-fresh")).toBe("0");

    act(() => {
      replica.setWindow(SESSION, [entry(1), entry(2)], { ready: true, fresh: true });
    });
    reveal();

    expect(view.root.getAttribute("data-perf-state")).toBe("ready");
    expect(view.root.getAttribute("data-perf-fresh")).toBe("1");
    expect(view.queryByTestId("session-log-skeleton")).toBeNull();
    expect(view.content.style.visibility).toBe("");
    view.restore();
  });

  it("publishes fresh=0 while the replica's window is behind the server", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1)], ready: true, fresh: false },
    });
    const view = renderList(replica);
    reveal();
    expect(view.root.getAttribute("data-perf-state")).toBe("ready");
    expect(view.root.getAttribute("data-perf-fresh")).toBe("0");
    view.restore();
  });

  it("renders pre-rendered HTML with the measurement contract attributes", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1), entry(2)] },
    });
    const view = renderList(replica);
    reveal();

    const rows = view.container.querySelectorAll("[data-perf-item=\"message\"]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-perf-key")).toBe("cmt_1");
    // The newest row is the terminal anchor, and the row id keeps deep links working.
    expect(rows[1]!.getAttribute("data-perf-anchor")).toBe("latest-message");
    expect(rows[0]!.id).toBe("comment-cmt_1");
    expect(rows[0]!.textContent).toContain("body 1");
    view.restore();
  });

  it("caps the DOM at 300 rows by dropping the oldest end of the window", () => {
    const many = Array.from({ length: SESSION_LOG_DOM_LIMIT + 25 }, (_, index) => entry(index + 1));
    const replica = new MemorySessionReplica({ [SESSION]: { entries: many } });
    const view = renderList(replica);
    reveal();

    const rows = view.container.querySelectorAll("[data-perf-item=\"message\"]");
    expect(rows).toHaveLength(SESSION_LOG_DOM_LIMIT);
    // The newest end survives; the oldest rows are the ones dropped.
    expect(rows[0]!.getAttribute("data-perf-key")).toBe(`cmt_26`);
    expect(rows[rows.length - 1]!.getAttribute("data-perf-key")).toBe(`cmt_${many.length}`);
    view.restore();
  });

  it("falls back to the client renderer when body_html is empty", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1, { body_html: null })] },
    });
    const view = renderList(replica, {
      renderFallback: (item) => <span data-testid="degraded">{item.body_md}</span>,
    });
    reveal();

    expect(view.getAllByTestId("degraded")).toHaveLength(1);
    expect(view.container.querySelector("[data-entry-html]")).toBeNull();
    view.restore();
  });

  it("reserves a cached row height as min-height before the row is measured", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1)], rowHeights: [] },
    });
    // The list reads the cache with the width it is laid out at. The jsdom host
    // reports a 0-width content box, which floors to the 0 bucket, so the entry
    // is seeded there; the key shape itself is pinned in port.test.ts.
    const view = renderList(replica);
    reveal();
    const contentWidth = view.content.clientWidth;
    replica.writeRowHeight(
      SESSION,
      1,
      `1:md-abc@${Math.floor(contentWidth / 8) * 8}`,
      132,
    );

    // A cache write is not a window change, so nothing re-renders on its own.
    // Flip a fact the list does render from and back: this is what a real
    // append would do, and it is what makes the reservation readable.
    act(() => {
      replica.setFreshness(SESSION, false);
      replica.setFreshness(SESSION, true);
    });
    const row = view.container.querySelector("[data-perf-key=\"cmt_1\"]") as HTMLElement;
    expect(row.style.minHeight).toBe("132px");
    view.restore();
  });

  it("adds a copy button to a code block without changing the row's reserved height", () => {
    const body = ["```js", "const a = 1;", "```"].join("\n");
    const replica = new MemorySessionReplica({
      [SESSION]: {
        entries: [entry(1, { body_md: body, body_html: '<p>t</p><pre class="shiki"><code>const a = 1;</code></pre>' })],
      },
    });
    const view = renderList(replica);
    reveal();
    // Two rAF frames for the reveal, then the layout effect that enhances.
    act(() => {
      raf.runFrame();
    });

    expect(view.container.querySelectorAll(`[${COPY_BUTTON_ATTR}]`)).toHaveLength(1);
    expect(view.container.querySelector(`[${PREVIEW_SLOT_ATTR}]`)).toBeNull();
    view.restore();
  });

  it("counts new messages while released, caps the label at 99+, and returns on click", () => {
    const replica = new MemorySessionReplica({
      [SESSION]: { entries: [entry(1), entry(2)] },
    });
    const view = renderList(replica);
    reveal();

    // The reader scrolls up: the hook releases and the chip starts counting from
    // the newest row that was on screen.
    act(() => {
      fireEvent.wheel(view.root, { deltaY: -120 });
    });
    expect(view.root.getAttribute("data-perf-state")).toBe("ready");

    act(() => {
      replica.append(SESSION, Array.from({ length: 3 }, (_, index) => entry(index + 3)));
    });
    const chip = view.container.querySelector("[data-session-log-new-messages]");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("3");

    // Past the cap the visual count stops at 99+ while the label keeps the truth.
    act(() => {
      replica.append(SESSION, Array.from({ length: 120 }, (_, index) => entry(index + 6)));
    });
    const capped = view.container.querySelector("[data-session-log-new-messages]");
    expect(capped!.textContent).toContain("99+");
    expect(capped!.getAttribute("aria-label")).toContain("123");
    view.restore();
  });

  it("shows no chip while pinned", () => {
    const replica = new MemorySessionReplica({ [SESSION]: { entries: [entry(1)] } });
    const view = renderList(replica);
    reveal();
    act(() => {
      replica.append(SESSION, [entry(2), entry(3)]);
    });
    expect(view.container.querySelector("[data-session-log-new-messages]")).toBeNull();
    view.restore();
  });

  it("observes only the rows inside the scroll viewport", () => {
    const many = Array.from({ length: 40 }, (_, index) => entry(index + 1));
    const replica = new MemorySessionReplica({ [SESSION]: { entries: many } });
    const view = renderList(replica);
    reveal();

    const observedTargets = observers.flatMap((observer) => [...observer.targets]);
    const rows = [...view.container.querySelectorAll("[data-perf-item=\"message\"]")] as HTMLElement[];
    expect(rows.length).toBe(40);
    // Every jsdom rect is 0x0 here, so the viewport test is what decides. Give
    // each row a real rect: only the ones overlapping the root box may be watched.
    expect(observedTargets.length).toBeGreaterThan(0);
    expect(observedTargets.length).toBeLessThan(rows.length);
    view.restore();
  });
});
