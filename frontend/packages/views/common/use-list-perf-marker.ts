"use client";

import { useEffect, useState } from "react";
import { useNavigation } from "../navigation";
import { useRouteContentReady } from "@multiremi/core/platform/use-after-first-screen";

/**
 * List-page readiness marker (MUL-472 item 5).
 *
 * MUL-383's probe resolves `--selectors auto` from the document: it measures
 * through the contract table only when a `[data-perf-scroll]` element exists
 * (`frontend/scripts/perf/lib/selectors.ts`, `jump-recorder.ts`). The detail and
 * chat routes carry one; the list pages had none, so every list round in both
 * 09-28 baselines (32/32 rows) fell back to the legacy table and a fast list
 * round could not be told apart from a skeleton-free render of rows nobody had
 * confirmed were new.
 *
 * The marker is the same attribute the probe already looks for, on the page's
 * own list container, and it is published **only after this page's own list
 * request resolved**. Its presence therefore means "the rows on screen are the
 * answer to a request this page issued", which is exactly what the probe needs
 * to certify a list round. Nothing else changes: no styles, no layout, no
 * behaviour, and the `data-perf-state` / `data-perf-fresh` pair stays owned by
 * `useAnchoredReveal` (MUL-443) — this marker never writes them.
 */
export const LIST_PERF_MARKER_ATTRIBUTE = "data-perf-scroll";
export const LIST_PERF_MARKER_VALUE = "list";

export interface ListPerfMarkerSource {
  /**
   * `status` straight off the page's own list query (`useQuery` or
   * `useInfiniteQuery`). `success` means a response resolved for this page;
   * combined with `isPlaceholderData === false` it also means the rendered rows
   * are that response's rows rather than `keepPreviousData` leftovers.
   */
  status: "pending" | "error" | "success";
  /** `keepPreviousData` rows belong to the previous filter or sort. */
  isPlaceholderData?: boolean;
}

/** `true` when the rendered rows came from this page's own resolved response. */
export function listPerfFresh(source: ListPerfMarkerSource): boolean {
  return source.status === "success" && !source.isPlaceholderData;
}

export type ListPerfMarkerProps = Record<typeof LIST_PERF_MARKER_ATTRIBUTE, "list"> | null;

/**
 * @returns The marker spread onto the list container, or `null` while the page
 *   has no confirmed-fresh rows (loading, error, or placeholder data).
 *
 * The `mounted` gate keeps the attribute out of the first client render so a
 * warm query-cache cannot produce a hydration mismatch against the server's
 * HTML; the marker appears one commit later, still in the same paint as the
 * rows it describes.
 *
 * This predicate is also the app's own "this list page's main content settled"
 * signal, so it publishes to the request gate (MUL-472 b rework): the deferred
 * shell queries must not leave before the rows the user is waiting for have
 * arrived. `pending` and `keepPreviousData` do not publish; success (including
 * an empty list) and failure both do — a broken request must not hold the
 * deferred content back forever.
 */
export function useListPerfMarker(source: ListPerfMarkerSource): ListPerfMarkerProps {
  const [mounted, setMounted] = useState(false);
  const { pathname } = useNavigation();
  useEffect(() => {
    setMounted(true);
  }, []);
  const settled = source.status !== "pending" && !source.isPlaceholderData;
  useRouteContentReady(pathname, settled);
  return mounted && listPerfFresh(source)
    ? { [LIST_PERF_MARKER_ATTRIBUTE]: LIST_PERF_MARKER_VALUE }
    : null;
}
