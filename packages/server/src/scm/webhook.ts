import type { MultiremiScmRepositoryBinding } from "@multiremi/contracts/types.js";
import { CodebaseScmProviderAdapter } from "./codebase.js";
import { GitHubScmProviderAdapter } from "./github.js";
import { buildScmLogicalKey, stableJsonHash } from "./reconcile.js";
import type {
  ScmIngestionStore,
  ScmProviderAdapter,
  ScmRecordResult,
  ScmWebhookRequest,
} from "./types.js";

export const MAX_SCM_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class ScmWebhookError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 413,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface ScmWebhookIngestResult {
  accepted: true;
  provider: "github" | "codebase";
  providerEvent: string;
  deliveryId: string | null;
  events: ScmRecordResult[];
  ignoredReason: string | null;
}

export class ScmWebhookIngestor {
  private readonly adapters: Map<string, ScmProviderAdapter>;

  constructor(
    private readonly store: ScmIngestionStore,
    adapters: ScmProviderAdapter[] = [new GitHubScmProviderAdapter(), new CodebaseScmProviderAdapter()],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  ingest(input: {
    connectionId: string;
    headers: Record<string, string>;
    rawBody: string;
    body: Record<string, unknown>;
    observedAt?: string;
  }): ScmWebhookIngestResult {
    const connection = this.store.getConnection(input.connectionId);
    if (!connection || !connection.enabled) {
      throw new ScmWebhookError("SCM connection not found", 404, "scm_connection_not_found");
    }
    if (connection.mode !== "webhook" && connection.mode !== "hybrid") {
      throw new ScmWebhookError("SCM connection does not accept webhooks", 409, "scm_webhook_mode_disabled");
    }
    const adapter = this.adapters.get(connection.provider);
    if (!adapter) throw new ScmWebhookError("SCM provider is unsupported", 400, "scm_provider_unsupported");
    const credential = this.store.getConnectionCredential(connection.id);
    if (!credential) {
      throw new ScmWebhookError("SCM webhook credential is unavailable", 401, "scm_webhook_credential_missing");
    }
    const request: ScmWebhookRequest = {
      connection,
      credential,
      headers: input.headers,
      rawBody: input.rawBody,
      body: input.body,
      observedAt: input.observedAt ?? new Date().toISOString(),
    };
    if (!adapter.verifyWebhook(request)) {
      throw new ScmWebhookError("SCM webhook signature is invalid", 401, "scm_webhook_signature_invalid");
    }
    const parsed = adapter.parseWebhook(request);
    const bindings = this.store.listRepositoryBindings({ connectionId: connection.id, enabled: true });
    const events: ScmRecordResult[] = [];
    for (const [index, candidate] of parsed.candidates.entries()) {
      const binding = resolveWebhookBinding(bindings, candidate);
      if (!binding) continue;
      const logicalKey = buildScmLogicalKey(binding.repositoryId, candidate);
      const providerEventId = candidate.providerEventId ?? parsed.deliveryId;
      events.push(this.store.recordCanonicalEvent({
        workspaceId: binding.workspaceId,
        connectionId: binding.connectionId,
        repositoryId: binding.repositoryId,
        type: candidate.type,
        subjectType: candidate.subjectType,
        subjectId: candidate.subjectId,
        logicalKey,
        fidelity: "exact",
        occurredAt: candidate.occurredAt,
        observedAt: request.observedAt,
        payload: candidate.payload,
        evidence: {
          source: "webhook",
          providerEventId,
          dedupeKey: providerEventId
            ? `webhook:${providerEventId}:${index}:${logicalKey}`
            : `webhook:${stableJsonHash(input.rawBody)}:${index}:${logicalKey}`,
          payload: candidate.payload,
          rawBody: input.rawBody,
        },
      }));
    }
    const ignoredReason = parsed.ignoredReason
      ?? (parsed.candidates.length > 0 && events.length === 0 ? "repository is not bound to this connection" : null);
    return {
      accepted: true,
      provider: connection.provider,
      providerEvent: parsed.providerEvent,
      deliveryId: parsed.deliveryId,
      events,
      ignoredReason,
    };
  }
}

function resolveWebhookBinding(
  bindings: MultiremiScmRepositoryBinding[],
  candidate: {
    repositoryExternalId: string | null;
    repositoryOwner: string | null;
    repositoryName: string | null;
  },
): MultiremiScmRepositoryBinding | null {
  if (candidate.repositoryExternalId) {
    const byExternalId = bindings.find((binding) => binding.externalId === candidate.repositoryExternalId);
    if (byExternalId) return byExternalId;
  }
  const owner = candidate.repositoryOwner?.toLowerCase() ?? null;
  const name = candidate.repositoryName?.toLowerCase() ?? null;
  if (!name) return null;
  const sameName = bindings.filter((binding) => binding.name.toLowerCase() === name);
  if (owner) {
    const exact = sameName.find((binding) => binding.owner?.toLowerCase() === owner);
    if (exact) return exact;
  }
  // Legacy imports did not persist owner/externalId. A unique repository name is
  // still unambiguous inside one connection; duplicate names require an explicit binding identity.
  return sameName.length === 1 ? sameName[0]! : null;
}
