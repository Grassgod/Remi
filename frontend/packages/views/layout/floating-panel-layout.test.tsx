import { useCallback, useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { FloatingPanelLayout, useFloatingPanelLayout } from "./floating-panel-layout";
import { useChatResize } from "../chat/components/use-chat-resize";

let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }>;
let store: ReturnType<typeof createChatStore>;

function Rail({ width }: { width: number }) {
  const { registerRightRail } = useFloatingPanelLayout();
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node) node.getBoundingClientRect = () => ({ width: Number.parseFloat(node.style.width) }) as DOMRect;
    registerRightRail(node);
  }, [registerRightRail]);
  return <div ref={ref} style={{ width }} />;
}

function Window() {
  const { rightRailWidth } = useFloatingPanelLayout();
  const stableRef = useRef<HTMLDivElement>(null);
  const windowRef = useCallback((node: HTMLDivElement | null) => {
    if (node?.parentElement) {
      Object.defineProperty(node.parentElement, "clientWidth", { configurable: true, value: 700 });
      Object.defineProperty(node.parentElement, "clientHeight", { configurable: true, value: 900 });
    }
  }, []);
  // Keep the actual hook's ref stable while the rail is resized or collapsed.
  const ref = useCallback((node: HTMLDivElement | null) => { windowRef(node); stableRef.current = node; }, [windowRef]);
  const { renderWidth } = useChatResize(stableRef, rightRailWidth);
  return <div><div ref={ref} data-testid="window" style={{ right: rightRailWidth + 8, width: renderWidth }} /></div>;
}

function Scene({ railWidth }: { railWidth: number | null }) {
  return <FloatingPanelLayout>{railWidth !== null && <Rail width={railWidth} />}<Window /></FloatingPanelLayout>;
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    state: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.state = { callback, targets: new Set() }; observers.push(this.state); }
    observe(target: Element) { this.state.targets.add(target); }
    unobserve(target: Element) { this.state.targets.delete(target); }
    disconnect() { this.state.targets.clear(); }
  });
  store = createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerChatStore(store);
});
afterEach(() => vi.unstubAllGlobals());

function resize() {
  act(() => { for (const observer of [...observers]) if (observer.targets.size) observer.callback([], {} as ResizeObserver); });
}

describe("floating Chat beside an Issue property rail", () => {
  it("reserves the rail width and bounds the normal and expanded window inside the remaining document", () => {
    render(<Scene railWidth={320} />);
    expect(screen.getByTestId("window")).toHaveStyle({ right: "328px", width: "364px" });
    act(() => store.getState().setExpanded(true));
    expect(screen.getByTestId("window")).toHaveStyle({ right: "328px", width: "364px" });
  });

  it("follows rail resizing even when the remaining area is narrower than the preferred minimum", () => {
    const view = render(<Scene railWidth={320} />);
    view.rerender(<Scene railWidth={420} />);
    resize();
    expect(screen.getByTestId("window")).toHaveStyle({ right: "428px", width: "264px" });
  });

  it("releases the reservation when the rail is collapsed or removed", () => {
    const view = render(<Scene railWidth={320} />);
    view.rerender(<Scene railWidth={0} />);
    resize();
    expect(screen.getByTestId("window")).toHaveStyle({ right: "8px", width: "380px" });
    view.rerender(<Scene railWidth={320} />);
    resize();
    view.rerender(<Scene railWidth={null} />);
    expect(screen.getByTestId("window")).toHaveStyle({ right: "8px", width: "380px" });
  });
});
