import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createChatStore, registerChatStore, useChatStore, type SubagentPanelTarget } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { traceTurn, turnPage, turnTraceCache } from "../../test/trace-fixtures";
import { claudeLiveItems } from "../lib/__fixtures__/subagents";
import { SubagentPanelLayout } from "./subagent-panel";

// How the side panel opens and closes (one progress value; the split's width,
// the overlay's translateX), its resizable width and where focus goes. Real
// timers: motion's frame loop runs on requestAnimationFrame, and a frame left
// pending when fake timers are swapped out stalls it for the rest of a file.

const { mobile, motionPrefs } = vi.hoisted(() => ({ mobile: { value: false }, motionPrefs: { reduce: false } }));
vi.mock("@multiremi/core/api", async (original) => ({
  ...await original<typeof import("@multiremi/core/api")>(),
  api: { getTaskTrace: vi.fn(() => new Promise(() => {})) },
}));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("motion/react", async (original) => ({
  ...await original<typeof import("motion/react")>(),
  useReducedMotion: () => motionPrefs.reduce,
}));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

// jsdom has no PointerEvent: fireEvent.pointer* would send a plain Event without button or coordinates.
if (typeof window.PointerEvent !== "function") {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

let client: QueryClient;

function open(target: Partial<SubagentPanelTarget> = {}) {
  act(() => {
    useChatStore.getState().openSubagentPanel({ sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true, path: [], ...target });
  });
}

const close = () => act(() => { useChatStore.getState().closeSubagentPanel(); });

function renderLayout({ presentation = "page" as "page" | "window" } = {}) {
  return renderWithI18n(
    <QueryClientProvider client={client}>
      {/* What opens the panel from outside it, and the header toggle focus falls back to. */}
      <button type="button" data-testid="opener">open</button>
      <button type="button" data-side-panel-toggle={`chat-side-panel-${presentation}`}>toggle</button>
      <SubagentPanelLayout sessionId="chat_1" presentation={presentation}>
        <div data-testid="chat-conversation">conversation</div>
      </SubagentPanelLayout>
    </QueryClientProvider>,
    { locale: "zh-Hans" },
  );
}

const SPLIT_RECT = { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
const panel = () => document.querySelector<HTMLElement>("[data-subagent-panel]");
const drawer = () => document.querySelector<HTMLElement>("[data-subagent-panel-drawer]");
const splitPane = () => document.querySelector<HTMLElement>('[data-subagent-panel-mode="split"]');
const overlayPane = () => document.querySelector<HTMLElement>('[data-subagent-panel-mode="overlay"]');
const px = (value: string | undefined) => Number.parseFloat(value ?? "");
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** Every value an element's inline style property takes, frame by frame. */
function recordStyle(element: HTMLElement, property: "width" | "transform") {
  const seen: string[] = [element.style[property]];
  const observer = new MutationObserver(() => {
    const value = element.style[property];
    if (seen.at(-1) !== value) seen.push(value);
  });
  observer.observe(element, { attributes: true, attributeFilter: ["style"] });
  return { seen, stop: () => observer.disconnect() };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status: "running" }), claudeLiveItems())));
  close();
  mobile.value = false;
  motionPrefs.reduce = false;
  localStorage.removeItem("chat-subagent-panel-width");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("side panel motion", () => {
  it("grows the split from 0 to its width on one progress value and unmounts only once closing reaches 0", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(SPLIT_RECT);
    renderLayout();
    open();
    // Mounted before it opens, at width 0; the panel inside has its final width from the first frame.
    expect(px(drawer()!.style.width)).toBe(0);
    expect(splitPane()!.style.width).toBe("400px");
    expect(splitPane()!.style.minWidth).toBe("400px");
    const opening = recordStyle(drawer()!, "width");
    await waitFor(() => expect(px(drawer()!.style.width)).toBe(400), { timeout: 2000 });
    opening.stop();
    const steps = opening.seen.map(px);
    expect(steps.some((width) => width > 0 && width < 400)).toBe(true);
    // The spring's overshoot is clamped: the drawer never grows past its width.
    expect(Math.max(...steps)).toBe(400);
    expect(splitPane()).not.toHaveAttribute("inert");

    close();
    // Closing: still mounted, inert, showing what it showed, its width shrinking.
    expect(panel()).toHaveAttribute("data-subagent-panel", "overview");
    expect(splitPane()).toHaveAttribute("inert");
    expect(screen.queryByRole("separator")).toBeNull();
    await waitFor(() => expect(px(drawer()!.style.width)).toBeLessThan(380));
    const closing = px(drawer()!.style.width);
    expect(closing).toBeGreaterThan(0);
    // Reopened mid-way: it turns back from where it is instead of starting from 0.
    open();
    expect(splitPane()).not.toHaveAttribute("inert");
    const reopening = recordStyle(drawer()!, "width");
    await waitFor(() => expect(px(drawer()!.style.width)).toBe(400), { timeout: 2000 });
    reopening.stop();
    expect(Math.min(...reopening.seen.map(px))).toBeGreaterThan(closing / 2);

    close();
    await sleep(50);
    expect(drawer()).not.toBeNull();
    await waitFor(() => expect(drawer()).toBeNull(), { timeout: 2000 });
    expect(panel()).toBeNull();
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
  });

  it("slides over the floating window in 200ms and back out before unmounting", async () => {
    renderLayout({ presentation: "window" });
    open();
    expect(overlayPane()!.style.transform).toContain("translateX(100%)");
    const started = performance.now();
    await waitFor(() => expect(overlayPane()!.style.transform).toMatch(/^(none|translateX\(0%\))$/), { timeout: 2000 });
    expect(performance.now() - started).toBeLessThan(1000);
    close();
    expect(overlayPane()).toHaveAttribute("inert");
    await sleep(20);
    expect(overlayPane()).not.toBeNull();
    await waitFor(() => expect(overlayPane()).toBeNull(), { timeout: 2000 });
  });

  it("snaps open and closed under reduced motion", async () => {
    motionPrefs.reduce = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(SPLIT_RECT);
    renderLayout();
    open();
    await waitFor(() => expect(drawer()!.style.width).toBe("400px"));
    close();
    expect(drawer()).toBeNull();
    expect(panel()).toBeNull();
  });

  it("resizes from its edge between 320px and what leaves the conversation 352px, and remembers the width", async () => {
    motionPrefs.reduce = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(SPLIT_RECT);
    const view = renderLayout();
    open();
    const separator = screen.getByRole("separator", { name: "调整子代理面板大小" });
    expect(separator).toHaveAttribute("aria-valuenow", "400");
    expect(separator).toHaveAttribute("aria-valuemin", "320");
    // 1200px leaves room for the 560px cap.
    expect(separator).toHaveAttribute("aria-valuemax", "560");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    await waitFor(() => expect(splitPane()!.style.width).toBe("416px"));
    expect(separator).toHaveAttribute("aria-valuenow", "416");
    expect(localStorage.getItem("chat-subagent-panel-width")).toBe("416");
    fireEvent.keyDown(separator, { key: "End" });
    await waitFor(() => expect(splitPane()!.style.width).toBe("320px"));
    // Dragging left widens it, up to the cap; release remembers it.
    fireEvent.pointerDown(separator, { button: 0, clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 1 });
    await waitFor(() => expect(splitPane()!.style.width).toBe("420px"));
    fireEvent.pointerMove(separator, { clientX: 100, pointerId: 1 });
    await waitFor(() => expect(splitPane()!.style.width).toBe("560px"));
    expect(drawer()!.style.width).toBe("560px");
    expect(localStorage.getItem("chat-subagent-panel-width")).toBe("320");
    fireEvent.pointerUp(separator, { clientX: 100, pointerId: 1 });
    expect(localStorage.getItem("chat-subagent-panel-width")).toBe("560");
    // A new page opens it at the remembered width; double-click restores 400px.
    view.unmount();
    renderLayout();
    open();
    await waitFor(() => expect(splitPane()!.style.width).toBe("560px"));
    fireEvent.doubleClick(screen.getByRole("separator"));
    await waitFor(() => expect(splitPane()!.style.width).toBe("400px"));
    expect(localStorage.getItem("chat-subagent-panel-width")).toBe("400");
  });

  it("covers the conversation when the page leaves no 352px beside a 320px panel", () => {
    motionPrefs.reduce = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ ...SPLIT_RECT, width: 671, right: 671 } as DOMRect);
    renderLayout();
    open();
    expect(overlayPane()).not.toBeNull();
    expect(drawer()).toBeNull();
  });

  it("gives focus back to what opened it when it closes from inside, else to the header toggle", () => {
    motionPrefs.reduce = true;
    renderLayout();
    const opener = screen.getByTestId("opener");
    const toggle = screen.getByRole("button", { name: "toggle" });
    opener.focus();
    open();
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(panel()!, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    opener.focus();
    open();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(document.activeElement).toBe(opener);
    // An opener that left the page (a row scrolled out of a virtual list): the header toggle.
    const row = document.createElement("button");
    document.body.append(row);
    row.focus();
    open();
    row.remove();
    fireEvent.keyDown(panel()!, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
    // A close while focus is elsewhere leaves it there.
    open();
    opener.focus();
    close();
    expect(document.activeElement).toBe(opener);
  });
});
