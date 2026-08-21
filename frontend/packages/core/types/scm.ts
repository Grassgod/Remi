export type ScmProvider = "github" | "codebase";

export type ScmConnectionMode = "poll" | "webhook" | "hybrid";

export type ScmSyncStream =
  | "default_branch"
  | "change_requests"
  | "comments"
  | "reviews"
  | "pipelines";

export interface ScmStreamCapability {
  poll: boolean;
  webhook: boolean;
  pollFidelity: "exact" | "inferred" | null;
  webhookFidelity: "exact" | "inferred" | null;
  limitations: string[];
}

export interface ScmProviderCapabilities {
  provider: ScmProvider;
  streams: Record<ScmSyncStream, ScmStreamCapability>;
  supportsDeleteTombstones: boolean;
  supportsConditionalRequests: boolean;
}

export interface ScmCapabilitiesResponse {
  providers: Record<ScmProvider, ScmProviderCapabilities>;
}

export type CanonicalScmEventType =
  | "change.opened"
  | "change.updated"
  | "change.closed"
  | "change.reopened"
  | "change.merged"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "review.submitted"
  | "review.dismissed"
  | "pipeline.started"
  | "pipeline.completed"
  | "default_branch.updated"
  | "push.observed";

export interface ScmRepositoryBinding {
  id: string;
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  repositoryUrl: string;
  externalId: string | null;
  owner: string | null;
  name: string;
  defaultBranch: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScmConnection {
  id: string;
  workspaceId: string;
  name: string;
  provider: ScmProvider;
  mode: ScmConnectionMode;
  baseUrl: string | null;
  apiBaseUrl: string | null;
  enabled: boolean;
  pollIntervalSeconds: number;
  accessTokenSet: boolean;
  accessTokenHint: string | null;
  webhookSecretSet: boolean;
  webhookSecretHint: string | null;
  createdAt: string;
  updatedAt: string;
  repositories: ScmRepositoryBinding[];
}

export interface ListScmConnectionsResponse {
  connections: ScmConnection[];
}

export interface ScmConnectionResponse {
  connection: ScmConnection | null;
}

export interface CreateScmConnectionRequest {
  name: string;
  provider: ScmProvider;
  mode: ScmConnectionMode;
  baseUrl?: string;
  apiBaseUrl?: string;
  accessToken?: string;
  webhookSecret?: string;
  pollIntervalSeconds?: number;
  enabled?: boolean;
  repositoryIds?: string[];
}

export interface UpdateScmConnectionRequest {
  name?: string;
  mode?: ScmConnectionMode;
  baseUrl?: string | null;
  apiBaseUrl?: string | null;
  accessToken?: string;
  clearAccessToken?: boolean;
  webhookSecret?: string;
  clearWebhookSecret?: boolean;
  pollIntervalSeconds?: number;
  enabled?: boolean;
}

export interface UpdateScmRepositoryBindingRequest {
  externalId?: string;
  owner?: string;
  enabled?: boolean;
}

export interface CanonicalScmEvent {
  id: string;
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  provider: ScmProvider;
  type: CanonicalScmEventType;
  subjectType: string;
  subjectId: string;
  logicalKey: string;
  primarySource: "poll" | "webhook";
  fidelity: "exact" | "inferred";
  occurredAt: string | null;
  observedAt: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "processed" | "failed";
  attemptCount: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface ListScmEventsResponse {
  events: CanonicalScmEvent[];
  total: number;
  nextAfter: string | null;
}
