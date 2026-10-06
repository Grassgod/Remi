import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

it.each([[false, false], [true, false], [false, true], [true, true]])(
  "positions final SSR rows after preferences and restored sidebar width (deep link: %s, sidebar: %s)", async (deepLink, sidebar) => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "layout.tsx"), "utf8");
  const script = source.match(/__html: `([\s\S]*?)` }}/)?.[1];
  expect(script).toBeTruthy();
  const root = document.createElement("div");
  root.dataset.sessionLogScroll = "";
  root.dataset.ssrInitial = "";
  root.dataset.ssrExpected = "1";
  root.dataset.ssrDisplayReady = "0";
  if (deepLink) root.dataset.ssrAnchorId = "comment-system-target";
  root.innerHTML = '<div style="visibility:hidden"><div data-perf-item="message">comment</div></div>';
  const wrapper = document.createElement("div");
  if (sidebar) { wrapper.dataset.slot = "sidebar-wrapper"; wrapper.dataset.sidebarWidthReady = "0"; }
  const gap = document.createElement("div");
  let gapWidth = 256;
  if (sidebar) {
    const panel = document.createElement("div");
    panel.dataset.slot = "sidebar"; panel.dataset.state = "expanded";
    gap.dataset.slot = "sidebar-gap";
    // The real desktop spacer is empty: zero height, but it still owns width.
    gap.getBoundingClientRect = () => ({ width: gapWidth, height: 0 } as DOMRect);
    gap.getClientRects = () => [gap.getBoundingClientRect()] as unknown as DOMRectList;
    panel.append(gap); wrapper.append(panel);
  }
  wrapper.append(root);
  document.body.append(wrapper);
  let finalHeight = 1000;
  let contentWidth = 632;
  Object.defineProperties(root, {
    clientHeight: { value: 400 },
    clientWidth: { get: () => contentWidth },
    scrollHeight: { get: () => finalHeight },
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const observers: MutationObserver[] = [];
  const originalObserve = MutationObserver.prototype.observe;
  const observe = vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (this: MutationObserver, target, options) {
    observers.push(this);
    originalObserve.call(this, target, options);
  });
  try {
    new Function(script!)();
    await Promise.resolve();
    expect(root.dataset.ssrPositioning).toBeUndefined();
    expect(root.firstElementChild?.getAttribute("style")).toContain("visibility:hidden");
    root.firstElementChild!.insertAdjacentHTML("beforeend", '<div id="comment-system-target" data-perf-item="message">system detail</div>');
    const target = root.querySelector<HTMLElement>("#comment-system-target")!;
    Object.defineProperty(target, "offsetHeight", { value: 32 });
    target.getBoundingClientRect = () => ({ top: 680 - root.scrollTop, height: 32 } as DOMRect);
    root.dataset.ssrExpected = "2";
    await Promise.resolve();
    expect(root.dataset.ssrPositioning).toBeUndefined();
    root.dataset.ssrDisplayReady = "1";
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    if (sidebar) {
      expect(frames).toHaveLength(0);
      expect(root.dataset.ssrPositioning).toBeUndefined();
      expect((root.firstElementChild as HTMLElement).style.visibility).toBe("hidden");
      // Restoring the narrower content width changes the row heights. The very
      // first visible position must use that final layout, not the SSR default.
      finalHeight = 1864;
      wrapper.style.setProperty("--sidebar-width", "360px");
      wrapper.dataset.sidebarWidthReady = "1";
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      expect(frames).toHaveLength(1);
      frames.shift()!(0);
      expect(root.dataset.ssrPositioned).toBeUndefined();
      expect((root.firstElementChild as HTMLElement).style.visibility).toBe("hidden");
      // A persisted width is animated by the existing CSS; restoring the state
      // alone does not mean the actual content width has reached that value.
      gapWidth = 360;
      frames.shift()!(16);
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    }
    expect(frames).toHaveLength(1);
    frames.shift()!(32);
    expect(root.dataset.ssrPositioned).toBeUndefined();
    if (sidebar) {
      // Panel resize observers finish after the outer sidebar animation. A
      // stable gap alone cannot reveal a log whose own width is still moving.
      contentWidth = 528;
      finalHeight += 91;
      frames.shift()!(48);
      expect(root.dataset.ssrPositioned).toBeUndefined();
    }
    frames.shift()!(64);
    expect(root.dataset.ssrPositioned).toBe("1");
    expect(root.dataset.perfState).toBe("ready");
    expect((root.firstElementChild as HTMLElement).style.visibility).toBe("");
    expect(root.scrollTop).toBe(deepLink ? 496 : finalHeight);
  } finally {
    observers.forEach(observer => observer.disconnect());
    observe.mockRestore();
    vi.unstubAllGlobals();
    wrapper.remove();
  }
});
