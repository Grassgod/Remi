import { api } from "../api";
import { ApiError } from "../api/http";
import { openBrowserReplica, type BrowserReplica, type BrowserReplicaOptions } from "../replica/browser";
import { ReplicaView } from "../replica/view";
import type { SessionLogEntry } from "../replica/port";
import type { IssueLogBootstrap, SessionLogRow, SessionLogWindow } from "../api/schemas/session-log";
import { SessionLogEntrySchema } from "../api/schemas/session-log";
import type { HubFrame, HubSeqRange } from "@multiremi/contracts/live-hub";
import { createSafeId } from "../utils";
import { issueActivityLayer, type IssueActivityEntry } from "@multiremi/contracts/issue-activity";

/** A bounded presentation window over C7; persisted coverage may be sparse. */
export class IssueLogReplica extends ReplicaView {
  window: SessionLogWindow | null = null;
  headRow: SessionLogRow | null = null;
  missingCommentId: string | null = null;
  private browser: BrowserReplica | null = null;
  private disconnected = false;
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;
  private targetCommentId: string | null = null;
  private knownWindows: Array<{ range: HubSeqRange; entries: SessionLogRow[] }> = [];
  private frameQueue: Promise<void> = Promise.resolve();

  constructor(readonly sessionId: string, initial?: IssueLogBootstrap, private readonly preferCached = false,
    private readonly withActivity = false) {
    super();
    if (initial?.sessionId === sessionId) {
      this.targetCommentId = initial.targetCommentId ?? null;
      this.missingCommentId = initial.missingCommentId ?? null;
      this.accept(initial.window, initial.head);
    }
  }

  accept(window: SessionLogWindow, head: SessionLogRow | null = this.headRow): void {
    this.window = window;
    this.headRow = head;
    this.from = window.entries.find(e => e.seq > 0)?.seq ?? 0;
    this.to = window.has_more_after ? window.entries.at(-1)?.seq ?? 0 : Number.MAX_SAFE_INTEGER;
    const entries = this.displayRows(window.entries);
    this.setWindow(this.sessionId, entries, { head: window.head_seq, fresh: true, ready: true });
    const end = window.entries.at(-1)?.seq;
    if (end !== undefined) this.knownWindows.push({ range: { from: window.entries[0]!.seq, to: end }, entries: window.entries });
    this.knownWindows = this.knownWindows.slice(-32);
  }

  private displayRows(entries: readonly SessionLogEntry[]): SessionLogEntry[] {
    const rows = entries.filter(e => e.seq > 0 && e.seq >= this.from && e.seq <= this.to
      && e.kind !== "thread_resolved" && e.kind !== "thread_unresolved");
    return this.headRow ? [this.headRow, ...rows.slice(-299)] : rows.slice(-300);
  }

  async loadTail(): Promise<void> {
    await this.readTail();
  }

  /** Activities are presentation data; they never enter C7 or its seq coverage. */
  appendActivity(activity: IssueActivityEntry): void {
    if (!this.withActivity || !this.window || this.window.has_more_after || !issueActivityLayer(activity.action)) return;
    if (this.window.activities?.some(entry => entry.id === activity.id)) return;
    this.window = { ...this.window, activities: mergeActivities(this.window.activities, [activity]) };
    const snapshot = this.getSnapshot(this.sessionId);
    this.setWindow(this.sessionId, [...snapshot.entries], { head: snapshot.head, fresh: snapshot.fresh, ready: snapshot.ready });
  }

  private activityParams(): { with_activity?: 1 } { return this.withActivity ? { with_activity: 1 } : {}; }

  private async readTail(missingCommentId?: string): Promise<void> {
    const [window, head] = await Promise.all([
      api.getSessionLog(this.sessionId, { before: 30, ...this.activityParams() }),
      api.getSessionLog(this.sessionId, { anchor: 0, before: 1 }),
    ]);
    if (this.disconnected || (missingCommentId && this.targetCommentId !== missingCommentId)) return;
    this.targetCommentId = null;
    if (missingCommentId) this.missingCommentId = missingCommentId;
    this.accept(window, head.entries.find(e => e.seq === 0) ?? null);
    await this.persist(window);
  }

