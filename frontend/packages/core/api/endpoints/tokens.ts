import type {
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  PersonalAccessToken,
} from "../../types";
import type { HttpClient } from "../http";

export class TokensEndpoints {
  constructor(readonly http: HttpClient) {}

  // Personal Access Tokens
  async listPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
    return this.http.fetch("/api/tokens");
  }

  async createPersonalAccessToken(data: CreatePersonalAccessTokenRequest): Promise<CreatePersonalAccessTokenResponse> {
    return this.http.fetch("/api/tokens", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async revokePersonalAccessToken(id: string): Promise<void> {
    await this.http.fetch(`/api/tokens/${id}`, { method: "DELETE" });
  }
}
