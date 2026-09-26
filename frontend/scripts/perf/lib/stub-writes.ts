/**
 * The write guard's explicit allow-list, and the response rewrite that makes the
 * allowed writes terminate.
 *
 * The probe runs against production read-only: every non-GET/HEAD `/api/**`
 * request is aborted inside `page.route()`. That guarantee stays. What changed is
 * that one endpoint is now *stubbed* rather than aborted, because aborting it does
 * not simulate a user — it creates a failure loop that the app never leaves:
 *
 *  - `inbox-page.tsx` auto-marks the selected notification read through
 *    `useMarkInboxItemsRead` (`core/inbox/mutations.ts`), which optimistically
 *    sets `read: true`, and on error restores the cache and invalidates the inbox.
 *  - A restored `read: false` makes the effect fire again, so one click produced
 *    55-100 aborted `POST /api/inbox/:id/read` calls and delayed the URL commit
 *    from 181ms to ~5s (measured on 209, MUL-384 `cmt_cxrxocj4vp3q`).
 *
 * Stubbing the POST alone is not enough: the mutation has no `onSuccess`, so the
 * loop only ends when the next `/api/inbox/page` response reports `read: true` for
 * that item. That is `rewriteInboxReadState` below. Nothing leaves the browser —
 * the stub fulfills inside the page's own route handler, so the server still sees
 * no writes at all.
 */

/** One allowed write: method, path pattern and how its response is produced. */
export interface StubbedWriteRule {
  method: string;
  /** Matches the pathname only, e.g. `/api/inbox/inb_123/read`. */
  pattern: RegExp;
  /** Report-facing shape of the pattern, with ids masked to `:id`. */
  label: string;
  /** Why this endpoint is stubbed instead of aborted. */
  reason: string;
}

/**
 * The allow-list. Deliberately one entry: a second entry is a measurement-contract
 * change and belongs in `docs/dev/performance.md` first.
 */
export const STUBBED_WRITES: readonly StubbedWriteRule[] = Object.freeze([
  {
    method: "POST",
    pattern: /^\/api\/inbox\/[^/]+\/read$/,
    label: "POST /api/inbox/:id/read",
    reason:
      "auto mark-read is unavoidable on any selection and its abort loop delays the URL commit past the assertion window",
  },
]);

/** Pathname of a URL, or the input unchanged when it cannot be parsed. */
export function pathnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    const withoutQuery = rawUrl.split("?")[0] ?? rawUrl;
    return withoutQuery.replace(/^https?:\/\/[^/]+/, "");
  }
}

/** True when this request is stubbed rather than aborted. */
export function isStubbedWrite(method: string, rawUrl: string): boolean {
  const pathname = pathnameOf(rawUrl);
  return STUBBED_WRITES.some((rule) => rule.method === method.toUpperCase() && rule.pattern.test(pathname));
}

/** The inbox item id inside `POST /api/inbox/<id>/read`, or null. */
export function stubbedWriteItemId(rawUrl: string): string | null {
  const match = /^\/api\/inbox\/([^/]+)\/read$/.exec(pathnameOf(rawUrl));
  return match ? decodeURIComponent(match[1]!) : null;
}

/** GET endpoints whose bodies carry per-item `read` flags. */
export function isInboxReadStateEndpoint(method: string, rawUrl: string): boolean {
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") return false;
  const pathname = pathnameOf(rawUrl);
  return pathname === "/api/inbox" || pathname === "/api/inbox/page";
}

/**
 * Marks every already-stubbed item as read in an inbox response body.
 *
 * Applies to both shapes this endpoint serves: `/api/inbox` returns a bare array,
 * `/api/inbox/page` wraps it in `{ items, ... }`. `unread-count` and `summary` are
 * deliberately *not* rewritten — they only feed the sidebar badge, so leaving them
 * alone keeps the probe's footprint smaller, and no other code reads `read` from
 * them.
 *
 * Returns a new object; the input is never mutated, because the same body object
 * can be reused by the caller for the "before" snapshot.
 */
export function rewriteInboxReadState(
  body: unknown,
  stubbedIds: ReadonlySet<string>,
): unknown {
  if (stubbedIds.size === 0) return body;
  if (Array.isArray(body)) return body.map((item) => rewriteItem(item, stubbedIds));
  if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    const page = body as { items: unknown[] };
    return { ...page, items: page.items.map((item) => rewriteItem(item, stubbedIds)) };
  }
  return body;
}

function rewriteItem(item: unknown, stubbedIds: ReadonlySet<string>): unknown {
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  if (!id || !stubbedIds.has(id)) return item;
  return { ...record, read: true };
}

/** Every item in an inbox response body, for the stub's own response payload. */
export function inboxItemsFromBody(body: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : [];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

/**
 * Whether the stub loop failed to terminate.
 *
 * Every stubbed call should settle its item: one POST per unread id, plus at most
 * one retry. More than `2 x` the unread id count means the rewrite did not take
 * effect — the page is still being told `read: false` somewhere — so the round is
 * abandoned with `stub-loop-not-terminated` rather than measured inside a failure
 * loop. A tie goes to passing, because one retry per id is legitimate.
 */
export function stubLoopNotTerminated(stubbedCalls: number, unreadIdCount: number): boolean {
  return stubbedCalls > 2 * unreadIdCount;
}

/** The body the stubbed POST answers with: the snapshot item, marked read. */
export function stubbedReadResponseBody(
  itemId: string,
  snapshot: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const item = snapshot.get(itemId);
  // The mutation has no `onSuccess`, so the body is never consumed; it still has
  // to be legal JSON with the shape the endpoint promises.
  return item ? { ...item, read: true } : { id: itemId, read: true };
}