  hasWindowFor(commentId?: string): boolean {
    if (!this.window) return false;
    if (commentId && this.missingCommentId === commentId) return this.targetCommentId === null;
    return this.targetCommentId === (commentId ?? null) && (!commentId
      || this.getSnapshot(this.sessionId).entries.some(entry => entry.id === commentId));
  }

  async loadAround(commentId: string, preserveWindow = false): Promise<void> {
    const previous = preserveWindow && this.withActivity ? this.window : null;
    this.targetCommentId = commentId;
    this.missingCommentId = null;
    if (!preserveWindow) {
      this.window = null;
      this.setWindow(this.sessionId, [], { fresh: false, ready: false });
    }
    let location;
    try {
      location = await api.locateSessionLogEntry(this.sessionId, commentId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      if (this.disconnected || this.targetCommentId !== commentId) return;
      // Publish the missing target together with the ready tail so consumers
      // choose the bottom anchor before revealing any fallback rows.
      await this.readTail(commentId);
      return;
    }
    const [window, head] = await Promise.all([
      api.getSessionLog(this.sessionId, { anchor: location.seq, before: 15, after: 15, ...this.activityParams() }),
      api.getSessionLog(this.sessionId, { anchor: 0, before: 1 }),
    ]);
    if (this.disconnected || this.targetCommentId !== commentId) return;
    const keepsOlder = previous && (previous.entries[0]?.seq ?? Infinity) < (window.entries[0]?.seq ?? Infinity);
    const keepsNewer = previous && (previous.entries.at(-1)?.seq ?? 0) > (window.entries.at(-1)?.seq ?? 0);
    this.accept(previous ? { ...window, ...mergeActivityWindows(previous, window),
      entries: mergeRefreshedRows(previous.entries, window),
      ...(keepsOlder ? { has_more_before: previous.has_more_before, prev_entry_created_at: previous.prev_entry_created_at,
        before_visible_count: previous.before_visible_count, before_visible_count_capped: previous.before_visible_count_capped } : {}),
      ...(keepsNewer ? { has_more_after: previous.has_more_after } : {}),
    } : window, head.entries.find(e => e.seq === 0) ?? null);
    await this.persist(window);
  }

  async refreshVisible(): Promise<void> {
    if (this.targetCommentId) await this.loadAround(this.targetCommentId, true);
    else if (this.withActivity && this.window) await this.refreshTailPreservingWindow();
    else await this.loadTail();
  }

  /** Refresh the tail without collapsing an expanded history window. */
  async refreshTailPreservingWindow(): Promise<void> {
    if (!this.window || this.targetCommentId) { await this.refreshVisible(); return; }
    const current = this.window;
    const tail = await api.getSessionLog(this.sessionId, { before: 30, ...this.activityParams() });
    if (this.disconnected || this.window !== current) return;
    const last = current.entries.at(-1)?.seq ?? 0;
    const firstNew = tail.entries.find(entry => entry.seq > last)?.seq;
    let bridge: SessionLogRow[] = [];
    let activityWindow = mergeActivityWindows(current, tail);
    if (this.withActivity) {
      // Refresh the loaded prefix too: a union of old log rows would retain
      // deleted comments. Activities are immutable and still merge by id.
      let cursor = (current.entries.find(entry => entry.seq > 0)?.seq ?? 1) - 1;
      const firstTail = tail.entries.find(entry => entry.seq > 0)?.seq ?? tail.head_seq + 1;
      while (cursor < firstTail - 1) {
        const page = await api.getSessionLog(this.sessionId, { anchor: cursor, after: 100, ...this.activityParams() });
        bridge = mergeRows(bridge, page.entries.filter(entry => entry.seq > 0 && entry.seq < firstTail));
        activityWindow = mergeActivityWindows({ ...current, ...activityWindow }, page);
        const next = page.entries.at(-1)?.seq;
        if (!page.has_more_after || next === undefined || next <= cursor) break;
        cursor = next;
      }
    } else if (firstNew !== undefined && firstNew > last + 1) {
      bridge = (await this.readRange(this.sessionId, { from: last + 1, to: firstNew - 1 }))
        .map(entry => SessionLogEntrySchema.parse(entry));
    }
    if (this.disconnected || this.window !== current) return;
    this.accept({ ...tail,
      ...activityWindow, prev_entry_created_at: current.prev_entry_created_at,
      entries: mergeRows(this.withActivity ? bridge : mergeRows(current.entries, bridge), tail.entries),
      has_more_before: current.has_more_before,
      before_visible_count: current.before_visible_count,
      before_visible_count_capped: current.before_visible_count_capped,
    }, tail.entries.find(entry => entry.seq === 0) ?? this.headRow);
    await this.persist(tail);
  }

  async earlier(): Promise<void> {
    const first = this.window?.entries.find(e => e.seq > 0)?.seq;
    if (first === undefined) return;
    const older = await api.getSessionLog(this.sessionId, { anchor: first - 1, before: 30, ...this.activityParams() });
    if (this.disconnected || !this.window) return;
    this.accept({ ...this.window, entries: mergeRows(older.entries, this.window.entries),
      ...mergeActivityWindows(older, this.window), prev_entry_created_at: older.prev_entry_created_at,
      has_more_before: older.has_more_before, before_visible_count: older.before_visible_count,
      before_visible_count_capped: older.before_visible_count_capped });
    await this.persist(older);
  }

  async newer(): Promise<void> {
    const last = this.window?.entries.at(-1)?.seq;
    if (last === undefined) return;
    const newer = await api.getSessionLog(this.sessionId, { anchor: last, after: 30, ...this.activityParams() });
    if (this.disconnected || !this.window) return;
    this.accept({ ...this.window, entries: mergeRows(this.window.entries, newer.entries),
      ...mergeActivityWindows(this.window, newer),
      head_seq: newer.head_seq, log_version: newer.log_version, has_more_after: newer.has_more_after });
    await this.persist(newer);
  }

  async refreshHead(): Promise<void> {
    const head = await api.getSessionLog(this.sessionId, { anchor: 0, before: 1 });
    if (this.disconnected || !this.window) return;
    this.accept(this.window, head.entries.find(e => e.seq === 0) ?? null);
    await this.persist(head);
  }

  async connect(options: Pick<BrowserReplicaOptions, "userId" | "workspaceId" | "subscribe" | "unsubscribe" | "env">): Promise<() => void> {
    this.disconnected = false;
    const browser = await openBrowserReplica({ ...options, tabId: createSafeId(), readRange: (id, range) => this.readRange(id, range) });
    if (this.disconnected) { browser.dispose(); return () => {}; }
    this.browser = browser;
    const update = () => {
      const snapshot = browser.port.getSnapshot(this.sessionId);
      const visible = this.getSnapshot(this.sessionId);
      if (!snapshot.ready) return;
      const current = snapshot.entries.map(e => SessionLogEntrySchema.safeParse(e))
        .filter(p => p.success).map(p => p.data!);
      // C7 may contain raw Hub entries from an earlier tab or version. The
      // read route supplies attachment metadata, so never paint raw rows first.
      const displayable = current.filter(e => (e.kind !== "message" && e.kind !== "turn")
        || Array.isArray((e.metadata as Record<string, unknown> | undefined)?.attachments));
      if (!this.window) {
        if (!this.preferCached) return;
        if (displayable.length !== current.length) return;
        const cached = displayable.filter(entry => entry.seq > 0).slice(-30);
        this.accept({ entries: cached, head_seq: Math.max(0, snapshot.head ?? 0), log_version: 0,
          has_more_before: (cached[0]?.seq ?? 0) > 1, has_more_after: false },
          displayable.find(entry => entry.seq === 0) ?? null);
        this.setWindow(this.sessionId, this.getSnapshot(this.sessionId).entries, {
          head: snapshot.head, fresh: snapshot.fresh, ready: true,
        });
        return;
      }
      const held = current.find(e => e.seq === 0);
      if (held && held.revision >= (this.headRow?.revision ?? 0)) this.headRow = held;
      const rows = mergeRows(visible.entries.map(e => SessionLogEntrySchema.parse(e)), displayable);
      const newerHead = (snapshot.head ?? -1) > (visible.head ?? -1);
      this.setWindow(this.sessionId, this.displayRows(rows), {
        head: Math.max(visible.head ?? 0, snapshot.head ?? 0),
        fresh: newerHead ? snapshot.fresh : visible.fresh || snapshot.fresh, ready: true,
      });
    };
    const off = browser.port.subscribe(this.sessionId, update);
    browser.open(this.sessionId);
    update();
    if (this.window) await this.persist(this.window);
    return () => { off(); browser.close(this.sessionId); browser.dispose(); if (this.browser === browser) this.browser = null; };
  }

  frames(...args: Parameters<BrowserReplica["frames"]>): void { this.browser?.frames(...args); }
  /** Read-side metadata is authoritative for attachments and reactions. */
  hydratedFrames(sessionId: string, frames: readonly HubFrame[]): Promise<void> {
    const job = this.frameQueue.then(async () => {
      const hydrated = await Promise.all(frames.map(async frame => {
        if (frame.kind !== "entry" || !frame.payload || typeof frame.payload !== "object") return frame;
        const payload = frame.payload as Record<string, unknown>;
        if (payload.kind !== "message" && payload.kind !== "turn") return frame;
        const window = await api.getSessionLog(sessionId, { anchor: frame.seq, before: 1, after: 0 });
        const entry = window.entries.find(row => row.seq === frame.seq && row.id === payload.id);
        if (!entry) throw new Error(`Log entry ${frame.seq} was unavailable for hydration`);
        return { ...frame, payload: entry };
      }));
      if (!this.disconnected) this.frames(sessionId, hydrated);
    });
    this.frameQueue = job.catch(() => {});
    return job;
  }
  ack(...args: Parameters<BrowserReplica["ack"]>): void { this.browser?.ack(...args); }
  disconnect(): void { this.disconnected = true; this.browser?.dispose(); this.browser = null; }

  override readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.browser?.port.readRowHeight(sessionId, seq, key) ?? super.readRowHeight(sessionId, seq, key);
  }
  override writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    super.writeRowHeight(sessionId, seq, key, height);
    this.browser?.port.writeRowHeight(sessionId, seq, key, height);
  }

  private async persist(window: SessionLogWindow): Promise<void> {
    const browser = this.browser;
    if (!browser || !window.entries.length) return;
    if (this.headRow) {
      this.knownWindows.push({ range: { from: 0, to: 0 }, entries: [this.headRow] });
      await browser.loadWindow(this.sessionId, { from: 0, to: 0 });
    }
    if (this.disconnected) return;
    await browser.loadWindow(this.sessionId, { from: window.entries[0]!.seq, to: window.entries.at(-1)!.seq });
  }

  private async readRange(sessionId: string, range: HubSeqRange): Promise<SessionLogEntry[]> {
    const seed = this.knownWindows.findLast(w => w.range.from <= range.from && w.range.to >= range.to);
    if (seed) return seed.entries.filter(e => e.seq >= range.from && e.seq <= range.to);
    const rows: SessionLogRow[] = [];
    let cursor = range.from - 1;
    while (cursor < range.to) {
      const window = await api.getSessionLog(sessionId, { anchor: Math.max(0, cursor), after: 100 });
      rows.push(...window.entries.filter(e => e.seq >= range.from && e.seq <= range.to));
      const next = window.entries.at(-1)?.seq;
      if (!window.has_more_after || next === undefined || next <= cursor) break;
      cursor = next;
    }
    return rows;
  }
}

function mergeRows(left: SessionLogRow[], right: SessionLogRow[]): SessionLogRow[] {
  const rows = new Map(left.map(e => [e.seq, e]));
  for (const row of right) if ((rows.get(row.seq)?.revision ?? -1) <= row.revision) rows.set(row.seq, row);
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

function mergeRefreshedRows(previous: SessionLogRow[], window: SessionLogWindow): SessionLogRow[] {
  const first = window.has_more_before ? window.entries[0]?.seq ?? Infinity : 0;
  const last = window.has_more_after ? window.entries.at(-1)?.seq ?? -1 : Infinity;
  return mergeRows(previous.filter(entry => entry.seq < first || entry.seq > last), window.entries);
}

function mergeActivities(left: IssueActivityEntry[] = [], right: IssueActivityEntry[] = []): IssueActivityEntry[] {
  return [...new Map([...left, ...right].map(entry => [entry.id, entry])).values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
function mergeActivityWindows(left: SessionLogWindow, right: SessionLogWindow): Pick<SessionLogWindow, "activities" | "activities_truncated"> {
  return left.activities || right.activities ? {
    activities: mergeActivities(left.activities, right.activities),
    activities_truncated: Boolean(left.activities_truncated || right.activities_truncated),
  } : {};
}
