import { z } from "zod";
import type {
  UpdateMeRequest,
  User,
} from "../../types";
import type { OnboardingCompletionPath } from "../../onboarding/types";
import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import { EMPTY_USER, UserSchema } from "../schemas/users";

export interface LoginResponse {
  token: string;
  user: User;
}

const LoginResponseSchema = z.object({
  token: z.string().trim().min(1),
  user: UserSchema.extend({
    id: z.string().trim().min(1),
    email: z.string().trim().min(1),
  }).strip(),
});

export class AuthEndpoints {
  constructor(readonly http: HttpClient) {}

  // Auth
  async sendCode(email: string): Promise<void> {
    await this.http.fetch("/auth/send-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  async verifyCode(email: string, code: string): Promise<LoginResponse> {
    return this.http.fetch("/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
  }

  async passwordLogin(email: string, password: string): Promise<LoginResponse> {
    const raw = await this.http.fetch<unknown>("/auth/password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return parseStrictResponse<LoginResponse>(raw, LoginResponseSchema, {
      endpoint: "POST /auth/password",
    });
  }

  /** Feishu (Lark) SSO: ask the backend for the authorization URL to redirect to. */
  async getLarkLoginUrl(redirectUri: string, state: string): Promise<{ url: string }> {
    const params = new URLSearchParams({ redirect_uri: redirectUri, state });
    return this.http.fetch(`/auth/lark/url?${params.toString()}`);
  }

  /** Feishu (Lark) SSO: exchange the authorization code for a session. */
  async larkLogin(code: string, redirectUri: string): Promise<LoginResponse> {
    return this.http.fetch("/auth/lark/callback", {
      method: "POST",
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
  }

  async logout(): Promise<void> {
    await this.http.fetch("/auth/logout", { method: "POST" });
  }

  async issueCliToken(): Promise<{ token: string }> {
    return this.http.fetch("/api/cli-token", { method: "POST" });
  }

  async getMe(): Promise<User> {
    const raw = await this.http.fetch<unknown>("/api/me");
    return parseWithFallback(raw, UserSchema, EMPTY_USER, {
      endpoint: "GET /api/me",
    });
  }

  async markOnboardingComplete(payload?: {
    completion_path?: OnboardingCompletionPath;
    workspace_id?: string;
  }): Promise<User> {
    const raw = await this.http.fetch<unknown>("/api/me/onboarding/complete", {
      method: "POST",
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return parseWithFallback(raw, UserSchema, EMPTY_USER, {
      endpoint: "POST /api/me/onboarding/complete",
    });
  }

  async patchOnboarding(payload: {
    questionnaire?: Record<string, unknown>;
  }): Promise<User> {
    const raw = await this.http.fetch<unknown>("/api/me/onboarding", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return parseWithFallback(raw, UserSchema, EMPTY_USER, {
      endpoint: "PATCH /api/me/onboarding",
    });
  }

  async updateMe(data: UpdateMeRequest): Promise<User> {
    const raw = await this.http.fetch<unknown>("/api/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, UserSchema, EMPTY_USER, {
      endpoint: "PATCH /api/me",
    });
  }
}
