"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export type RevealAnchor =
  | { kind: "bottom" }
  | { kind: "element"; id: string; align?: "center" | "start" };

export type RevealState = "pending" | "ready" | "ready-forced";

export interface UseAnchoredRevealOptions {
  /** Scroll root, i.e. `[data-tab-scroll-root]`; both `data-perf` attributes live here. */
  scrollEl: HTMLElement | null;
  /** The hidden-and-measured content wrapper: the scroll root's direct child. */
  contentEl: HTMLElement | null;
  /**
   * Any change hides the content again and restarts the state machine. The issue
   * detail passes `${wsId}:${issueId}:${sessionId}:${anchorKey}`.
   */
  resetKey: string;
  /** Gate (i), computed by the consumer: this hook knows nothing about queries. */
  dataReady: boolean;
  anchor: RevealAnchor;
  /**
   * Gate (ii). Defaults to true (flat lists); a Virtuoso consumer flips it from
   * its own callbacks.
   */
  layoutSettled?: boolean;
  /** Writes `data-perf-fresh="1"|"0"`; `undefined` removes the attribute. */
  fresh?: boolean;
  /** Budget (gate v), default 800 ms. */
  budgetMs?: number;
  /** Gate (iv) ceiling, default 600 ms. */
  imageWaitMs?: number;
  /**
   * Defaults to true. `false` is a pass-through for local diagnosis: nothing is
   * hidden, no attribute is written, and `state` reports `ready` so the consumer
   * renders its content instead of a skeleton.
   */
  enabled?: boolean;
  /** The SSR list has been positioned by its inline pre-paint script. */
  initialPositioned?: boolean;
}

export interface UseAnchoredRevealResult {
  state: RevealState;
  /** `state !== "pending"`; the consumer stops rendering its skeleton on this. */
  revealed: boolean;
}

const DEFAULT_BUDGET_MS = 800;
const DEFAULT_IMAGE_WAIT_MS = 600;

function anchorElement(scrollEl: HTMLElement, anchor: RevealAnchor): HTMLElement | null {
  if (anchor.kind === "bottom") return null;
  const el = scrollEl.ownerDocument.getElementById(anchor.id);
  return el && scrollEl.contains(el) ? el : null;
}

/** Images inside the scroll root's viewport that have not loaded yet. */
function pendingImages(scrollEl: HTMLElement): HTMLImageElement[] {
  const rootRect = scrollEl.getBoundingClientRect();
  const waiting: HTMLImageElement[] = [];
  for (const image of scrollEl.querySelectorAll("img")) {
    if (image.complete) continue;
    // A sized image already owns its layout slot; decoding cannot move the anchor.
    const style = scrollEl.ownerDocument.defaultView?.getComputedStyle(image);
    const hasDimensions = (image.width > 0 && image.height > 0)
      || (image.naturalWidth > 0 && image.naturalHeight > 0)
      || (style?.aspectRatio && style.aspectRatio !== "auto");
    if (hasDimensions) continue;
    const rect = image.getBoundingClientRect();
    if (rect.bottom > rootRect.top && rect.top < rootRect.bottom) waiting.push(image);
  }
  return waiting;
}

/**
 * Scroll top that puts the anchor at its final position: the bottom of the
 * content for `bottom`; the target row centred otherwise, except that a row
 * taller than the viewport is aligned to its top edge.
 */
function targetScrollTop(scrollEl: HTMLElement, anchor: RevealAnchor): number {
  if (anchor.kind === "bottom") return Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  const target = anchorElement(scrollEl, anchor);
  if (!target) return scrollEl.scrollTop;
  const rect = target.getBoundingClientRect();
  const offset = rect.top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  // A row taller than the viewport can only show its top edge, which is also the
  // strongest reachable position for the recorder's anchor check.
  const desired =
    anchor.align === "start" || rect.height > scrollEl.clientHeight
      ? offset
      : offset - (scrollEl.clientHeight - rect.height) / 2;
  return Math.max(0, desired);
}

/**
 * Holds `contentEl` hidden until the page can be painted once, at its final
 * position, then reports that it is ready (MUL-383 S2a; consumed by MUL-390 and
 * MUL-443).
 *
 * The consumer renders a skeleton while `state === "pending"`; this hook renders
 * nothing. It is the only writer of `data-perf-state` and `data-perf-fresh` on
 * the scroll root — the zero-jump recorder reads those attributes, and
 * `useStickToBottom` never touches them.
 *
 * Gates that have to hold before the reveal: (i) `dataReady`, (ii)
 * `layoutSettled` and, for an element anchor, the target element being mounted,
 * (iii) two consecutive animation frames with an unchanged `scrollTop` and
 * `scrollHeight` after the target was applied, (iv) every in-viewport `<img>`
 * complete. Gate (v) is the opposite direction: once the budget has passed since
 * (i), the content is revealed anyway and the state becomes `ready-forced` — a
 * diagnostic signal, never a pass. The budget and the image wait are measured
 * from the moment (i) holds, so a slow query delays the measurement instead of
 * expiring it.
 */
