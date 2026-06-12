/**
 * In-memory model-list request store — the Bun analog of the Go
 * runtime_models_redis_store. The rewrite dropped Redis, so (like the realtime
 * EventBus) ephemeral runtime round-trips live in process memory. A client asks
 * a runtime to enumerate its models; the daemon claims the pending request,
 * runs discovery, and reports back; the client polls the result.
 *
 * NOTE: single-process only — fine for a self-host single server; a multi-
 * replica deployment would need a shared store (Redis or a DB table).
 */

export type ModelListStatus = "pending" | "running" | "completed" | "failed";

export interface ModelListRequest {
  id: string;
  runtimeId: string;
  status: ModelListStatus;
  models: unknown[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ModelListStore {
  private readonly byId = new Map<string, ModelListRequest>();

  /** Create a pending request for a runtime. */
  create(runtimeId: string): ModelListRequest {
    const now = new Date().toISOString();
    const req: ModelListRequest = {
      id: crypto.randomUUID(),
      runtimeId,
      status: "pending",
      models: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(req.id, req);
    return req;
  }

  get(id: string): ModelListRequest | null {
    return this.byId.get(id) ?? null;
  }

  /** Claim the oldest pending request for a runtime (pending → running). */
  claimPending(runtimeId: string): ModelListRequest | null {
    for (const req of this.byId.values()) {
      if (req.runtimeId === runtimeId && req.status === "pending") {
        req.status = "running";
        req.updatedAt = new Date().toISOString();
        return req;
      }
    }
    return null;
  }

  /** Record the daemon's result (completed with models, or failed with error). */
  report(id: string, result: { models?: unknown[]; error?: string }): ModelListRequest | null {
    const req = this.byId.get(id);
    if (!req) return null;
    if (result.error) {
      req.status = "failed";
      req.error = result.error;
    } else {
      req.status = "completed";
      req.models = result.models ?? [];
    }
    req.updatedAt = new Date().toISOString();
    return req;
  }
}

/** Process-wide singleton (mirrors the realtime `bus`). */
export const modelListStore = new ModelListStore();
