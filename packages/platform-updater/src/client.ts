import type {
  MultiremiPlatformMaintenance,
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import type { PlatformInspection } from "./types.js";

export interface PlatformDrainStatusWire {
  generation: number;
  mode: string;
  online_daemons: number;
  acked_daemons: number;
  active_tasks: number;
  pending_runtimes: Array<{ id: string; name: string; daemon_id: string | null }>;
  ready: boolean;
}

export interface PlatformDrainRenewResponse {
  maintenance: MultiremiPlatformMaintenance;
  status: PlatformDrainStatusWire;
  cancel_requested: boolean;
}

/** Thrown when renew reports the drain lease is no longer held (409). */
export class PlatformDrainLostError extends Error {}

export class PlatformUpdaterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly updaterToken: string,
  ) {}

  async heartbeat(inspection: PlatformInspection, latestRelease?: MultiremiPlatformRelease | null): Promise<void> {
    await this.request("/api/platform-updater/heartbeat", {
      driver: inspection.driver,
      currentRelease: inspection.currentRelease,
      latestRelease,
      recentReleases: inspection.recentReleases,
      services: inspection.services,
    });
  }

  async claim(): Promise<MultiremiPlatformOperation | null> {
    const response = await this.request<{ operation?: MultiremiPlatformOperation | null }>(
      "/api/platform-updater/operations/claim",
      {},
    );
    return response.operation ?? null;
  }

  async report(id: string, input: ReportPlatformOperationInput): Promise<void> {
    await this.request(`/api/platform-updater/operations/${encodeURIComponent(id)}/report`, input, {
      retries: 24,
      retryDelayMs: 2_500,
    });
  }

  async drainBegin(operationId: string, reason?: string | null, ttlMs?: number): Promise<void> {
    await this.request("/api/platform-updater/drain/begin", {
      operation_id: operationId,
      reason: reason ?? null,
      ...(ttlMs ? { ttl_ms: ttlMs } : {}),
    }, { retries: 6, retryDelayMs: 2_500 });
  }

  async drainRenew(operationId: string, ttlMs?: number): Promise<PlatformDrainRenewResponse> {
    try {
      return await this.request<PlatformDrainRenewResponse>("/api/platform-updater/drain/renew", {
        operation_id: operationId,
        ...(ttlMs ? { ttl_ms: ttlMs } : {}),
      }, { retries: 3, retryDelayMs: 2_000 });
    } catch (error) {
      if (error instanceof PlatformUpdaterHttpError && error.status === 409) {
        throw new PlatformDrainLostError(`drain lease for ${operationId} is no longer held`);
      }
      throw error;
    }
  }

  /** Idempotent; retried aggressively because it may race an API restart. */
  async drainRelease(operationId: string): Promise<void> {
    await this.request("/api/platform-updater/drain/release", { operation_id: operationId }, {
      retries: 24,
      retryDelayMs: 2_500,
    });
  }

  private async request<T = unknown>(
    path: string,
    body: unknown,
    retry: { retries?: number; retryDelayMs?: number } = {},
  ): Promise<T> {
    const attempts = Math.max(1, retry.retries ?? 3);
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(new URL(path, this.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
            "X-Multiremi-Updater-Token": this.updaterToken,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new PlatformUpdaterHttpError(path, response.status);
        return await response.json() as T;
      } catch (error) {
        // 4xx responses are deterministic (auth, conflict, validation) — do not
        // burn the retry budget on them; retries exist for restarts and 5xx.
        if (error instanceof PlatformUpdaterHttpError && error.status < 500) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < attempts) await Bun.sleep(retry.retryDelayMs ?? 1_000);
      }
    }
    throw lastError ?? new Error(`updater API ${path} failed`);
  }
}

export class PlatformUpdaterHttpError extends Error {
  constructor(path: string, readonly status: number) {
    super(`updater API ${path} returned ${status}`);
    this.name = "PlatformUpdaterHttpError";
  }
}
