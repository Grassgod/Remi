import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";

// Only an explicitly selected disposable test service may create this database.
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `remi_password_test_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let databaseUrl: string;
let db: PostgresSyncDatabase;
let store: MultiremiStore;
let created = false;

function phase(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", failed);
      error ? reject(error) : resolve();
    };
    const message = (event: MessageEvent<{ phase: string; error?: string }>) => {
      if (event.data.phase === expected) finish();
      else if (event.data.phase === "error") finish(new Error(event.data.error));
    };
    const failed = (event: ErrorEvent) => finish(new Error(event.message));
    const timer = setTimeout(() => finish(new Error(`Password test worker did not reach ${expected}`)), 10_000);
    worker.addEventListener("message", message);
    worker.addEventListener("error", failed);
  });
}

describe.skipIf(!adminUrl)("Password accounts on Postgres", () => {
  beforeAll(async () => {
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      created = true;
    } finally { await admin.end(); }
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    db = new PostgresSyncDatabase(databaseUrl);
    store = new MultiremiStore(db);
  });

  afterAll(async () => {
    db?.close();
    if (!created) return;
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`); }
    finally { await admin.end(); }
  });

  it("persists password credentials and revokes sessions on reset without revoking personal tokens", async () => {
    const email = "pg-password@example.test";
    const password = `test-only-${crypto.randomUUID()}`;
    const configured = await store.configurePasswordAccount({ email, password });
    store.migrate();
    expect(store.getUserRoleInWorkspace(configured.user.id, "local")).toBe("owner");
    const session = await store.loginWithPassword(email, password);
    expect(session?.user.id).toBe(configured.user.id);
    const personal = await store.createAccessToken({ userId: configured.user.id, name: "PG personal fixture", purpose: "personal" });
    await store.configurePasswordAccount({ email, password: `replacement-${crypto.randomUUID()}` });
    expect(await store.verifyAccessToken(session!.token)).toBeNull();
    expect(await store.verifyAccessToken(personal.token)).not.toBeNull();
  });

  it("serializes a reset with the verified login until its session is inserted", async () => {
    const email = "pg-reset-race@example.test";
    const password = `test-only-${crypto.randomUUID()}`;
    await store.configurePasswordAccount({ email, password });
    const state = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(new URL("./fixtures/postgres-password-reset-worker.ts", import.meta.url).href);
    const ready = phase(worker, "ready");
    worker.postMessage({ type: "init", databaseUrl, control: state.buffer });
    await ready;
    let resetFinishedBeforeInsert = false;
    const reset = phase(worker, "reset");
    const original = AccessTokensRepo.prototype.createAccessToken;
    const intercept = spyOn(AccessTokensRepo.prototype, "createAccessToken").mockImplementation(function (this: AccessTokensRepo, input, beforeInsert, scopes) {
      return original.call(this, input, () => {
        beforeInsert?.();
        worker.postMessage({ type: "reset", email, password: `replacement-${crypto.randomUUID()}` });
        Atomics.wait(state, 0, 0, 5_000);
        if (Atomics.load(state, 0) !== 1) throw new Error("Password reset did not reach its credential write");
        resetFinishedBeforeInsert = Atomics.wait(state, 1, 0, 250) !== "timed-out";
      }, scopes);
    });
    try {
      const session = await store.loginWithPassword(email, password);
      await reset;
      expect(resetFinishedBeforeInsert).toBe(false);
      expect(session).not.toBeNull();
      expect(await store.verifyAccessToken(session!.token)).toBeNull();
    } finally {
      intercept.mockRestore();
      worker.terminate();
    }
  });
});
