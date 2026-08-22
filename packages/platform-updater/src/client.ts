import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import type { PlatformInspection } from "./types.js";

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
        if (!response.ok) throw new Error(`updater API ${path} returned ${response.status}`);
        return await response.json() as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < attempts) await Bun.sleep(retry.retryDelayMs ?? 1_000);
      }
    }
    throw lastError ?? new Error(`updater API ${path} failed`);
  }
}
