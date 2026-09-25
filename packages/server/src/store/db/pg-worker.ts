/**
 * Postgres bridge worker.
 *
 * Holds a single Postgres connection (Bun.SQL, max:1 so transaction statements
 * share one connection) and answers synchronous requests from the main thread:
 * the main thread posts a query then blocks on Atomics.wait; this worker runs
 * the async query and writes the JSON result into the shared data buffer, then
 * Atomics.notify wakes the main thread. See postgres.ts (PostgresSyncDatabase).
 */
// In a Bun Worker, the global `self` is the Worker scope. tsc's default DOM lib
// types `self` as `Window`, so reference it through a locally-typed alias rather
// than redeclaring the global (which would conflict with the lib declaration).
const workerSelf = self as unknown as Worker;

let sql: any = null;
const STATUS_DONE = 1;
const STATUS_ERROR = 2;

// Bun.SQL transparently reconnects after the server drops the connection (PG
// restart, pg_terminate_backend). That is what lets the API heal after a
// restart, but inside BEGIN…COMMIT it would run the rest of the transaction in
// autocommit on a fresh session and turn COMMIT into a no-op warning, silently
// committing only the tail of the transaction. The server has already rolled
// the transaction back when the connection died, so once that happens every
// further statement is refused until the caller's ROLLBACK closes it out.
let connectionGeneration = 0;
let transactionGeneration: number | null = null;
let transactionConnectionLost = false;
const TRANSACTION_CONNECTION_LOST =
  "connection lost during transaction; the server rolled the transaction back";

function transactionVerb(query: string | undefined): "BEGIN" | "COMMIT" | "ROLLBACK" | null {
  if (!query || query.length > 16) return null;
  const verb = query.trim().toUpperCase();
  return verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK" ? verb : null;
}

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

  const verb = transactionVerb(query);
  try {
    if (init) {
      sql = new Bun.SQL(init, {
        max: 1,
        onconnect: () => {
          connectionGeneration += 1;
        },
        onclose: () => {
          if (transactionGeneration !== null) transactionConnectionLost = true;
        },
      });
      await sql`select 1`;
      respond(STATUS_DONE, JSON.stringify({ ok: true }));
      return;
    }
    if (transactionGeneration !== null && transactionGeneration !== connectionGeneration) {
      transactionConnectionLost = true;
    }
    if (transactionConnectionLost) {
      if (verb === "ROLLBACK") {
        respond(STATUS_DONE, JSON.stringify({ rows: [], count: 0 }));
      } else {
        respond(STATUS_ERROR, JSON.stringify({ error: TRANSACTION_CONNECTION_LOST }));
      }
      return;
    }
    const res = await sql.unsafe(query, params ?? []);
    if (verb === "BEGIN") {
      transactionGeneration = connectionGeneration;
    } else if (transactionGeneration !== null && transactionGeneration !== connectionGeneration) {
      // Reconnected while this statement ran: it executed outside the transaction.
      transactionConnectionLost = true;
      respond(STATUS_ERROR, JSON.stringify({ error: TRANSACTION_CONNECTION_LOST }));
      return;
    }
    const rows = Array.isArray(res) ? res : Array.from(res ?? []);
    const count = res && typeof (res as any).count === "number" ? (res as any).count : rows.length;
    respond(STATUS_DONE, JSON.stringify({ rows, count }));
  } catch (err: any) {
    respond(STATUS_ERROR, JSON.stringify({ error: String(err?.message ?? err) }));
  } finally {
    if (verb === "COMMIT" || verb === "ROLLBACK") {
      transactionGeneration = null;
      transactionConnectionLost = false;
    }
  }
};
