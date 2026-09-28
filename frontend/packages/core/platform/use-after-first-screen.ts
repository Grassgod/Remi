"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { useNavigationStore } from "../navigation";

/**
 * The app-shell / page request gate (MUL-472 b, MUL-383 A5).
 *
 * ## Why this exists
 *
 * Every page used to pay for the shell's own requests (pins, invitations, the
 * CLI update hint, the sidebar badges, agent presence roll-ups) in its first
 * wave. A5 accepted moving them behind the route's first screen.
 *
 * ## When the gate opens (QA rework `cmt_r0euas6zfxff`)
 *
 * The first version opened the gate on the first idle slot after *its own*
 * mount. That is not the same thing as "the page has content": while the list
 * request is still in flight the browser is idle, so the gate opened before
 * the main content existed — measured 660 ms early for
 * `/api/agent-task-snapshot`, 102 ms for `/api/pins`.
 *
 * The gate now waits for two things, in order:
 *
 *  1. **this route's main content is ready** — published by the page itself
 *     through {@link useRouteContentReady}. The list pages publish the same
 *     condition that drives their `data-perf-scroll="list"` marker (query
 *     settled, not `keepPreviousData`); the issue detail publishes its own
 *     body readiness. Success, empty and failure all count: a failed list must
 *     not keep the deferred shell content away forever. Readiness is taken one
 *     animation frame later, so the rows have actually painted: a request that
 *     left in the same commit as the rows would still race the user's first
 *     look at them.
 *  2. **the first idle callback after that** (`requestIdleCallback` with a 1 s
 *     `timeout`, per A5).
 *
 * A route that never publishes readiness falls back to a
 * {@link AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS} timer measured from the moment
 * the route was first observed, and then takes the same idle step.
 *
 * ## Two classes of consumer
 *
 * The ruling splits the gated queries in two, because they behave differently
 * across a client-side navigation:
 *
 *  - **`scope: "page"`** — queries owned by a page that mounts and unmounts
 *    (`agent-task-snapshot`, `agents?include_archived`, `child-progress`,
 *    `squads`, …). They wait for the gate on *every* route change, and the new
 *    page's first render must already be `false`. That is why the state is kept
 *    as "which route key passed" rather than a single boolean: a stale `true`
 *    would leak into the new route's first render.
 *  - **`scope: "shell"`** — queries owned by a component that stays mounted
 *    across routes (the sidebar's pins, invitations, CLI hint and badges, the
 *    chat FAB). They wait only for the **first** page of the session; after
 *    that they never close again. Closing and reopening them on every
 *    navigation would re-issue expired requests and make hot navigation cost
 *    *more* than the pre-MUL-472 baseline.
 *
 * Both are safe against the other failure mode QA found: nothing here closes a
 * gate that a page's own content has already satisfied, and a page-level gate
 * is keyed by the route visit, so returning to an earlier path starts closed.
 */

/** Idle-callback deadline once the route's content is ready (A5 contract). */
export const AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS = 1000;
/**
 * Fallback for routes with no readiness publisher: how long after the route is
 * first observed the gate stops waiting for content and takes the idle step.
 * Long enough to cover a normal first content commit, short enough that a
 * deferred badge cannot lag the page by more than ~3 s in total.
 */
export const AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS = 2000;

export type AfterFirstScreenScope = "page" | "shell";

interface RouteGate {
  /** The route published (or the fallback decided) that its content settled. */
  contentReady: boolean;
  passed: boolean;
  cancelIdle: (() => void) | null;
  fallbackHandle: ReturnType<typeof setTimeout> | null;
  /**
   * The route mounts a readiness publisher. The fallback exists for routes that
   * have none; once a publisher is present it owns the decision, because its
   * contract is to settle for success, empty *and* failure. Without this the
   * timer would open the gate on a slow first load — measured on a cold `next
   * dev` compile, where the timer fired ~500 ms before the rows.
   */
  hasPublisher: boolean;
}

const gates = new Map<string, RouteGate>();
const listeners = new Set<() => void>();
const RouteContext = createContext<string | null>(null);

/** Supplies the current render's pathname, before persisted navigation updates. */
export function FirstScreenRouteProvider({ routeKey, children }: {
  routeKey: string;
  children: ReactNode;
}) {
  return createElement(RouteContext.Provider, { value: routeKey }, children);
}

