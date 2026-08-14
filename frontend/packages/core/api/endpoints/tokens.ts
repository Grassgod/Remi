import type {
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  PersonalAccessToken,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_PERSONAL_ACCESS_TOKEN,
  PersonalAccessTokenListSchema,
  PersonalAccessTokenResponseSchema,
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
}
