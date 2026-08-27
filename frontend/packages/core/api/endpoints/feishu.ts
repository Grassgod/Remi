import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  EMPTY_FEISHU_AVAILABLE_CHATS,
  EMPTY_FEISHU_CHAT_LIST,
  EMPTY_FEISHU_ENDPOINT_LIST,
  EMPTY_FEISHU_MESSAGE_LIST,
  EMPTY_FEISHU_PROPOSAL_LIST,
  EMPTY_FEISHU_SOURCE_LIST,
  FeishuAvailableChatsResponseSchema,
  FeishuChatListResponseSchema,
  FeishuEndpointCheckResponseSchema,
  FeishuEndpointListResponseSchema,
  FeishuMessageActionResponseSchema,
  FeishuMessageListResponseSchema,
  FeishuProposalListResponseSchema,
  FeishuSourceListResponseSchema,
  FeishuSourceResponseSchema,
  FeishuSourceStatusResponseSchema,
  type FeishuAvailableChats,
  type FeishuChatList,
  type FeishuEndpointHealth,
  type FeishuEndpointList,
  type FeishuMessageList,
  type FeishuMessageOutcome,
  type FeishuProposalList,
  type FeishuSource,
  type FeishuSourceList,
  type FeishuSourceStatus,
} from "../schemas/feishu";

export interface FeishuSourceInput {
  name?: string | null;
  /** A registered endpoint *name*, never a URL. The server resolves it against
   *  an operator-owned registry; there is deliberately no way to express an
   *  address here, so a compromised browser cannot aim the API at a host of
   *  its choosing. */
  endpointName?: string;
  allowlist?: string[];
  enabled?: boolean;
  retentionDays?: number;
  pollIntervalSeconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessedRetryLimit?: number;
}

export interface FeishuMessageListParams {
  limit?: number;
  offset?: number;
  source?: string;
  chat?: string;
  q?: string;
  processed?: boolean;
  since?: string;
  until?: string;
}

export interface FeishuIssueInput {
  title: string;
  description?: string | null;
  priority?: string;
  projectId?: string | null;
  assigneeType?: string | null;
  assigneeId?: string | null;
}

export interface FeishuMessageActionResult {
  outcomes: FeishuMessageOutcome[];
  created?: boolean;
  delivered?: boolean;
}

/** Health fields the panel is allowed to see. Anything else the server sends —
 *  today nothing, but `.loose()` would pass a future field through — is dropped
 *  here so an internal URL can never reach a React tree or a browser devtools
 *  network panel replay. */
