import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  EMPTY_PLATFORM_STATUS,
  PlatformOperationResponseSchema,
  PlatformSettingsResponseSchema,
  PlatformStatusSchema,
  type PlatformOperation,
  type PlatformStatus,
} from "../schemas/platform";

export class PlatformEndpoints {
  constructor(readonly http: HttpClient) {}

  async getPlatformStatus(): Promise<PlatformStatus> {
    const raw = await this.http.fetch<unknown>("/api/multiremi/platform/status");
    return parseWithFallback(raw, PlatformStatusSchema, EMPTY_PLATFORM_STATUS, {
      endpoint: "GET /api/multiremi/platform/status",
    });
  }

  async createPlatformOperation(input: {
    kind: "check_updates" | "restart" | "update" | "rollback";
    targetVersion?: string | null;
    targetRef?: string | null;
  }): Promise<PlatformOperation> {
    const raw = await this.http.fetch<unknown>("/api/multiremi/platform/operations", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseStrictResponse<{ operation: PlatformOperation }>(raw, PlatformOperationResponseSchema, {
      endpoint: "POST /api/multiremi/platform/operations",
    }).operation;
  }

  async cancelPlatformOperation(id: string): Promise<PlatformOperation> {
    const raw = await this.http.fetch<unknown>(`/api/multiremi/platform/operations/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    return parseStrictResponse<{ operation: PlatformOperation }>(raw, PlatformOperationResponseSchema, {
      endpoint: "POST /api/multiremi/platform/operations/:id/cancel",
    }).operation;
  }

  async updatePlatformSettings(autoUpdateStable: boolean): Promise<boolean> {
    const raw = await this.http.fetch<unknown>("/api/multiremi/platform/settings", {
      method: "PATCH",
      body: JSON.stringify({ autoUpdateStable }),
    });
    return parseStrictResponse<{ state: { autoUpdateStable: boolean } }>(raw, PlatformSettingsResponseSchema, {
      endpoint: "PATCH /api/multiremi/platform/settings",
    }).state.autoUpdateStable;
  }
}
