import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatLogPool, CHAT_LOG_POOL_TTL_MS, chatLogScope, type RetainedLog } from "./chat-log-pool";

const HOUR = 60 * 60 * 1000;
const fakeLog = () => ({ trimRetained: vi.fn(), dispose: vi.fn() }) satisfies RetainedLog;
type FakeLog = ReturnType<typeof fakeLog>;
const scope = chatLogScope("u", "w")!;

describe("ChatLogPool", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  /** Lease and release one log per chat, a minute apart. */
  function releaseAll(pool: ChatLogPool<FakeLog>, ids: string[]): Map<string, FakeLog> {
    const logs = new Map<string, FakeLog>();
    for (const id of ids) {
      const log = fakeLog();
      logs.set(id, log);
      pool.acquire(scope, id, log)!.release();
      vi.advanceTimersByTime(60_000);
    }
    return logs;
  }

  it("keeps the 10 most recently released logs and disposes the least recent first", () => {
    const pool = new ChatLogPool<FakeLog>();
    const ids = Array.from({ length: 12 }, (_, n) => `chat-${n}`);
    const logs = releaseAll(pool, ids);
    expect(pool.size).toBe(10);
    expect(logs.get("chat-0")!.dispose).toHaveBeenCalledOnce();
    expect(logs.get("chat-1")!.dispose).toHaveBeenCalledOnce();
    expect(pool.peek(scope, "chat-0")).toBeUndefined();
    for (const id of ids.slice(2)) {
      expect(logs.get(id)!.dispose).not.toHaveBeenCalled();
      expect(pool.peek(scope, id)).toBe(logs.get(id));
    }
    // Showing a chat again makes it the most recent release.
    pool.acquire(scope, "chat-2", logs.get("chat-2")!)!.release();
    releaseAll(pool, ["chat-new"]);
    expect(logs.get("chat-2")!.dispose).not.toHaveBeenCalled();
    expect(logs.get("chat-3")!.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a released log 3 h after its release", () => {
    const pool = new ChatLogPool<FakeLog>();
    const log = fakeLog();
    pool.acquire(scope, "a", log)!.release();
    vi.advanceTimersByTime(CHAT_LOG_POOL_TTL_MS - 1);
    expect(log.dispose).not.toHaveBeenCalled();
    expect(pool.peek(scope, "a")).toBe(log);
    vi.advanceTimersByTime(1);
    expect(log.dispose).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("never evicts a leased log, by count or by age", () => {
    const pool = new ChatLogPool<FakeLog>();
    const held = fakeLog();
    const lease = pool.acquire(scope, "held", held)!;
    releaseAll(pool, Array.from({ length: 12 }, (_, n) => `chat-${n}`));
    vi.advanceTimersByTime(5 * HOUR);
    expect(held.dispose).not.toHaveBeenCalled();
    expect(pool.peek(scope, "held")).toBe(held);
    expect(pool.size).toBe(1);
    // The age counts from its release.
    lease.release();
    expect(held.trimRetained).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(CHAT_LOG_POOL_TTL_MS - 1);
    expect(held.dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(held.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a released log while its chat has a running turn", () => {
    const pool = new ChatLogPool<FakeLog>();
    const running = new Set(["busy"]);
    pool.setBusy(id => running.has(id));
    const logs = releaseAll(pool, ["busy", ...Array.from({ length: 10 }, (_, n) => `chat-${n}`)]);
    vi.advanceTimersByTime(4 * HOUR);
    expect(logs.get("busy")!.dispose).not.toHaveBeenCalled();
    expect(logs.get("chat-0")!.dispose).toHaveBeenCalledOnce();
    running.clear();
    pool.setBusy(id => running.has(id));
    expect(logs.get("busy")!.dispose).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("leases a log once and reports whether it was retained", () => {
    const pool = new ChatLogPool<FakeLog>();
    const log = fakeLog();
    const first = pool.acquire(scope, "a", log)!;
    expect(first.retained).toBe(false);
    // One connection per log: another holder, or another log for the chat, is refused.
    expect(pool.acquire(scope, "a", log)).toBeNull();
    expect(pool.acquire(scope, "a", fakeLog())).toBeNull();
    first.release();
    first.release();
    expect(log.trimRetained).toHaveBeenCalledOnce();
    expect(pool.acquire(scope, "a", fakeLog())).toBeNull();
    const again = pool.acquire(scope, "a", log)!;
    expect(again.retained).toBe(true);
    expect(again.replica).toBe(log);
  });

  it("disposes every log when the user or workspace changes", () => {
    const pool = new ChatLogPool<FakeLog>();
    const held = fakeLog();
    const lease = pool.acquire(scope, "held", held)!;
    const logs = releaseAll(pool, ["a", "b"]);
    const listener = vi.fn();
    pool.subscribe(listener);
    pool.setScope(chatLogScope("u", "other-workspace"));
    expect(listener).toHaveBeenCalled();
    expect(logs.get("a")!.dispose).toHaveBeenCalledOnce();
    expect(logs.get("b")!.dispose).toHaveBeenCalledOnce();
    expect(pool.peek(scope, "held")).toBeUndefined();
    // The leased log is still on screen; it goes when it is released.
    expect(held.dispose).not.toHaveBeenCalled();
    lease.release();
    expect(held.dispose).toHaveBeenCalledOnce();
    expect(held.trimRetained).not.toHaveBeenCalled();
    // Leasing under another identity clears the previous one the same way.
    const next = chatLogScope("v", "other-workspace")!;
    const other = fakeLog();
    pool.acquire(chatLogScope("u", "other-workspace")!, "x", other)!.release();
    pool.acquire(next, "y", fakeLog());
    expect(other.dispose).toHaveBeenCalledOnce();
    expect(pool.peek(next, "x")).toBeUndefined();
  });
});
