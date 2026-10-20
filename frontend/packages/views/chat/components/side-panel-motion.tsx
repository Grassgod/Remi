"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, type AnimationPlaybackControls, type MotionValue, type ValueAnimationTransition } from "motion/react";
import { defaultStorage } from "@multiremi/core/platform";
import { cn } from "@multiremi/ui/lib/utils";

// How the Chat page's side panel (子代理 / 后台任务) opens and closes, after the
// Codex desktop drawer: one interruptible progress value (0 closed, 1 open)
// drives the pane. In the page split the drawer's outer width is
// `clamp(progress) × width` with its overflow clipped, while the panel inside
// keeps its final width, so its text never rewraps mid-animation; covering the
// conversation (narrow page, floating window) it slides in with translateX.
// The panel mounts before it opens and unmounts only once closing reaches 0;
// a reversal mid-way retargets from the current value and velocity. Reduced
// motion sets 0 or 1 at once.

/** The conversation keeps this much beside the panel (Codex). */
export const CONVERSATION_MIN_PX = 352;
export const SUBAGENT_PANEL_MIN_PX = 320;
/**
 * The panel's width until the reader drags it: an overview row (name, type,
 * time) and the detail's mini conversation at a readable measure.
 */
export const SUBAGENT_PANEL_DEFAULT_PX = 400;
/** Wider than this it stops being a side panel next to the 768px chat column. */
export const SUBAGENT_PANEL_MAX_PX = 560;
const RESIZE_STEP_PX = 16;
const WIDTH_KEY = "chat-subagent-panel-width";

/** The page split: Codex's spring, 0.5 s with a 0.1 bounce (clamped, so it never overshoots the width). */
export const SPLIT_TRANSITION: ValueAnimationTransition<number> = { type: "spring", duration: 0.5, bounce: 0.1 };
/** Covering the conversation: 200 ms ease-out (Codex's `cubic-bezier(.165,.84,.44,1)`). */
export const OVERLAY_TRANSITION: ValueAnimationTransition<number> = { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] };

export const clampProgress = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Progress for a panel that is `open`, and whether it is mounted: from the
 * render that opens it (at progress 0) until a close has animated to 0.
 * `instant` skips the animation for this change (reduced motion, a hidden
 * window), and so does a new `resetKey` (the panel left with its chat). The
 * transition is read when a change starts.
 */
export function useDrawerProgress(open: boolean, options: {
  instant: boolean;
  transition: ValueAnimationTransition<number>;
  resetKey?: string | null;
}): { progress: MotionValue<number>; mounted: boolean } {
  const { instant, transition, resetKey = null } = options;
  const progress = useMotionValue(open ? 1 : 0);
  const [mounted, setMounted] = useState(open);
  // The last change, adjusted during render so the panel never misses a
  // frame: mounted in the render that opens it, kept in the render that
  // starts closing it (unless that close is instant).
  const [change, setChange] = useState(() => ({ open, key: resetKey, instant: true, initial: true }));
  if (change.open !== open || change.key !== resetKey) {
    const snap = instant || change.key !== resetKey;
    setChange({ open, key: resetKey, instant: snap, initial: false });
    if (open) setMounted(true);
    else if (snap) setMounted(false);
  }
  const latest = useRef({ open, transition });
  const controls = useRef<AnimationPlaybackControls | null>(null);
  useLayoutEffect(() => {
    latest.current = { open, transition };
  });
  useLayoutEffect(() => {
    if (change.initial) return;
    const to = change.open ? 1 : 0;
    if (change.instant) {
      controls.current?.stop();
      controls.current = null;
      progress.jump(to);
      return;
    }
    // `animate` stops the running animation and starts from its value and velocity.
    controls.current = animate(progress, to, {
      ...latest.current.transition,
      onComplete: () => {
        if (!latest.current.open) setMounted(false);
      },
    });
  }, [change, progress]);
  useEffect(() => () => controls.current?.stop(), []);
  return { progress, mounted: mounted || open };
}

/**
 * The panel's frame while it is mounted. In the split, an outer box whose
 * width is `clamp(progress) × width`, clipped, around the panel at its full
 * width (`contain: layout paint`); covering the conversation, the panel moved
 * by `translateX((1 − progress) × 100%)`. Closing, it is inert.
 *
 * The derived values follow `progress` through subscriptions made before any
 * layout effect (motion's `useTransform` resubscribes in one and would miss an
 * instant jump), and only while the panel is mounted: motion asks for a frame
 * whenever a subscription ends.
 */
