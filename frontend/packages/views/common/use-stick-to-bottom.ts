"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StickMode = { kind: "bottom" } | { kind: "element"; id: string };

export type StickState = "pinned" | "released" | "returning";

export interface UseStickToBottomOptions {
  scrollEl: HTMLElement | null;
  /** ResizeObserver target: the same node `useAnchoredReveal` measures. */
  contentEl: HTMLElement | null;
  mode: StickMode;
  /**
   * Pass `reveal.revealed`: while false nothing is observed, nothing is
   * compensated, and the state stays at the activation's `initialState`.
   */
  enabled: boolean;
  /** Defaults to `pinned`; a deep link passes `released` so its target is not dragged away. */
  initialState?: "pinned" | "released";
  /** Defaults to 24: scrolling back to within this distance of the bottom re-pins. */
  pinThresholdPx?: number;
  onStateChange?: (state: StickState) => void;
}

export interface UseStickToBottomResult {
  state: StickState;
  /**
   * `released → returning → pinned`: scrolls back to the end of the content,
   * smoothly unless `prefers-reduced-motion` asks for an instant jump. The
   * transaction ends when the scrolling goes quiet, so an interrupted glide
   * falls back to `released`. A no-op while the scroll root is missing.
   */
  returnToBottom(): void;
  /** For consumers with their own at-the-bottom signal, e.g. Virtuoso's `atBottomStateChange(true)`. */
  pin(): void;
}

const DEFAULT_PIN_THRESHOLD_PX = 24;
/** Quiet period after the last scroll event that ends a `returning` scroll. */
const RETURN_SETTLE_MS = 100;
/** Slack when matching a scroll event against the position this hook scrolled to. */
const PROGRAMMATIC_SLACK_PX = 1;

/**
 * Keeps the content pinned to its anchor while async content lands above it
 * (MUL-383 S2a; consumed by MUL-390 and MUL-443).
 *
 * The compensation runs inside the `ResizeObserver` callback, which fires after
 * layout and before paint, so content that arrives above the viewport never
 * shows as an intermediate frame: bottom mode preserves the distance to the
 * bottom, element mode preserves the target row's offset. The hook writes no DOM
 * attributes and renders nothing — `state` is all a consumer needs to decide
 * whether to show its own "N new messages" affordance.
 *
 * Transitions: `pinned → released` on user scroll intent (wheel up, touch drag,
 * arrow/page keys, scrollbar grab) or on a scroll this hook did not write that
 * leaves the pin window; `released → pinned` when such a scroll comes back
 * within `pinThresholdPx` (bottom mode) or the consumer calls `pin()`;
 * `released → returning → pinned` through `returnToBottom()`.
 */
