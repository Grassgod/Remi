import type {
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  PersonalAccessToken,
  ProvisionDaemonCredentialRequest,
  ProvisionDaemonCredentialResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_PERSONAL_ACCESS_TOKEN,
  EMPTY_PROVISION_DAEMON_CREDENTIAL,
  PersonalAccessTokenListSchema,
  PersonalAccessTokenResponseSchema,
  ProvisionDaemonCredentialResponseSchema,
} from "../schemas/tokens";

export class TokensEndpoints {
  constructor(readonly http: HttpClient) {}

  // Personal Access Tokens
  async listPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
    const raw = await this.http.fetch<unknown>("/api/tokens");
    return parseWithFallback(raw, PersonalAccessTokenListSchema, [], {
      endpoint: "GET /api/tokens",
    });
  }

  async createPersonalAccessToken(data: CreatePersonalAccessTokenRequest): Promise<CreatePersonalAccessTokenResponse> {
    const raw = await this.http.fetch<unknown>("/api/tokens", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, PersonalAccessTokenResponseSchema, EMPTY_PERSONAL_ACCESS_TOKEN, {
      endpoint: "POST /api/tokens",
    });
  }

  async revokePersonalAccessToken(id: string): Promise<void> {
    await this.http.fetch(`/api/tokens/${id}`, { method: "DELETE" });
  }

  async provisionDaemonCredential(
    data: ProvisionDaemonCredentialRequest,
  ): Promise<ProvisionDaemonCredentialResponse> {
    const raw = await this.http.fetch<unknown>("/api/multiremi/install/daemon", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: data.workspace_id,
        token_name: data.name,
        expires_in_days: data.expires_in_days,
        create_token: true,
      }),
    });
    const credential = parseWithFallback(
      raw,
      ProvisionDaemonCredentialResponseSchema,
      EMPTY_PROVISION_DAEMON_CREDENTIAL,
      { endpoint: "POST /api/multiremi/install/daemon" },
    );
    return credential.workspaceId === data.workspace_id
      ? credential
      : EMPTY_PROVISION_DAEMON_CREDENTIAL;
  }
}
