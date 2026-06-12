import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { user } from "../src/db/schema.js";

const DB_URL =
  process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

// Probe once: skip the live round-trip when no Postgres is reachable (CI w/o DB).
let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  // no DB — round-trip test below is skipped
}

test.skipIf(!reachable)("user insert → select → delete round-trip (live DB)", async () => {
  const { db, close } = createDb(DB_URL);
  const email = `bun-test-${Date.now()}@example.com`;
  try {
    const [inserted] = await db
      .insert(user)
      .values({ name: "Bun Test", email })
      .returning();
    expect(inserted?.email).toBe(email);
    expect(inserted?.id).toBeTruthy();

    const found = await db.select().from(user).where(eq(user.email, email));
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("Bun Test");

    await db.delete(user).where(eq(user.id, inserted!.id));
    const after = await db.select().from(user).where(eq(user.email, email));
    expect(after).toHaveLength(0);
  } finally {
    await close();
  }
});
