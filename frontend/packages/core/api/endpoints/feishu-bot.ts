import type {
  FeishuBotAvailability,
  FeishuBotCandidates,
  FeishuBotConfig,
  FeishuBotAuditList,
  FeishuBotRegistrationBrand,
  FeishuBotRegistrationSession,
  FeishuBotStatusSnapshot,
  FeishuBotTestRequest,
  FeishuBotTestResult,
  IssueTopicConfigResponse,
  UpdateIssueTopicConfigRequest,
  UpsertFeishuBotRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_FEISHU_BOT_AVAILABILITY,
  EMPTY_FEISHU_BOT_CANDIDATES,
  EMPTY_FEISHU_BOT_CONFIG,
  EMPTY_FEISHU_BOT_STATUS,
  EMPTY_ISSUE_TOPIC_CONFIG,
  FeishuBotAuditListSchema,
  FeishuBotAvailabilitySchema,
  FeishuBotCandidatesSchema,
  FeishuBotConfigSchema,
  FeishuBotRegistrationSessionSchema,
  FeishuBotStatusSchema,
  IssueTopicConfigResponseSchema,
  FeishuBotTestResultSchema,
} from "../schemas/feishu-bot";

/**
 * Workspace Feishu concierge bot (MUL-206).
 *
 * `GET /feishu-bot` is polymorphic by role — admins get the config, members get
 * a three-field availability projection — so `getFeishuBot` returns a tagged
 * union rather than one widened shape. A caller that forgets to check the tag
 * gets a type error instead of silently reading `app_id: undefined` off a
 * member response.
 */
export type FeishuBotView =
  | { role: "admin"; config: FeishuBotConfig }
  | { role: "member"; availability: FeishuBotAvailability };

export class FeishuBotEndpoints {
  constructor(readonly http: HttpClient) {}