export function SidePanelFrame({ mode, progress, width, open, children }: {
  mode: "split" | "overlay";
  progress: MotionValue<number>;
  width: MotionValue<number>;
  open: boolean;
  children: ReactNode;
}) {
  const drawerWidth = useMotionValue(clampProgress(progress.get()) * width.get());
  const overlayX = useMotionValue(`${(1 - clampProgress(progress.get())) * 100}%`);
  const follow = useCallback(() => {
    const value = clampProgress(progress.get());
    drawerWidth.set(value * width.get());
    overlayX.set(`${(1 - value) * 100}%`);
  }, [progress, width, drawerWidth, overlayX]);
  useMotionValueEvent(progress, "change", follow);
  useMotionValueEvent(width, "change", follow);
  if (mode === "overlay") {
    return (
      <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
        <motion.div data-subagent-panel-mode="overlay" inert={!open} style={{ x: overlayX }}
          className="pointer-events-auto flex h-full min-h-0 flex-col bg-background">
          {children}
        </motion.div>
      </div>
    );
  }
  return (
    <motion.div data-subagent-panel-drawer className="relative min-h-0 shrink-0 overflow-hidden" style={{ width: drawerWidth }}>
      <motion.div data-subagent-panel-mode="split" inert={!open} style={{ width, minWidth: width, contain: "layout paint" }}
        className="flex h-full min-h-0 flex-col border-l bg-background">
        {children}
      </motion.div>
    </motion.div>
  );
}

function readStoredWidth(): number {
  const stored = Number(defaultStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : SUBAGENT_PANEL_DEFAULT_PX;
}

/** The panel width the reader chose (px, unclamped), remembered per browser. */
export function useSidePanelWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(readStoredWidth);
  const commit = useCallback((next: number) => {
    const rounded = Math.round(next);
    setWidth(rounded);
    defaultStorage.setItem(WIDTH_KEY, String(rounded));
  }, []);
  return [width, commit];
}

/** The widest panel a container of `available` px fits beside a 352px conversation. */
export function sidePanelMaxWidth(available: number): number {
  return Math.min(SUBAGENT_PANEL_MAX_PX, available - CONVERSATION_MIN_PX);
}

export function clampSidePanelWidth(width: number, available: number): number {
  return Math.max(SUBAGENT_PANEL_MIN_PX, Math.min(sidePanelMaxWidth(available), width));
}

/**
 * The zero-width separator on the panel's left edge: drag or use the arrow
 * keys to resize, double-click to restore the default. It moves the width
 * value directly while dragging and remembers the width on release.
 */
export function SidePanelResizeHandle({ width, min, max, label, onCommit }: {
  width: MotionValue<number>;
  min: number;
  max: number;
  label: string;
  onCommit: (width: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null);
  const clamp = useCallback((value: number) => Math.max(min, Math.min(max, value)), [min, max]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const show = (value: number) => element.setAttribute("aria-valuenow", String(Math.round(value)));
    show(width.get());
    return width.on("change", show);
  }, [width]);
  const set = (value: number, commit: boolean) => {
    const next = clamp(value);
    width.set(next);
    if (commit) onCommit(next);
  };
  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      data-subagent-panel-resize=""
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width: width.get(), pointer: event.pointerId };
        event.currentTarget.dataset.active = "";
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) return;
        // The panel is on the right: moving left widens it.
        set(start.width + start.x - event.clientX, false);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        drag.current = null;
        delete event.currentTarget.dataset.active;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        set(width.get(), true);
      }}
      onPointerCancel={(event) => {
        if (!drag.current) return;
        drag.current = null;
        delete event.currentTarget.dataset.active;
        set(width.get(), true);
      }}
      onDoubleClick={() => set(SUBAGENT_PANEL_DEFAULT_PX, true)}
      onKeyDown={(event) => {
        const current = width.get();
        const next = event.key === "ArrowLeft" ? current + RESIZE_STEP_PX
          : event.key === "ArrowRight" ? current - RESIZE_STEP_PX
            : event.key === "Home" ? max
              : event.key === "End" ? min
                : event.key === "Enter" ? SUBAGENT_PANEL_DEFAULT_PX : null;
        if (next === null) return;
        event.preventDefault();
        set(next, true);
      }}
      className={cn(
        "relative z-10 w-0 shrink-0 cursor-col-resize touch-none select-none focus-visible:outline-hidden",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors",
        "hover:before:bg-foreground/15 focus-visible:before:bg-ring data-[active]:before:bg-foreground/15",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
      )}
    />
  );
}
