import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import { type AppConfigResponse, AppConfigSchema, EMPTY_APP_CONFIG } from "../schemas/config";

export class ConfigEndpoints {
  constructor(readonly http: HttpClient) {}

  // App Config
  async getConfig(): Promise<AppConfigResponse> {
    const raw = await this.http.fetch<unknown>("/api/config");
    return parseWithFallback<AppConfigResponse>(raw, AppConfigSchema, EMPTY_APP_CONFIG, {
      endpoint: "GET /api/config",
    });
  }
}
