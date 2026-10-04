import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

it.each([false, true])("positions the final SSR rows only after preferences are ready (deep link: %s)", async deepLink => {
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
  document.body.append(root);
  Object.defineProperties(root, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 1000 },
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
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(root.dataset.ssrPositioned).toBe("1");
    expect(root.dataset.perfState).toBe("ready");
    expect((root.firstElementChild as HTMLElement).style.visibility).toBe("");
    expect(root.scrollTop).toBe(deepLink ? 496 : 1000);
  } finally {
    observers.forEach(observer => observer.disconnect());
    observe.mockRestore();
    vi.unstubAllGlobals();
    root.remove();
  }
});
