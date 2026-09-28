import { api } from "../api";
import { openBrowserReplica, type BrowserReplica, type BrowserReplicaOptions } from "../replica/browser";
import { ReplicaView } from "../replica/view";
import type { SessionLogEntry } from "../replica/port";
import type { IssueLogBootstrap, SessionLogRow, SessionLogWindow } from "../api/schemas/session-log";
import { SessionLogEntrySchema } from "../api/schemas/session-log";
import type { HubSeqRange } from "@multiremi/contracts/live-hub";

/** A bounded presentation window over C7; persisted coverage may be sparse. */
export class IssueLogReplica extends ReplicaView {
  window: SessionLogWindow | null = null;
  headRow: SessionLogRow | null = null;
  private browser: BrowserReplica | null = null;
  private disconnected = false;
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;
  private knownWindows: Array<{ range: HubSeqRange; entries: SessionLogRow[] }> = [];

  constructor(readonly sessionId: string, initial?: IssueLogBootstrap) {
    super();
    if (initial?.sessionId === sessionId) this.accept(initial.window, initial.head);
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
    const [window, head] = await Promise.all([
      api.getSessionLog(this.sessionId, { before: 30 }),
      api.getSessionLog(this.sessionId, { anchor: 0, before: 1 }),
    ]);
    if (this.disconnected) return;
    this.accept(window, head.entries.find(e => e.seq === 0) ?? null);
    await this.persist(window);
  }

  async earlier(): Promise<void> {
    const first = this.window?.entries.find(e => e.seq > 0)?.seq;
    if (first === undefined) return;
    const older = await api.getSessionLog(this.sessionId, { anchor: first - 1, before: 30 });
    if (this.disconnected || !this.window) return;
    this.accept({ ...this.window, entries: mergeRows(older.entries, this.window.entries),
      has_more_before: older.has_more_before, before_visible_count: older.before_visible_count,
      before_visible_count_capped: older.before_visible_count_capped });
    await this.persist(older);
  }

  async refreshHead(): Promise<void> {
    const head = await api.getSessionLog(this.sessionId, { anchor: 0, before: 1 });
    if (this.disconnected || !this.window) return;
    this.accept(this.window, head.entries.find(e => e.seq === 0) ?? null);
    await this.persist(head);
  }

  async connect(options: Pick<BrowserReplicaOptions, "userId" | "workspaceId" | "subscribe" | "unsubscribe" | "env">): Promise<() => void> {
    this.disconnected = false;
    const browser = await openBrowserReplica({ ...options, tabId: crypto.randomUUID(), readRange: (id, range) => this.readRange(id, range) });
    if (this.disconnected) { browser.dispose(); return () => {}; }
    this.browser = browser;
    const update = () => {
      const snapshot = browser.port.getSnapshot(this.sessionId);
      const visible = this.getSnapshot(this.sessionId);
      // The C7 cache can answer before it has imported the SSR window.
      if (!snapshot.ready) return;
      const current = snapshot.entries.map(e => SessionLogEntrySchema.safeParse(e))
        .filter(p => p.success).map(p => p.data!);
      const held = current.find(e => e.seq === 0);
      if (held && held.revision >= (this.headRow?.revision ?? 0)) this.headRow = held;
      const rows = mergeRows(visible.entries.map(e => SessionLogEntrySchema.parse(e)), current);
      this.setWindow(this.sessionId, this.displayRows(rows), {
        head: Math.max(visible.head ?? 0, snapshot.head ?? 0),
        fresh: snapshot.head === visible.head ? snapshot.fresh : visible.fresh, ready: true,
      });
    };
    const off = browser.port.subscribe(this.sessionId, update);
    browser.open(this.sessionId);
    if (this.window) await this.persist(this.window);
    return () => { off(); browser.close(this.sessionId); browser.dispose(); if (this.browser === browser) this.browser = null; };
  }

  frames(...args: Parameters<BrowserReplica["frames"]>): void { this.browser?.frames(...args); }
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
    if (!this.browser || !window.entries.length) return;
    if (this.headRow) {
      this.knownWindows.push({ range: { from: 0, to: 0 }, entries: [this.headRow] });
      await this.browser.loadWindow(this.sessionId, { from: 0, to: 0 });
    }
    await this.browser.loadWindow(this.sessionId, { from: window.entries[0]!.seq, to: window.entries.at(-1)!.seq });
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
