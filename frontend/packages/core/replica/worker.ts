/**
 * The DedicatedWorker that owns the replica's SQLite database (MUL-403 C7 §2).
 *
 * `sqlite-wasm` over `opfs-sahpool`: the official build, the official VFS, and
 * the reason this is a Worker at all — `createSyncAccessHandle()` exists only off
 * the main thread (the main thread has no `FileSystemFileHandle.prototype.
 * createSyncAccessHandle`, which is also why the API cannot be used from a page),
 * and a synchronous write on the page's thread is a jank source the plan exists
 * to remove.
 *
 * Two things this file does NOT do, both deliberate:
 *
 * - **no network.** The page holds the WebSocket because the token is in
 *   `localStorage` and a Worker cannot read it. The page forwards frames.
 * - **no timers.** A background tab's timers are throttled, so the replay, the
 *   patch and the coverage bookkeeping all run on message arrival.
 *
 * OPFS unavailable (old Safari, private mode, a store denied at runtime) is not
 * an error: the plan's fallback is the same protocol over memory, which is
 * {@link MemoryReplicaStorage} behind the same {@link ReplicaEngine}.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { ReplicaEngine } from "./engine";
import { SqlReplicaStorage } from "./sql-store";
import { MemoryReplicaStorage, type ReplicaStorage } from "./storage";
import { wasmSqlDatabase, type WasmDatabase } from "./sql";
import { rangeOfFrames } from "./frames";
import type { ReplicaWorkerRequest, ReplicaWorkerResponse, ReplicaWorkerStorage } from "./worker-protocol";

/** The SAH pool name and directory. One per browser, matching the one database. */
const SAH_POOL_NAME = "remi-replica-pool";
const SAH_POOL_DIR = "remi-replica";

/**
 * The plan's per-`(user, workspace)` path (3/6 §1): `remi-replica/<user>/<ws>.sqlite3`.
 *
 * The directory half is the SAH pool's, so the name inside it is the rest. Slashes
 * are legal in a pool filename and the VFS creates the intermediate directory;
 * verified against `opfs-sahpool` in headless Chromium.
 */
export function replicaDatabaseName(userId: string, workspaceId: string): string {
  return `/${sanitizePathSegment(userId)}/${sanitizePathSegment(workspaceId)}.sqlite3`;
}

/** Keep a user or workspace id from naming a parent directory. */
function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

export interface ReplicaWorkerOptions {
  /** Overridable so the fallback test can force the memory path. */
  storage?: ReplicaWorkerStorage;
  /** Injected in tests; the real Worker posts on `self`. */
  post?: (message: ReplicaWorkerResponse) => void;
  /**
   * Override the database filename. The default is the plan's path,
   * `/<user>/<workspace>.sqlite3`, so one `(user, workspace)` has one file even
   * though every pair shares the pool.
   */
  databaseName?: string;
}

interface SahPoolUtil {
  OpfsSAHPoolDb: new (name: string) => WasmDatabase;
  getCapacity: () => number;
  reserveMinimumCapacity: (min: number) => Promise<number>;
}

/**
 * Open the SQLite database, or explain why memory is being used instead.
 *
 * The pool needs room for the database plus its journal, so the capacity is
 * reserved up front rather than growing mid-write: `addCapacity` is async and the
 * C-level VFS cannot call it on its own, which is exactly the failure mode the
 * upstream docs warn about.
 */
export async function openReplicaStorage(
  databaseName: string,
  requested: ReplicaWorkerStorage,
): Promise<{ storage: ReplicaStorage; storageKind: ReplicaWorkerStorage; degraded: string | null }> {
  if (requested === "memory") {
    return { storage: new MemoryReplicaStorage(), storageKind: "memory", degraded: null };
  }
  try {
    // Checked before the wasm build is loaded, because that is the decision the
    // plan describes ("无 OPFS"): whether this scope has the OPFS entry point at
    // all. The VFS would refuse a moment later with a less specific error.
    if (typeof (globalThis as { navigator?: Navigator }).navigator?.storage?.getDirectory !== "function") {
      return { storage: new MemoryReplicaStorage(), storageKind: "memory", degraded: "OPFS is unavailable in this scope" };
    }
    const sqlite3 = await sqlite3InitModule();
    const util = (await sqlite3.installOpfsSAHPoolVfs({
      name: SAH_POOL_NAME,
      directory: SAH_POOL_DIR,
    })) as unknown as SahPoolUtil;
    await util.reserveMinimumCapacity(4);
    const db = new util.OpfsSAHPoolDb(databaseName);
    return {
      storage: new SqlReplicaStorage(wasmSqlDatabase(db as unknown as WasmDatabase)),
      storageKind: "opfs",
      degraded: null,
    };
  } catch (error) {
    // Documented degrade path, not a silent one: the reason travels back to the
    // page, which logs `replica:degraded` once.
    const message = error instanceof Error ? error.message : String(error);
    return { storage: new MemoryReplicaStorage(), storageKind: "memory", degraded: message };
  }
}

