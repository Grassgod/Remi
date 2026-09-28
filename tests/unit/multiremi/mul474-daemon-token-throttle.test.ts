// MUL-474 (MUL-383 S8e) step 3: `last_used_at` is written at most once per token
// per minute, and nothing else about verification changes.
//
// The point of the throttle is to remove one UPDATE per daemon poll; the point of
// these cases is that "remove a write" did not quietly become "skip a check".
// Token lookup, revocation and expiry all still run on every call, on both the
// map-hit and the map-miss path.
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  lastUsedAtThrottlePeakSizeForTest,
  lastUsedAtThrottleSizeForTest,
  resetLastUsedAtThrottleForTest,
} from "@multiremi/store/repos/access-tokens-repo.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const TOKEN_CREATED_AT = Date.UTC(2026, 8, 27, 12, 0, 0);
/** The declared ceiling in access-tokens-repo.ts. */
const MAP_CAPACITY = 4_096;
const WINDOW_MS = 60_000;

beforeEach(() => {
  resetLastUsedAtThrottleForTest();
  setSystemTime(new Date(TOKEN_CREATED_AT));
});

afterEach(() => {
  setSystemTime();
  resetLastUsedAtThrottleForTest();
  resetMultiremiTestEnv();
});

function readLastUsedAt(tokenId: string): string | null {
  const row = db!.query("SELECT last_used_at FROM multiremi_access_tokens WHERE id = ?")
    .get(tokenId) as { last_used_at: string | null } | null;
  return row?.last_used_at ?? null;
}

function setLastUsedAt(tokenId: string, value: string | null): void {
  db!.run("UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?", [value, tokenId]);
}

async function mintedToken(store: MultiremiStore, name = "MUL-474 throttle"): Promise<{ id: string; token: string }> {
  const created = await store.createAccessToken({
    workspaceId: "local",
    userId: "local",
    name,
    type: "pat",
    expiresInDays: 30,
  });
  return { id: created.id, token: created.token };
}

