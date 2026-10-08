/** Browser-only cursor-read simulation. Every other API write remains aborted. */
export interface StubbedWriteRule { method: string; pattern: RegExp; label: string; reason: string }
export const STUBBED_WRITES: readonly StubbedWriteRule[] = Object.freeze([
  { method: "POST", pattern: /^\/api\/inbox\/read$/, label: "POST /api/inbox/read",
    reason: "simulate explicit cursor reads locally; no write reaches the server" },
]);
export interface StubbedReadState { cursors: Map<string, number>; all: boolean }
export function pathnameOf(rawUrl: string): string {
  try { return new URL(rawUrl).pathname; } catch { return rawUrl.split("?")[0]!.replace(/^https?:\/\/[^/]+/, ""); }
}
export function isStubbedWrite(method: string, rawUrl: string): boolean {
  return STUBBED_WRITES.some(rule => rule.method === method.toUpperCase() && rule.pattern.test(pathnameOf(rawUrl)));
}
export function isInboxReadStateEndpoint(method: string, rawUrl: string): boolean {
  return ["GET", "HEAD"].includes(method.toUpperCase()) && pathnameOf(rawUrl) === "/api/inbox";
}
export function inboxItemsFromBody(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return [];
  return (body as { items: unknown[] }).items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}
export function rewriteInboxReadState(body: unknown, state: StubbedReadState): unknown {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return body;
  if (!state.all && !state.cursors.size) return body;
  const page = body as { items: Array<Record<string, unknown>>; unread_count: number; attention_count: number };
  const items = page.items.filter(item => !state.all && !(typeof item.session_id === "string" && typeof item.seq === "number" && item.seq <= (state.cursors.get(item.session_id) ?? -1)));
  // Only loaded messages can be subtracted for a single cursor. The report records
  // these as browser stubs, never as authoritative server counts.
  const removed = page.items.length - items.length;
  return { ...page, items, unread_count: state.all ? 0 : Math.max(0, page.unread_count - removed),
    attention_count: state.all ? 0 : page.attention_count };
}
export function stubbedReadResponseBody(input: unknown, snapshot: ReadonlyMap<string, Record<string, unknown>>, state: StubbedReadState): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("Invalid cursor read");
  const body = input as Record<string, unknown>;
  if (body.all === true) {
    if (body.session_id !== undefined || body.to_seq !== undefined) throw new Error("Conflicting cursor read");
    state.all = true;
    return { conversations_read: new Set([...snapshot.values()].map(item => item.session_id)).size };
  }
  if (typeof body.session_id !== "string" || !body.session_id || body.all !== undefined) throw new Error("Missing conversation");
  const head = Math.max(0, ...[...snapshot.values()].filter(item => item.session_id === body.session_id).map(item => typeof item.seq === "number" ? item.seq : 0));
  const seq = body.to_seq ?? head;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw new Error("Invalid cursor sequence");
  const cursor = Math.max(state.cursors.get(body.session_id) ?? 0, seq);
  state.cursors.set(body.session_id, cursor);
  return { session_id: body.session_id, cursor_seq: cursor };
}
export function stubLoopNotTerminated(stubbedCalls: number, explicitReadCount: number): boolean { return stubbedCalls > 2 * explicitReadCount; }
export interface InboxInjectionContext { hasCursor: boolean }
export function injectInboxTarget(body: unknown, target: Record<string, unknown> | null, context: InboxInjectionContext): unknown {
  if (!target || typeof target.id !== "string" || !body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return body;
  const page = body as { items: Array<Record<string, unknown>> };
  if (context.hasCursor) return { ...page, items: page.items.filter(item => item.id !== target.id) };
  return page.items.some(item => item.id === target.id) ? body : { ...page, items: [...page.items, target] };
}
