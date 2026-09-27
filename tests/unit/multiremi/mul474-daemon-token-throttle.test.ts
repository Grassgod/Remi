// MUL-474 (MUL-383 S8e) step 3: `last_used_at` is written at most once per
// token per minute, and nothing else about verification changes.
//
// The point of the throttle is to remove one UPDATE per daemon poll; the point of
// these cases is that "remove a write" did not quietly become "skip a check".
// Token lookup, revocation and expiry all still run on every call.
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import type { MultiremiStore } from "@multiremi/store.js";

const TOKEN_CREATED_AT = Date.UTC(2026, 8, 27, 12, 0, 0);

beforeEach(() => {
  setSystemTime(new Date(TOKEN_CREATED_AT));
});

afterEach(() => {
  setSystemTime();
  resetMultiremiTestEnv();
});

function readLastUsedAt(tokenId: string): string | null {
  const row = db!.query("SELECT last_used_at FROM multiremi_access_tokens WHERE id = ?")
    .get(tokenId) as { last_used_at: string | null } | null;
  return row?.last_used_at ?? null;
}

async function mintedToken(store: MultiremiStore): Promise<{ id: string; token: string }> {
  const created = await store.createAccessToken({
    workspaceId: "local",
    userId: "local",
    name: "MUL-474 throttle",
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