describe("MUL-474 last_used_at write throttle", () => {
  it("writes once and then leaves the row alone for the rest of the window", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    expect(readLastUsedAt(id)).toBeNull();

    const first = await store.verifyAccessToken(token);
    expect(first?.lastUsedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    // Second verification 30 s later: same answer, no write.
    setSystemTime(new Date(TOKEN_CREATED_AT + 30_000));
    const second = await store.verifyAccessToken(token);
    expect(second?.lastUsedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  it("writes again once the window has passed", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    await store.verifyAccessToken(token);

    setSystemTime(new Date(TOKEN_CREATED_AT + 60_001));
    const later = await store.verifyAccessToken(token);
    expect(later?.lastUsedAt).toBe("2026-09-27T12:01:00.001Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:01:00.001Z");
  });

  // 59,999 and 60,000 are the two sides of the interval. The map-hit path is what
  // both runs above exercise; these pin the exact boundary values.
  it("does not write at 59,999ms and does write at 60,000ms", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    await store.verifyAccessToken(token);
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    setSystemTime(new Date(TOKEN_CREATED_AT + 59_999));
    expect((await store.verifyAccessToken(token))?.lastUsedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    setSystemTime(new Date(TOKEN_CREATED_AT + 60_000));
    expect((await store.verifyAccessToken(token))?.lastUsedAt).toBe("2026-09-27T12:01:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:01:00.000Z");
    void WINDOW_MS;
  });

  it("keeps two tokens' windows independent", async () => {
    const store = createLocalStore();
    const first = await mintedToken(store, "first");
    const second = await mintedToken(store, "second");

    await store.verifyAccessToken(first.token);
    expect(readLastUsedAt(first.id)).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(second.id)).toBeNull();

    // The second token has its own window: it stamps on its first use even while
    // the first token is inside its own.
    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    await store.verifyAccessToken(second.token);
    expect(readLastUsedAt(second.id)).toBe("2026-09-27T12:00:01.000Z");
    expect(readLastUsedAt(first.id)).toBe("2026-09-27T12:00:00.000Z");
  });

  // The capacity sweep evicts entries. An evicted token must still honour its
  // window, which it can only do by judging the `last_used_at` the row already
  // carries — that is the whole point of the database being the source of truth.
  it("honours the window for a token the capacity sweep has evicted", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store, "survivor");
    // Stamp it first, so the row carries t0 and the map holds its entry.
    await store.verifyAccessToken(token);
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    // Fill and evict: 5,000 distinct tokens, each verified so each takes a slot.
    const bulk = await Promise.all(
      Array.from({ length: 5_000 }, (_value, index) =>
        store.createAccessToken({
          workspaceId: "local",
          userId: "local",
          name: `bulk-${index}`,
          type: "pat",
          expiresInDays: 30,
        })),
    );
    for (const created of bulk) await store.verifyAccessToken(created.token);

    // The first token's entry is gone; its row still says t0. (The map-size claim
    // has its own case below, so this one is about the window alone.)
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    const inside = await store.verifyAccessToken(token);
    expect(inside?.lastUsedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(id), "the same token must not write again inside its 60 second window")
      .toBe("2026-09-27T12:00:00.000Z");

    // Past the window it writes again.
    setSystemTime(new Date(TOKEN_CREATED_AT + 60_000));
    const after = await store.verifyAccessToken(token);
    expect(after?.lastUsedAt).toBe("2026-09-27T12:01:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:01:00.000Z");
  });

  it("never exceeds the declared map capacity", async () => {
    const store = createLocalStore();
    const bulk = await Promise.all(
      Array.from({ length: MAP_CAPACITY + 1 }, (_value, index) =>
        store.createAccessToken({
          workspaceId: "local",
          userId: "local",
          name: `cap-${index}`,
          type: "pat",
          expiresInDays: 30,
        })),
    );
    for (const created of bulk) await store.verifyAccessToken(created.token);
    expect(lastUsedAtThrottleSizeForTest()).toBeLessThanOrEqual(MAP_CAPACITY);
    // The cap is about the peak: a sweep that ran after the insert would settle
    // below the cap between calls while briefly holding 4097.
    expect(lastUsedAtThrottlePeakSizeForTest(), "the map must never hold more than its declared capacity")
      .toBeLessThanOrEqual(MAP_CAPACITY);
  });

  it("treats a stored stamp ahead of the clock as an anomaly and writes", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    // Two windows in the future: no plausible clock step lands there, so the
    // throttle must not wedge shut on it.
    setLastUsedAt(id, "2026-09-27T12:05:00.000Z");

    const verified = await store.verifyAccessToken(token);
    expect(verified?.lastUsedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  /**
   * Evict one token's map entry while leaving its row inside the window, so the
   * next verification takes the map-miss path. Filling the map to capacity with
   * other live tokens does exactly that.
   */
  async function evictFromThrottleMap(store: MultiremiStore): Promise<void> {
    const bulk = await Promise.all(
      Array.from({ length: MAP_CAPACITY + 1 }, (_value, index) =>
        store.createAccessToken({
          workspaceId: "local",
          userId: "local",
          name: `evict-${index}`,
          type: "pat",
          expiresInDays: 30,
        })),
    );
    for (const created of bulk) await store.verifyAccessToken(created.token);
  }

  it("refuses a revoked token on the map-miss path too, and does not stamp it", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store, "revoked-on-miss");
    await store.verifyAccessToken(token);
    await evictFromThrottleMap(store);
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    store.revokeAccessToken(id);
    expect(await store.verifyAccessToken(token)).toBeNull();
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  it("refuses an expired rewrite on the map-miss path too", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store, "expired-on-miss");
    await store.verifyAccessToken(token);
    await evictFromThrottleMap(store);
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");

    // Expire the row in place, inside the throttle window: the read must notice.
    db!.run("UPDATE multiremi_access_tokens SET expires_at = ? WHERE id = ?",
      ["2026-09-27T11:59:00.000Z", id]);
    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    expect(await store.verifyAccessToken(token)).toBeNull();
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  it("keeps enforcing allowedTypes on the map-miss path too", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store, "types-on-miss");
    await store.verifyAccessToken(token);
    await evictFromThrottleMap(store);

    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    expect(await store.verifyAccessToken(token, ["daemon"])).toBeNull();
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
    // A matching type still verifies, and still does not write inside the window.
    expect(await store.verifyAccessToken(token, ["pat"])).not.toBeNull();
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  it("still refuses a revoked token immediately, inside the window", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    await store.verifyAccessToken(token);

    setSystemTime(new Date(TOKEN_CREATED_AT + 1_000));
    store.revokeAccessToken(id);
    expect(await store.verifyAccessToken(token)).toBeNull();
    // The refused call must not refresh the stamp it never reached.
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });

  it("still refuses an expired token immediately and keeps enforcing allowedTypes", async () => {
    const store = createLocalStore();
    const { id, token } = await mintedToken(store);
    await store.verifyAccessToken(token);

    expect(await store.verifyAccessToken(token, ["daemon"])).toBeNull();
    expect(await store.verifyAccessToken(token, ["pat"])).not.toBeNull();

    setSystemTime(new Date(TOKEN_CREATED_AT + 31 * 24 * 60 * 60 * 1000));
    expect(await store.verifyAccessToken(token)).toBeNull();
    expect(readLastUsedAt(id)).toBe("2026-09-27T12:00:00.000Z");
  });
});