/** Session-wide: the shell class never closes again after its first opening. */
let shellPassed = false;
/** The route visit the registry currently describes. */
let currentRouteKey: string | null = null;

let idleTimeoutMs = AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS;
let contentFallbackMs = AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Schedules `callback` for the first idle slot, or at `timeoutMs` at the
 * latest.
 *
 * `requestIdleCallback` with a timeout is the definition A5 agreed on. Engines
 * without it (older WebKit, jsdom) fall back to a macrotask, which keeps the
 * ordering property that matters here — the page's own effects have already
 * run — without inventing a different dwell time.
 */
export function scheduleAfterFirstIdle(
  callback: () => void,
  timeoutMs: number = AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS,
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

function scheduleGateIdle(routeKey: string): void {
  const gate = gates.get(routeKey);
  if (!gate || gate.passed || gate.cancelIdle) return;
  gate.cancelIdle = scheduleAfterFirstIdle(() => {
    const current = gates.get(routeKey);
    if (!current) return;
    current.cancelIdle = null;
    if (current.fallbackHandle) {
      clearTimeout(current.fallbackHandle);
      current.fallbackHandle = null;
    }
    current.passed = true;
    // The shell class rides the first page of the session, so the first route
    // to pass opens it permanently.
    if (!shellPassed) shellPassed = true;
    notify();
  }, idleTimeoutMs);
}

function ensureGate(routeKey: string): RouteGate {
  const existing = gates.get(routeKey);
  if (existing) return existing;
  const gate: RouteGate = {
    contentReady: false,
    passed: false,
    cancelIdle: null,
    fallbackHandle: null,
    hasPublisher: false,
  };
  gates.set(routeKey, gate);
  return gate;
}

/**
 * Marks a route visit as the current one, dropping every other visit's gate.
 *
 * Identity is the route key *plus* the visit: revisiting a path after a
 * navigation is a new visit and starts closed, because its query cache may be
 * gone and its data has to be fetched again. Dropping the other gates also
 * releases their timers.
 *
 * Publishers and consumers of the current navigation context can claim it.
 * An explicitly lagging consumer cannot evict the new page's publisher.
 */
function claimRoute(routeKey: string): void {
  if (currentRouteKey === routeKey) return;
  currentRouteKey = routeKey;
  for (const [key, gate] of [...gates]) {
    if (key === routeKey) continue;
    if (gate.fallbackHandle) clearTimeout(gate.fallbackHandle);
    gate.cancelIdle?.();
    gates.delete(key);
  }
  ensureGate(routeKey);
  notify();
}

/**
 * Arms the fallback for the current route if nothing has published readiness
 * for it yet. Called after the first commit of a route's consumers, which is the
 * point by which a publisher would have registered.
 */
function armFallbackIfPublisherless(routeKey: string): void {
  const gate = gates.get(routeKey);
  if (!gate || gate.hasPublisher || gate.passed || gate.contentReady || gate.fallbackHandle) return;
  gate.fallbackHandle = setTimeout(() => {
    const current = gates.get(routeKey);
    if (!current || current.passed || current.contentReady || current.hasPublisher) return;
    current.contentReady = true;
    scheduleGateIdle(routeKey);
  }, contentFallbackMs);
}

/**
 * Publishes "the main content of `routeKey` has settled" for pages that render
 * their own terminal state. Safe to call repeatedly; only the first call for a
 * visit has an effect.
 */
export function markRouteContentReady(routeKey: string): void {
  if (!routeKey) return;
  claimRoute(routeKey);
  const gate = gates.get(routeKey);
  if (!gate || gate.passed || gate.contentReady) return;
  gate.contentReady = true;
  if (gate.fallbackHandle) {
    clearTimeout(gate.fallbackHandle);
    gate.fallbackHandle = null;
  }
  scheduleGateIdle(routeKey);
}

/**
 * Records that `routeKey` mounts a readiness publisher, and disarms the
 * fallback timer for it.
 *
 * Called on each committed route by {@link useRouteContentReady}, including the ones
 * where `ready` is false: a page that is still loading has told us it will say
 * so when it settles, which is exactly when the timer must not speak for it.
 */
export function markRouteHasContentPublisher(routeKey: string): void {
  if (!routeKey) return;
  claimRoute(routeKey);
  const gate = gates.get(routeKey);
  if (!gate) return;
  gate.hasPublisher = true;

  if (gate.fallbackHandle) {
    clearTimeout(gate.fallbackHandle);
    gate.fallbackHandle = null;
  }
}

/**
 * Publisher half: a page reports whether its own main content has settled.
 *
 * `ready` must be true for success, empty and failure alike — the ruling is
 * explicit that a failed list still opens the gate — and false while the page
 * is still loading or showing `keepPreviousData` rows from another filter.
 */
export function useRouteContentReady(routeKey: string, ready: boolean): void {
  useLayoutEffect(() => {
    markRouteHasContentPublisher(routeKey);
  }, [routeKey]);
  useEffect(() => {
    if (!routeKey) return;
    if (!ready) {
      // Still claim: a page whose content is merely pending is nevertheless the
      // route that is on screen, and its own gate is the one to keep.
      claimRoute(routeKey);
      return;
    }
    // Wait one frame so the commit that rendered the rows has painted. Without
    // this, the gate's queries can leave in the same commit as the content and
    // still beat it to the screen by a frame.
    let cancelled = false;
    const handle = requestAnimationFrame(() => {
      if (!cancelled) markRouteContentReady(routeKey);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [routeKey, ready]);
}

export interface UseAfterFirstScreenOptions {
  /**
   * Identity of the route being waited for. Views pass their navigation
   * `pathname`; the navigation store's `lastPath` is only a fallback, because
   * the guard writes it an effect later than the page renders.
   */
  routeKey?: string;
  /**
   * `"page"` (default) re-waits on every route change; `"shell"` waits once per
   * session. See the module comment for which queries belong to which class.
   */
  scope?: AfterFirstScreenScope;
}

/**
 * `true` once this route's main content settled and the following idle callback
 * fired (or the fallback timer elapsed).
 *
 * Consumers gate their queries on the return value:
 *
 *   const afterFirstScreen = useAfterFirstScreen({ routeKey: pathname });
 *   useQuery({ ...somethingOptions(), enabled: afterFirstScreen });
 *
 * Gated queries keep cached data; only the network request moves.
 */
export function useAfterFirstScreen(
  options: UseAfterFirstScreenOptions = {},
): boolean {
  const storedPath = useNavigationStore((state) => state.lastPath);
  const renderedPath = useContext(RouteContext);
  const routeKey = options.routeKey ?? renderedPath ?? storedPath ?? "";
  const scope = options.scope ?? "page";

  useEffect(() => {
    if (!routeKey) return;
    // With a navigation provider every subscriber sees the same pathname. A
    // publisher claims it in layout; otherwise consumers own fallback routes.
    if (renderedPath && renderedPath !== routeKey) return;
    claimRoute(routeKey);
    const handle = setTimeout(() => armFallbackIfPublisherless(routeKey), 0);
    return () => clearTimeout(handle);
  }, [routeKey, renderedPath]);

  const getSnapshot = useCallback((): boolean => {
    if (scope === "shell") return shellPassed;
    if (renderedPath && renderedPath !== routeKey) return false;
    if (!routeKey) return false;
    // Not "has any route passed": an unvisited route has no gate yet, which is
    // exactly the `false` the new page's first render must observe.
    return gates.get(routeKey)?.passed === true;
  }, [routeKey, scope, renderedPath]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Test-only: shorten the two timers so a suite does not wait seconds. */
export function configureAfterFirstScreenForTest(options: {
  idleTimeoutMs?: number;
  contentFallbackMs?: number;
}): void {
  if (options.idleTimeoutMs !== undefined) idleTimeoutMs = options.idleTimeoutMs;
  if (options.contentFallbackMs !== undefined) contentFallbackMs = options.contentFallbackMs;
}

/** Test-only: drop every route gate, listener and timer. */
export function resetAfterFirstScreenForTest(): void {
  for (const gate of gates.values()) {
    if (gate.fallbackHandle) clearTimeout(gate.fallbackHandle);
    gate.cancelIdle?.();
  }
  gates.clear();
  shellPassed = false;
  currentRouteKey = null;
  idleTimeoutMs = AFTER_FIRST_SCREEN_IDLE_TIMEOUT_MS;
  contentFallbackMs = AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS;
}

/** Test-only: did a route publish that its main content settled? */
export function isRouteContentReadyForTest(routeKey: string): boolean {
  return gates.get(routeKey)?.contentReady === true;
}

/** Test-only: read the shell flag without mounting a consumer. */
export function isShellGatePassedForTest(): boolean {
  return shellPassed;
}