export function useAnchoredReveal(options: UseAnchoredRevealOptions): UseAnchoredRevealResult {
  const {
    scrollEl,
    contentEl,
    resetKey,
    dataReady,
    anchor,
    layoutSettled = true,
    fresh,
    budgetMs = DEFAULT_BUDGET_MS,
    imageWaitMs = DEFAULT_IMAGE_WAIT_MS,
    enabled = true,
    initialPositioned = false,
  } = options;

  const [state, setState] = useState<RevealState>(initialPositioned ? "ready" : "pending");
  const stateRef = useRef<RevealState>(initialPositioned ? "ready" : "pending");
  const initialKeyRef = useRef(resetKey);
  /** rAF chain generation: bumping it cancels whatever the previous run queued. */
  const runRef = useRef(0);
  /** The activation the DOM was last prepared for, by identity. */
  const preparedRef = useRef<{ key: string; scrollEl: HTMLElement | null; contentEl: HTMLElement | null } | null>(
    null,
  );
  /** When gate (i) last held; gates (iv) and (v) are measured from here. */
  const dataReadyAtRef = useRef<number | null>(null);

  // `anchor` is usually rebuilt by the consumer on every render, so the effects
  // below depend on its parts instead of its identity.
  const anchorKind = anchor.kind;
  const anchorId = anchor.kind === "element" ? anchor.id : "";
  const anchorAlign = anchor.kind === "element" ? anchor.align ?? "center" : "center";
  const resolveAnchor = useCallback((): RevealAnchor => {
    if (anchorKind === "bottom") return { kind: "bottom" };
    return anchorAlign === "start"
      ? { kind: "element", id: anchorId, align: "start" }
      : { kind: "element", id: anchorId };
  }, [anchorKind, anchorId, anchorAlign]);

  // `data-perf-fresh` is always written with the state, so the recorder never
  // reads a `ready` carrying a freshness bit from some other frame. Both writes
  // are idempotent: re-setting an unchanged attribute would add a
  // MutationObserver record on every animation frame, and the recorder would
  // then report state transitions that never happened. `fresh === undefined`
  // removes the attribute (main has no replica yet).
  const writeState = useCallback(
    (next: RevealState): void => {
      if (!scrollEl) return;
      if (fresh === undefined) {
        scrollEl.removeAttribute("data-perf-fresh");
      } else {
        const value = fresh ? "1" : "0";
        if (scrollEl.getAttribute("data-perf-fresh") !== value) {
          scrollEl.setAttribute("data-perf-fresh", value);
        }
      }
      if (scrollEl.getAttribute("data-perf-state") !== next) {
        scrollEl.setAttribute("data-perf-state", next);
      }
    },
    [scrollEl, fresh],
  );

  // Preparing an activation is a layout effect: the frame that mounts the
  // content must never paint it at its pre-settlement position.
  useLayoutEffect(() => {
    const key = `${resetKey}|${enabled ? "on" : "off"}`;
    const prepared = preparedRef.current;
    // Element identity, not just presence: a consumer that swaps its scroll root
    // for another one gets a fresh activation.
    if (prepared && prepared.key === key && prepared.scrollEl === scrollEl && prepared.contentEl === contentEl) {
      return;
    }
    preparedRef.current = { key, scrollEl, contentEl };
    // A restart must not let the previous generation run another frame against
    // the anchor it was started for.
    runRef.current += 1;
    dataReadyAtRef.current = null;

    if (initialPositioned && initialKeyRef.current === resetKey && dataReady) {
      if (scrollEl && scrollEl.dataset.ssrPositioned !== "1") return;
      if (scrollEl && contentEl) scrollEl.scrollTop = targetScrollTop(scrollEl, resolveAnchor());
      stateRef.current = "ready";
      setState("ready");
      writeState("ready");
      return;
    }

    if (!enabled) {
      // Pass-through: leave the content visible and clear whatever a previous
      // activation may have written.
      contentEl?.style.removeProperty("visibility");
      scrollEl?.removeAttribute("data-perf-state");
      scrollEl?.removeAttribute("data-perf-fresh");
      stateRef.current = "ready";
      setState("ready");
      return;
    }
    // Pending is published as soon as the scroll root is there: the recorder has
    // to see the hidden phase, and a missing content wrapper must not degrade
    // into "no attribute at all".
    stateRef.current = "pending";
    setState("pending");
    writeState("pending");
    if (!contentEl) return;

    contentEl.style.visibility = "hidden";
  }, [resetKey, enabled, scrollEl, contentEl, writeState, initialPositioned, dataReady, resolveAnchor]);

  // The first aim happens before the frame is painted, and it is also where gate
  // (i) starts its clock: the budget is measured from the moment the consumer
  // said the data was there, not from the first animation frame after that.
  useLayoutEffect(() => {
    if (!enabled || !dataReady || !scrollEl || !contentEl) {
      dataReadyAtRef.current = null;
      return;
    }
    if (stateRef.current !== "pending") return;
    if (dataReadyAtRef.current === null) dataReadyAtRef.current = performance.now();
    scrollEl.scrollTop = targetScrollTop(scrollEl, resolveAnchor());
  }, [enabled, dataReady, scrollEl, contentEl, resolveAnchor, resetKey]);

  // A `fresh` change re-publishes the current state, so a page that learns it is
  // stale while still hidden says so before it ever reveals.
  useEffect(() => {
    if (!enabled || !scrollEl) return;
    if (initialPositioned && scrollEl.dataset.ssrPositioned !== "1") return;
    writeState(state);
  }, [enabled, scrollEl, state, writeState, initialPositioned]);

  useEffect(() => {
    // Gate (i) is what starts the rAF loop; with the data not there yet there is
    // nothing to measure and nothing to settle.
    if (!enabled || !dataReady || !scrollEl || !contentEl) return;

    runRef.current += 1;
    const runId = runRef.current;
    const resolvedAnchor = resolveAnchor();
    let rafHandle = 0;
    let lastTop = Number.NaN;
    let lastHeight = Number.NaN;
    /** Consecutive frames that observed the same `scrollTop` and `scrollHeight`. */
    let stableFrames = 0;
    let imageWaitElapsed = false;

    const reveal = (next: RevealState): void => {
      if (stateRef.current !== "pending") return;
      // The order is the contract: clear the hidden flag, publish both
      // attributes, then commit the state inside `flushSync`, so the skeleton
      // unmount and the content becoming visible land in the same frame.
      contentEl.style.visibility = "";
      writeState(next);
      flushSync(() => {
        stateRef.current = next;
        setState(next);
      });
    };

    const schedule = (callback: () => void): void => {
      rafHandle = requestAnimationFrame(callback);
    };

    const step = (): void => {
      if (runRef.current !== runId || stateRef.current !== "pending") return;

      const now = performance.now();
      const dataReadyAt = dataReadyAtRef.current ?? now;
      dataReadyAtRef.current = dataReadyAt;
      if (!imageWaitElapsed && now - dataReadyAt >= imageWaitMs) imageWaitElapsed = true;

      // Gate (v): the budget wins over the gates, and names the ones that were
      // unmet. A forced reveal is a diagnostic signal, not a pass.
      if (now - dataReadyAt >= budgetMs) {
        const unmet: string[] = [];
        if (!layoutSettled) unmet.push("layoutSettled");
        if (resolvedAnchor.kind === "element" && !anchorElement(scrollEl, resolvedAnchor)) unmet.push("anchor");
        if (stableFrames < 2) unmet.push("stable-frames");
        if (!imageWaitElapsed && pendingImages(scrollEl).length > 0) unmet.push("images");
        // Aim one last time before showing.
        scrollEl.scrollTop = targetScrollTop(scrollEl, resolvedAnchor);
        console.warn(
          `[useAnchoredReveal] budget of ${budgetMs}ms expired before the gates settled${
            unmet.length > 0 ? `: ${unmet.join(", ")}` : ""
          }`,
        );
        reveal("ready-forced");
        return;
      }

      // Gate (ii).
      if (!layoutSettled) {
        schedule(step);
        return;
      }
      if (resolvedAnchor.kind === "element" && !anchorElement(scrollEl, resolvedAnchor)) {
        stableFrames = 0;
        schedule(step);
        return;
      }

      // Gate (iii): re-apply the target every frame and count consecutive frames
      // that agree, so late content resets the count instead of settling early.
      scrollEl.scrollTop = targetScrollTop(scrollEl, resolvedAnchor);
      const top = scrollEl.scrollTop;
      const height = scrollEl.scrollHeight;
      stableFrames = top === lastTop && height === lastHeight ? stableFrames + 1 : 1;
      lastTop = top;
      lastHeight = height;

      if (stableFrames >= 2) {
        // Gate (iv): images still loading inside the viewport hold the reveal
        // back until they complete or their wait budget runs out.
        if (!imageWaitElapsed && pendingImages(scrollEl).length > 0) {
          schedule(step);
          return;
        }
        reveal("ready");
        return;
      }
      schedule(step);
    };

    schedule(step);
    return () => {
      runRef.current += 1;
      cancelAnimationFrame(rafHandle);
    };
  }, [
    enabled,
    dataReady,
    scrollEl,
    contentEl,
    layoutSettled,
    budgetMs,
    imageWaitMs,
    resolveAnchor,
    writeState,
    resetKey,
  ]);

  return { state, revealed: state !== "pending" };
}