  async getFeishuBot(workspaceId: string): Promise<FeishuBotView> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot`);
    // The member projection has no `workspace_id`; the admin view always does.
    // Sniffing the payload beats trusting a flag, because a flag is one more
    // field that can drift and hand a member the admin branch.
    const isAdminView = typeof raw === "object" && raw !== null && "workspace_id" in raw;
    if (!isAdminView) {
      return {
        role: "member",
        availability: parseWithFallback(
          raw,
          FeishuBotAvailabilitySchema,
          EMPTY_FEISHU_BOT_AVAILABILITY,
          { endpoint: "GET /api/workspaces/:id/feishu-bot (member)" },
        ),
      };
    }
    return {
      role: "admin",
      config: parseWithFallback(
        raw,
        FeishuBotConfigSchema,
        EMPTY_FEISHU_BOT_CONFIG,
        { endpoint: "GET /api/workspaces/:id/feishu-bot" },
      ),
    };
  }

  async getFeishuBotStatus(workspaceId: string): Promise<FeishuBotStatusSnapshot> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/status`);
    return parseWithFallback(raw, FeishuBotStatusSchema, EMPTY_FEISHU_BOT_STATUS, {
      endpoint: "GET /api/workspaces/:id/feishu-bot/status",
    });
  }

  async getFeishuBotCandidates(workspaceId: string): Promise<FeishuBotCandidates> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/candidates`);
    return parseWithFallback(raw, FeishuBotCandidatesSchema, EMPTY_FEISHU_BOT_CANDIDATES, {
      endpoint: "GET /api/workspaces/:id/feishu-bot/candidates",
    });
  }

  async listFeishuBotAudit(workspaceId: string, limit = 20): Promise<FeishuBotAuditList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/feishu-bot/audit?limit=${limit}`,
    );
    return parseWithFallback(
      raw,
      FeishuBotAuditListSchema,
      { workspace_id: workspaceId, entries: [] },
      { endpoint: "GET /api/workspaces/:id/feishu-bot/audit" },
    );
  }

  async getIssueTopicConfig(workspaceId: string): Promise<IssueTopicConfigResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/issue-topics`);
    return parseWithFallback(raw, IssueTopicConfigResponseSchema, EMPTY_ISSUE_TOPIC_CONFIG, {
      endpoint: "GET /api/workspaces/:id/issue-topics",
    });
  }

  async saveIssueTopicConfig(
    workspaceId: string,
    input: UpdateIssueTopicConfigRequest,
  ): Promise<IssueTopicConfigResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/issue-topics`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return parseWithFallback(raw, IssueTopicConfigResponseSchema, EMPTY_ISSUE_TOPIC_CONFIG, {
      endpoint: "PUT /api/workspaces/:id/issue-topics",
    });
  }

  /**
   * Save. `*_op` defaults to `keep` server-side, so a form that leaves the
   * secret box untouched simply omits it and the stored credential survives.
   */
  async saveFeishuBot(workspaceId: string, input: UpsertFeishuBotRequest): Promise<FeishuBotConfig> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return parseWithFallback(raw, FeishuBotConfigSchema, EMPTY_FEISHU_BOT_CONFIG, {
      endpoint: "PUT /api/workspaces/:id/feishu-bot",
    });
  }

  async deleteFeishuBot(workspaceId: string): Promise<FeishuBotConfig> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot`, {
      method: "DELETE",
    });
    return parseWithFallback(raw, FeishuBotConfigSchema, EMPTY_FEISHU_BOT_CONFIG, {
      endpoint: "DELETE /api/workspaces/:id/feishu-bot",
    });
  }

  async deployFeishuBot(workspaceId: string): Promise<FeishuBotStatusSnapshot> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/deploy`, {
      method: "POST",
      body: "{}",
    });
    return parseWithFallback(raw, FeishuBotStatusSchema, EMPTY_FEISHU_BOT_STATUS, {
      endpoint: "POST /api/workspaces/:id/feishu-bot/deploy",
    });
  }

  async stopFeishuBot(workspaceId: string): Promise<FeishuBotStatusSnapshot> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/stop`, {
      method: "POST",
      body: "{}",
    });
    return parseWithFallback(raw, FeishuBotStatusSchema, EMPTY_FEISHU_BOT_STATUS, {
      endpoint: "POST /api/workspaces/:id/feishu-bot/stop",
    });
  }

  /** Probe credentials against the Feishu open platform before saving them. */
  async testFeishuBot(workspaceId: string, input: FeishuBotTestRequest = {}): Promise<FeishuBotTestResult> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/test`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseWithFallback(
      raw,
      FeishuBotTestResultSchema,
      {
        ok: false,
        bot_name: null,
        bot_open_id: null,
        app_name: null,
        runtime_online: false,
        runtime_supports_config: false,
        error_code: "unknown",
        error_message: null,
      },
      { endpoint: "POST /api/workspaces/:id/feishu-bot/test" },
    );
  }

  // ── Scan-to-create (optional credential fill) ─────────────────────────────
  async beginFeishuBotRegistration(
    workspaceId: string,
    brand: FeishuBotRegistrationBrand,
  ): Promise<FeishuBotRegistrationSession> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/feishu-bot/registration`, {
      method: "POST",
      body: JSON.stringify({ brand }),
    });
    return parseWithFallback(raw, FeishuBotRegistrationSessionSchema, EMPTY_REGISTRATION_SESSION, {
      endpoint: "POST /api/workspaces/:id/feishu-bot/registration",
    });
  }

  async getFeishuBotRegistration(
    workspaceId: string,
    sessionId: string,
  ): Promise<FeishuBotRegistrationSession> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/feishu-bot/registration/${sessionId}`,
    );
    return parseWithFallback(raw, FeishuBotRegistrationSessionSchema, EMPTY_REGISTRATION_SESSION, {
      endpoint: "GET /api/workspaces/:id/feishu-bot/registration/:sessionId",
    });
  }

  async cancelFeishuBotRegistration(workspaceId: string, sessionId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/feishu-bot/registration/${sessionId}`, {
      method: "DELETE",
    });
  }
}

// A drifted session reads as `error` rather than `pending`: the dialog must
// stop polling and say so, not spin forever against a QR that never resolves.
const EMPTY_REGISTRATION_SESSION: FeishuBotRegistrationSession = {
  session_id: "",
  status: "error",
  verification_uri: "",
  user_code: "",
  expires_at: "",
  poll_interval_seconds: 5,
  app_id: null,
  app_secret_available: false,
  created_by_open_id: null,
  error_message: null,
};
