"use client";

import { useEffect, useState } from "react";
import { useNavigationStore } from "../navigation";

/**
 * Wait before the deferred app-shell work runs (MUL-472 b, MUL-383 A5).
 *
 * The point is not to hide data: it is to keep the shell's own requests out of
 * the route's first wave. Every page paid for them (MUL-383 §6 S9-1), so they
 * move behind one idle callback once the new route's first content commit has
 * happened. Pins, invitations, the CLI update hint and the sidebar badges
 * therefore appear up to a second later — accepted in A5.
 */
export const AFTER_FIRST_SCREEN_TIMEOUT_MS = 1000;

/**
 * Schedules `callback` for the first idle slot after the current commit, or at
 * `timeoutMs` at the latest.
 *
 * `requestIdleCallback` with a timeout is the definition A5 agreed on. Engines
 * without it (older WebKit, jsdom) fall back to a macrotask, which keeps the
 * ordering property that matters here — the page's own effects have already
 * run — without inventing a different dwell time.
 *
 * Returns a cancel function; the caller must run it on unmount, otherwise a
 * route change leaves the previous route's timer armed.
 */
export function scheduleAfterFirstIdle(
  callback: () => void,
  timeoutMs: number = AFTER_FIRST_SCREEN_TIMEOUT_MS,
): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      handler: () => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => callback(), {
      timeout: timeoutMs,
    });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

export interface UseAfterFirstScreenOptions {
  /**
   * Identity of the route being waited for. Changing it restarts the wait, so a
   * client-side navigation defers the shell again instead of inheriting the
   * previous route's "already past the first screen".
   *
   * Defaults to the navigation store's last path, which the dashboard guard
   * writes on every route change. Callers that already have `pathname` (the
   * sidebar) should pass it: the store update lands one commit later.
   */
  routeKey?: string;
  /** Overridable for tests; production always uses the A5 contract of 1 s. */
  timeoutMs?: number;
}

/**
 * `false` while the current route is still inside its first content commit and
 * the idle callback that follows it; `true` afterwards.
 *
 * Consumers gate their queries on the return value:
 *
 *   const afterFirstScreen = useAfterFirstScreen();
 *   useQuery({ ...somethingOptions(), enabled: afterFirstScreen });
 *
 * Gated queries keep cached data; only the network request moves.
 */
export function useAfterFirstScreen(options: UseAfterFirstScreenOptions = {}): boolean {
  const storedPath = useNavigationStore((state) => state.lastPath);
  const routeKey = options.routeKey ?? storedPath ?? "";
  const timeoutMs = options.timeoutMs ?? AFTER_FIRST_SCREEN_TIMEOUT_MS;
  const [passed, setPassed] = useState(false);

  useEffect(() => {
    // A new route starts hidden again: this effect is what defines "the first
    // content commit of the current route".
    setPassed(false);
    return scheduleAfterFirstIdle(() => setPassed(true), timeoutMs);
  }, [routeKey, timeoutMs]);

  return passed;
}
