"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveLabel } from "../lib/turn-steps";

/** A live label stays up at least this long before the next one replaces it (Codex). */
export const MIN_LIVE_LABEL_MS = 1000;

const isIdle = (label: LiveLabel) => label.kind === "reasoning" || label.kind === "thinking";

/**
 * Hold each live label for at least `minMs` (Codex keeps an active key up for
 * 1000ms), so fast steps do not flash:
 * - an activity holds against the next activity, against thinking that
 *   follows it and against a breaker that starts streaming — while held, the
 *   finished row or group keeps showing it;
 * - a reasoning heading holds against the next heading.
 * Immediate: the same activity with fresher details (command text that
 * arrived late), thinking giving way to an activity or to a streaming
 * breaker, anything after `quiet`, and the end of the run (`null`), which
 * shows the completed summary at once.
 */
export function useStickyLabel(label: LiveLabel | null, minMs = MIN_LIVE_LABEL_MS): LiveLabel | null {
  const signature = label ? JSON.stringify(label) : "";
  const [shown, setShown] = useState<{ signature: string; label: LiveLabel | null }>(() => ({ signature, label }));
  const since = useRef<number | null>(null);
  if (since.current === null) since.current = Date.now();
  const latest = useRef(label);
  latest.current = label;
  useEffect(() => {
    if (signature === shown.signature) return;
    const next = latest.current;
    const show = () => {
      if (next?.id !== shown.label?.id) since.current = Date.now();
      setShown({ signature, label: next });
    };
    const current = shown.label;
    const immediate = next === null || current === null || current.kind === "quiet" || next.id === current.id
      || (isIdle(current) && !isIdle(next));
    if (immediate) {
      show();
      return;
    }
    const wait = since.current! + minMs - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [signature, shown, minMs]);
  return shown.label;
}

/** `Date.now()`, ticking on the whole seconds after `anchor` while `active`. */
export function useTickingNow(active: boolean, anchor: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const offset = anchor === null ? 0 : ((current - anchor) % 1000 + 1000) % 1000;
      timer = setTimeout(tick, 1000 - offset);
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, anchor]);
  return now;
}
