/**
 * Postgres bridge worker.
 *
 * Holds a single Postgres connection (Bun.SQL, max:1 so transaction statements
 * share one connection) and answers synchronous requests from the main thread:
 * the main thread posts a query then blocks on Atomics.wait; this worker runs
 * the async query and writes the JSON result into the shared data buffer, then
 * Atomics.notify wakes the main thread. See sql-database.ts (PostgresSyncDatabase).
 */
// In a Bun Worker, the global `self` is the Worker scope. tsc's default DOM lib
// types `self` as `Window`, so reference it through a locally-typed alias rather
// than redeclaring the global (which would conflict with the lib declaration).
const workerSelf = self as unknown as Worker;

let sql: any = null;
const STATUS_DONE = 1;
const STATUS_ERROR = 2;

workerSelf.onmessage = async (event: MessageEvent) => {
  const { control, data, init, sql: query, params } = event.data as {
    control: SharedArrayBuffer;
    data: SharedArrayBuffer;
    init?: string;
    sql?: string;
    params?: unknown[];
  };
  const ctl = new Int32Array(control);
  const buf = new Uint8Array(data);

  const respond = (status: number, payload: string): void => {
    let bytes = new TextEncoder().encode(payload);
    if (bytes.length > buf.length) {
      bytes = new TextEncoder().encode(
        JSON.stringify({ error: `postgres bridge result too large (${bytes.length} > ${buf.length} bytes)` }),
      );
      status = STATUS_ERROR;
    }
    buf.set(bytes, 0);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, status);
    Atomics.notify(ctl, 0);
  };

  try {
    if (init) {
      sql = new Bun.SQL(init, { max: 1 });
      await sql`select 1`;
      respond(STATUS_DONE, JSON.stringify({ ok: true }));
      return;
    }
    const res = await sql.unsafe(query, params ?? []);
    const rows = Array.isArray(res) ? res : Array.from(res ?? []);
    const count = res && typeof (res as any).count === "number" ? (res as any).count : rows.length;
    respond(STATUS_DONE, JSON.stringify({ rows, count }));
  } catch (err: any) {
    respond(STATUS_ERROR, JSON.stringify({ error: String(err?.message ?? err) }));
  }
};
