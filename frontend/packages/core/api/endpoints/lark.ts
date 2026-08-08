import type {
  BeginLarkInstallResponse,
  LarkInstallStatusResponse,
  ListLarkInstallationsResponse,
  RedeemLarkBindingTokenResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_LIST_LARK_INSTALLATIONS_RESPONSE,
  ListLarkInstallationsResponseSchema,
} from "../schemas/lark";

export class LarkEndpoints {
  constructor(readonly http: HttpClient) {}

  // Lark integration
  async listLarkInstallations(workspaceId: string): Promise<ListLarkInstallationsResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/lark/installations`);
    return parseWithFallback(
      raw,
      ListLarkInstallationsResponseSchema,
      EMPTY_LIST_LARK_INSTALLATIONS_RESPONSE,
      { endpoint: "GET /api/workspaces/:id/lark/installations" },
    );
  }

  async beginLarkInstall(
    workspaceId: string,
    agentId: string,
    region: "feishu" | "lark",
  ): Promise<BeginLarkInstallResponse> {
    // The user picks the cloud explicitly in the UI ("Bind to Feishu"
    // vs "Bind to Lark"), and the backend POSTs the device-flow `begin`
    // against the corresponding accounts host (accounts.feishu.cn vs
    // accounts.larksuite.com) so the QR renders against the right
    // cloud up front. Empty / omitted region still resolves to Feishu
    // server-side (RegionOrDefault) — we surface region as a required
    // arg here so every call site is forced to make a deliberate
    // choice rather than silently defaulting to mainland.
    const search = new URLSearchParams({ agent_id: agentId, region });
    return this.http.fetch(`/api/workspaces/${workspaceId}/lark/install/begin?${search.toString()}`, {
      method: "POST",
    });
  }

  async getLarkInstallStatus(workspaceId: string, sessionId: string): Promise<LarkInstallStatusResponse> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/lark/install/${sessionId}/status`);
  }

  async deleteLarkInstallation(workspaceId: string, installationId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/lark/installations/${installationId}`, {
      method: "DELETE",
    });
  }

  async redeemLarkBindingToken(token: string): Promise<RedeemLarkBindingTokenResponse> {
    return this.http.fetch(`/api/lark/binding/redeem`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }
}