/** One Worker instance's state: one engine, one storage, one database. */
export class ReplicaWorkerHost {
  private engine: ReplicaEngine | null = null;
  private storageKind: ReplicaWorkerStorage | null = null;
  /** Set by `init`: the database belongs to one `(user, workspace)` identity. */
  private identity: { userId: string; workspaceId: string } = { userId: "", workspaceId: "" };
  /** The database file this Worker opened; empty until `init`. */
  private databaseName = "";
  /**
   * Serializes requests.
   *
   * `init` awaits wasm startup, so without this an `open` posted right after it
   * would run against a null engine and be reported as "before init" — the
   * leader's very first two messages. A chain also keeps two frame batches from
   * interleaving their SQLite writes.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ReplicaWorkerOptions) {}

  /** Which storage actually opened; `null` before `init`. */
  get storage(): ReplicaWorkerStorage | null {
    return this.storageKind;
  }

  /** Enqueue one request; responses keep their order. */
  enqueue(request: ReplicaWorkerRequest): Promise<void> {
    const next = this.queue.then(() => this.handle(request));
    // The chain must survive a rejected link, or one failure would stop every
    // later request; `handle` already reports errors, so this only guards the
    // chain itself.
    this.queue = next.catch(() => {});
    return next;
  }

  async handle(request: ReplicaWorkerRequest): Promise<void> {
    const post = this.options.post ?? ((message: ReplicaWorkerResponse) => self.postMessage(message));
    try {
      if (request.type === "init") {
        this.databaseName = this.options.databaseName ?? replicaDatabaseName(request.userId, request.workspaceId);
        const opened = await openReplicaStorage(this.databaseName, this.options.storage ?? request.storage);
        this.identity = { userId: request.userId, workspaceId: request.workspaceId };
        this.engine = new ReplicaEngine(opened.storage);
        this.engine.onClear = (reason) => post({ type: "cleared", reason });
        this.storageKind = opened.storageKind;
        post({ type: "ready", storage: opened.storageKind, degraded: opened.degraded });
        return;
      }

      const engine = this.engine;
      if (!engine) {
        post({ type: "error", request: request.type, message: "replica worker received a request before init" });
        return;
      }

      switch (request.type) {
        case "open": {
          const opened = engine.openSession({
            sessionId: request.sessionId,
            userId: this.identity.userId,
            workspaceId: this.identity.workspaceId,
          });
          post({
            type: "opened",
            sessionId: request.sessionId,
            fromSeq: opened.fromSeq,
            head: engine.snapshot(request.sessionId).head,
            fresh: engine.isFresh(request.sessionId),
            cleared: opened.cleared?.reason ?? null,
            // The window a previous leader left on disk, so a takeover paints
            // immediately instead of waiting for the socket's replay.
            entries: [...engine.snapshot(request.sessionId).entries],
          });
          return;
        }
        case "ack": {
          const backfill = engine.ack(request.sessionId, request.ack);
          post({ type: "backfill", sessionId: request.sessionId, range: backfill });
          return;
        }
        case "frames": {
          const missing = engine.frames(request.sessionId, request.frames);
          const view = engine.snapshot(request.sessionId);
          post({
            type: "appended",
            sessionId: request.sessionId,
            range: rangeOfFrames(request.frames),
            head: view.head,
            fresh: view.fresh,
            missing,
            entries: [...view.entries],
          });
          return;
        }
        case "window": {
          const view = engine.snapshot(request.sessionId);
          post({
            type: "windowResult",
            sessionId: request.sessionId,
            entries: engine.readWindow(request.sessionId, request.from, request.to),
            head: view.head,
            fresh: view.fresh,
            ready: view.ready,
          });
          return;
        }
        case "writeWindow": {
          engine.writeWindow(request.sessionId, request.entries, request.range);
          const view = engine.snapshot(request.sessionId);
          post({
            type: "appended",
            sessionId: request.sessionId,
            range: request.range,
            head: view.head,
            fresh: view.fresh,
            missing: null,
            entries: [...view.entries],
          });
          return;
        }
        case "readHeight": {
          post({
            type: "height",
            sessionId: request.sessionId,
            seq: request.seq,
            key: request.key,
            height: engine.readRowHeight(request.sessionId, request.seq, request.key),
          });
          return;
        }
        case "writeHeight": {
          engine.writeRowHeight(request.sessionId, request.seq, request.key, request.height);
          return;
        }
        case "snapshot": {
          const view = engine.snapshot(request.sessionId);
          post({
            type: "windowResult",
            sessionId: request.sessionId,
            entries: [...view.entries],
            head: view.head,
            fresh: view.fresh,
            ready: view.ready,
          });
          return;
        }
        case "clear": {
          // `engine.clear` reports through `onClear` (wired to this Worker's
          // `post` at init), so posting here as well would announce the clear
          // twice and every tab would run its reset twice.
          engine.clear(request.reason);
          return;
        }
      }
    } catch (error) {
      post({ type: "error", request: request.type, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * The Worker entry point.
 *
 * Kept at the bottom so `worker.ts` can be imported by a test (which constructs
 * {@link ReplicaWorkerHost} with its own `post`) without installing handlers on a
 * `self` that is not a Worker.
 */
export function installReplicaWorkerScope(scope: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown) => void } = self as never): void {
  const host = new ReplicaWorkerHost({});
  scope.onmessage = (event: MessageEvent) => {
    void host.enqueue(event.data as ReplicaWorkerRequest);
  };
}