function pickEndpoint(endpoint: FeishuEndpointHealth): FeishuEndpointHealth {
  return {
    name: endpoint.name,
    status: endpoint.status,
    checkedAt: endpoint.checkedAt,
    latencyMs: endpoint.latencyMs,
    version: endpoint.version,
    capabilities: endpoint.capabilities,
    errorCode: endpoint.errorCode,
    sourceCount: endpoint.sourceCount,
  };
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

// Module-level helpers rather than private methods: the facade in client.ts
// merges each endpoint class into one interface, and a private member there
// would be unimplementable by the composed class.
async function messageAction(
  http: HttpClient,
  workspaceId: string,
  messageId: string,
  action: string,
  body: unknown,
): Promise<FeishuMessageActionResult> {
  const raw = await http.fetch<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/messages/${encodeURIComponent(messageId)}/${action}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return parseWithFallback<FeishuMessageActionResult>(raw, FeishuMessageActionResponseSchema, { outcomes: [] }, {
    endpoint: `POST /api/workspaces/:id/feishu/messages/:messageId/${action}`,
  });
}

async function proposalAction(
  http: HttpClient,
  workspaceId: string,
  proposalId: string,
  action: "approve" | "reject",
): Promise<FeishuMessageActionResult> {
  const raw = await http.fetch<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/proposals/${encodeURIComponent(proposalId)}/${action}`,
    { method: "POST" },
  );
  return parseWithFallback<FeishuMessageActionResult>(raw, FeishuMessageActionResponseSchema, { outcomes: [] }, {
    endpoint: `POST /api/workspaces/:id/feishu/proposals/:proposalId/${action}`,
  });
}

export class FeishuEndpoints {
  constructor(readonly http: HttpClient) {}

  async listFeishuEndpoints(workspaceId: string): Promise<FeishuEndpointList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/endpoints`,
    );
    const parsed = parseWithFallback(raw, FeishuEndpointListResponseSchema, EMPTY_FEISHU_ENDPOINT_LIST, {
      endpoint: "GET /api/workspaces/:id/feishu/endpoints",
    });
    return { configured: parsed.configured, endpoints: parsed.endpoints.map(pickEndpoint) };
  }

  async checkFeishuEndpoint(workspaceId: string, name: string): Promise<FeishuEndpointHealth> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/endpoints/${encodeURIComponent(name)}/check`,
      { method: "POST" },
    );
    const parsed = parseStrictResponse<{ endpoint: FeishuEndpointHealth }>(raw, FeishuEndpointCheckResponseSchema, {
      endpoint: "POST /api/workspaces/:id/feishu/endpoints/:name/check",
    });
    return pickEndpoint(parsed.endpoint);
  }

  async listFeishuSources(workspaceId: string): Promise<FeishuSourceList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources`,
    );
    return parseWithFallback(raw, FeishuSourceListResponseSchema, EMPTY_FEISHU_SOURCE_LIST, {
      endpoint: "GET /api/workspaces/:id/feishu/sources",
    });
  }

  async createFeishuSource(workspaceId: string, input: FeishuSourceInput): Promise<FeishuSource> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseStrictResponse<{ source: FeishuSource }>(raw, FeishuSourceResponseSchema, {
      endpoint: "POST /api/workspaces/:id/feishu/sources",
    }).source;
  }

  async updateFeishuSource(
    workspaceId: string,
    sourceId: string,
    input: FeishuSourceInput,
  ): Promise<FeishuSource> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return parseStrictResponse<{ source: FeishuSource }>(raw, FeishuSourceResponseSchema, {
      endpoint: "PATCH /api/workspaces/:id/feishu/sources/:sourceId",
    }).source;
  }

  async deleteFeishuSource(workspaceId: string, sourceId: string): Promise<void> {
    await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources/${encodeURIComponent(sourceId)}`,
      { method: "DELETE" },
    );
  }

  async getFeishuSourceStatus(workspaceId: string, sourceId: string): Promise<FeishuSourceStatus> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources/${encodeURIComponent(sourceId)}/status`,
    );
    return parseStrictResponse<{ status: FeishuSourceStatus }>(raw, FeishuSourceStatusResponseSchema, {
      endpoint: "GET /api/workspaces/:id/feishu/sources/:sourceId/status",
    }).status;
  }

  async listFeishuAvailableChats(
    workspaceId: string,
    sourceId: string,
    params: { q?: string; scope?: string; limit?: number } = {},
  ): Promise<FeishuAvailableChats> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/sources/${encodeURIComponent(sourceId)}`
      + `/available-chats${query(params)}`,
    );
    return parseWithFallback(raw, FeishuAvailableChatsResponseSchema, EMPTY_FEISHU_AVAILABLE_CHATS, {
      endpoint: "GET /api/workspaces/:id/feishu/sources/:sourceId/available-chats",
    });
  }

  async listFeishuMessages(workspaceId: string, params: FeishuMessageListParams = {}): Promise<FeishuMessageList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/messages${query({ ...params })}`,
    );
    return parseWithFallback(raw, FeishuMessageListResponseSchema, EMPTY_FEISHU_MESSAGE_LIST, {
      endpoint: "GET /api/workspaces/:id/feishu/messages",
    });
  }

  async listFeishuChats(workspaceId: string): Promise<FeishuChatList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/chats`,
    );
    return parseWithFallback(raw, FeishuChatListResponseSchema, EMPTY_FEISHU_CHAT_LIST, {
      endpoint: "GET /api/workspaces/:id/feishu/chats",
    });
  }

  async listFeishuProposals(
    workspaceId: string,
    params: { status?: string; source?: string; limit?: number; offset?: number } = {},
  ): Promise<FeishuProposalList> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/proposals${query({ ...params })}`,
    );
    return parseWithFallback(raw, FeishuProposalListResponseSchema, EMPTY_FEISHU_PROPOSAL_LIST, {
      endpoint: "GET /api/workspaces/:id/feishu/proposals",
    });
  }

  /** Records a terminal outcome (`ignored` / `dismissed`) or marks the message
   *  processed. Never touches Feishu itself. */
  resolveFeishuMessage(
    workspaceId: string,
    messageId: string,
    input: { outcome: string; reason?: string | null; ref?: string | null },
  ): Promise<FeishuMessageActionResult> {
    return messageAction(this.http, workspaceId, messageId, "resolve", input);
  }

  notifyFeishuMessage(workspaceId: string, messageId: string, summary: string): Promise<FeishuMessageActionResult> {
    return messageAction(this.http, workspaceId, messageId, "notify", { summary });
  }

  /** Creates an Inbox draft for a human to act on. This deliberately does not
   *  send anything back to Feishu — sending stays a separate, human-approved
   *  path outside this feature. */
  draftFeishuMessageReply(
    workspaceId: string,
    messageId: string,
    draftText: string,
  ): Promise<FeishuMessageActionResult> {
    return messageAction(this.http, workspaceId, messageId, "draft-reply", { draftText });
  }

  proposeFeishuMessageIssue(
    workspaceId: string,
    messageId: string,
    input: FeishuIssueInput,
  ): Promise<FeishuMessageActionResult> {
    return messageAction(this.http, workspaceId, messageId, "propose-issue", input);
  }

  createFeishuMessageIssue(
    workspaceId: string,
    messageId: string,
    input: FeishuIssueInput,
  ): Promise<FeishuMessageActionResult> {
    return messageAction(this.http, workspaceId, messageId, "create-issue", input);
  }

  approveFeishuProposal(workspaceId: string, proposalId: string): Promise<FeishuMessageActionResult> {
    return proposalAction(this.http, workspaceId, proposalId, "approve");
  }

  rejectFeishuProposal(workspaceId: string, proposalId: string): Promise<FeishuMessageActionResult> {
    return proposalAction(this.http, workspaceId, proposalId, "reject");
  }
}