export function useStickToBottom(options: UseStickToBottomOptions): UseStickToBottomResult {
  const {
    scrollEl,
    contentEl,
    mode,
    enabled,
    initialState = "pinned",
    pinThresholdPx = DEFAULT_PIN_THRESHOLD_PX,
    onStateChange,
  } = options;

  const [state, setState] = useState<StickState>(initialState);

  const stateRef = useRef<StickState>(initialState);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  /** Distance to the bottom (bottom mode) or target offset (element mode) to preserve. */
  const anchorValueRef = useRef(0);
  /**
   * Scroll position this hook wrote last. A scroll event at exactly that
   * position is the echo of the hook's own write, not the user; the marker is
   * matched by position rather than consumed, so a coalesced or missing event
   * cannot leave it primed to swallow the next real scroll.
   */
  const programmaticTopRef = useRef<number | null>(null);
  /** Set while a `returnToBottom()` scroll is still in flight. */
  const returningRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const modeKind = mode.kind;
  const modeId = mode.kind === "element" ? mode.id : "";

  const bottomDistance = useCallback((): number => {
    if (!scrollEl) return 0;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  }, [scrollEl]);

  const targetElement = useCallback((): HTMLElement | null => {
    if (!scrollEl || modeKind !== "element") return null;
    const el = scrollEl.ownerDocument.getElementById(modeId);
    return el && scrollEl.contains(el) ? el : null;
  }, [scrollEl, modeKind, modeId]);

  /** Target row's offset from the scroll root's content origin, or null while unmounted. */
  const targetOffset = useCallback((): number | null => {
    const target = targetElement();
    if (!scrollEl || !target) return null;
    const rect = target.getBoundingClientRect();
    return rect.top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  }, [scrollEl, targetElement]);

  /** The offset `pinned` has to hold; `0` when the anchor is not measurable. */
  const anchorValue = useCallback((): number => {
    if (modeKind === "bottom") return Math.max(0, bottomDistance());
    return targetOffset() ?? anchorValueRef.current;
  }, [bottomDistance, modeKind, targetOffset]);

  const clearSettleTimer = useCallback((): void => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const transition = useCallback((next: StickState): void => {
    returningRef.current = next === "returning";
    if (stateRef.current === next) return;
    stateRef.current = next;
    setState(next);
    onStateChangeRef.current?.(next);
  }, []);

  const release = useCallback((): void => {
    if (stateRef.current === "pinned") {
      // Keep the distance the user parked at, so a later resize does not snap.
      anchorValueRef.current = anchorValue();
    }
    clearSettleTimer();
    transition("released");
  }, [anchorValue, clearSettleTimer, transition]);

  const pin = useCallback((): void => {
    clearSettleTimer();
    anchorValueRef.current = anchorValue();
    transition("pinned");
  }, [anchorValue, clearSettleTimer, transition]);

  /**
   * `returning` ends when the scrolling goes quiet, not when the first scroll
   * event arrives: a smooth scroll produces a long tail of them. Both modes
   * travel to the end of the content, so a glide the user interrupted halfway
   * is reported as `released` rather than `pinned`.
   */
  const armSettleTimer = useCallback((): void => {
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      returningRef.current = false;
      if (bottomDistance() <= pinThresholdPx) pin();
      else release();
    }, RETURN_SETTLE_MS);
  }, [bottomDistance, clearSettleTimer, pin, pinThresholdPx, release]);

  const returnToBottom = useCallback((): void => {
    if (!scrollEl) return;
    const top = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    clearSettleTimer();
    transition("returning");
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof scrollEl.scrollTo === "function" && !reduceMotion) {
      scrollEl.scrollTo({ top, behavior: "smooth" });
    } else {
      programmaticTopRef.current = top;
      scrollEl.scrollTop = top;
    }
    // The scroll may already be at the anchor, in which case no scroll event
    // follows; the timer also ends the transaction for that case.
    armSettleTimer();
  }, [armSettleTimer, clearSettleTimer, scrollEl, transition]);

  // Latest `initialState` prop. It is read through a ref at activation time and
  // deliberately kept out of the activation identity below: a consumer that
  // re-renders with a different `initialState` while the machine is live must
  // not be able to yank a reader who scrolled away back to the bottom.
  const initialStateRef = useRef(initialState);
  initialStateRef.current = initialState;

  // Activation: `enabled` (the consumer passes `reveal.revealed`) gates the whole
  // machine, and every new activation applies the `initialState` current at that
  // moment — a deep link mounts released, a normal open mounts pinned. Only two
  // things start one: `enabled` rising from false, and the scroll root being
  // replaced. While the machine is live it owns its state.
  const activeScrollRef = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      activeScrollRef.current = undefined;
      clearSettleTimer();
      returningRef.current = false;
      return;
    }
    if (activeScrollRef.current === scrollEl) return;
    activeScrollRef.current = scrollEl;
    const activationState = initialStateRef.current;
    clearSettleTimer();
    programmaticTopRef.current = null;
    anchorValueRef.current = anchorValue();
    stateRef.current = activationState;
    returningRef.current = false;
    setState(activationState);
  }, [anchorValue, clearSettleTimer, enabled, scrollEl]);

  // User intent. A wheel down, a scrollbar drag downwards or a page-down key are
  // not "take over" signals: the machine stays pinned and the position decides.
  useEffect(() => {
    if (!enabled || !scrollEl || modeKind !== "bottom") return;

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0) return;
      programmaticTopRef.current = null;
      release();
    };
    const onTouchMove = (): void => {
      programmaticTopRef.current = null;
      release();
    };
    const onPointerDown = (event: PointerEvent): void => {
      // Grabbing the scrollbar: the pointer sits in the gutter to the right of
      // the client box, where no in-content element can be.
      if (event.offsetX < scrollEl.clientWidth) return;
      programmaticTopRef.current = null;
      release();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // Keys typed into a field move the caret, not the page.
      if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const shiftSpace = event.shiftKey && event.key === " ";
      if (event.key !== "ArrowUp" && event.key !== "PageUp" && event.key !== "Home" && !shiftSpace) return;
      programmaticTopRef.current = null;
      release();
    };

    scrollEl.addEventListener("wheel", onWheel, { passive: true });
    scrollEl.addEventListener("touchmove", onTouchMove, { passive: true });
    scrollEl.addEventListener("pointerdown", onPointerDown);
    scrollEl.addEventListener("keydown", onKeyDown);
    return () => {
      scrollEl.removeEventListener("wheel", onWheel);
      scrollEl.removeEventListener("touchmove", onTouchMove);
      scrollEl.removeEventListener("pointerdown", onPointerDown);
      scrollEl.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, release, scrollEl, modeKind]);

  useEffect(() => {
    if (!enabled || !scrollEl) return;

    const onScroll = (): void => {
      if (returningRef.current) {
        // Still gliding (or the user took over): decide once it goes quiet.
        armSettleTimer();
        return;
      }

      // This hook's own compensation must not read as a user scroll.
      const written = programmaticTopRef.current;
      if (written !== null && Math.abs(scrollEl.scrollTop - written) <= PROGRAMMATIC_SLACK_PX) return;
      programmaticTopRef.current = null;

      if (modeKind === "bottom") {
        if (bottomDistance() <= pinThresholdPx) pin();
        else release();
        return;
      }
      // Element mode has no distance rule: any scroll the hook did not write
      // means the user moved the anchor.
      release();
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
    };
  }, [
    armSettleTimer,
    bottomDistance,
    enabled,
    modeKind,
    pin,
    pinThresholdPx,
    release,
    scrollEl,
  ]);

  // Same-frame compensation, the whole point of the hook: the resize callback
  // runs after layout and before paint, so the corrected position is the one the
  // frame paints.
  useEffect(() => {
    if (!enabled || !scrollEl || !contentEl) return;

    const compensate = (): void => {
      if (stateRef.current !== "pinned") return;
      if (modeKind === "bottom") {
        const top = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight - anchorValueRef.current);
        if (top === scrollEl.scrollTop) return;
        programmaticTopRef.current = top;
        scrollEl.scrollTop = top;
        return;
      }
      const offset = targetOffset();
      if (offset === null) return;
      const delta = offset - anchorValueRef.current;
      if (delta === 0) return;
      const top = Math.max(0, scrollEl.scrollTop + delta);
      programmaticTopRef.current = top;
      scrollEl.scrollTop = top;
    };

    const observer = new ResizeObserver(compensate);
    observer.observe(contentEl);
    return () => {
      observer.disconnect();
    };
  }, [contentEl, enabled, modeKind, scrollEl, targetOffset]);

  // A new anchor under a live pin: adopt its current position instead of
  // scrolling to wherever the previous anchor was.
  useEffect(() => {
    if (!enabled) return;
    if (stateRef.current !== "pinned") return;
    anchorValueRef.current = anchorValue();
  }, [anchorValue, contentEl, enabled, modeId, modeKind]);

  useEffect(() => {
    return () => {
      clearSettleTimer();
    };
  }, [clearSettleTimer]);

  return { state, returnToBottom, pin };
}
