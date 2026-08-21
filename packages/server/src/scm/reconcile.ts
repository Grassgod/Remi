import { createHash } from "node:crypto";
import type {
  MultiremiScmEntitySnapshot,
  MultiremiScmEventFidelity,
  MultiremiScmEventSource,
  MultiremiScmRepositoryBinding,
} from "@multiremi/contracts/types.js";
import type {
  ScmCanonicalCandidate,
  ScmEntityObservation,
  ScmIngestionStore,
  ScmRecordResult,
} from "./types.js";

export interface ReconcileObservationInput {
  store: ScmIngestionStore;
  binding: MultiremiScmRepositoryBinding;
  observation: ScmEntityObservation;
  baseline: boolean;
  source?: MultiremiScmEventSource;
  fidelity?: MultiremiScmEventFidelity;
  providerEventId?: string | null;
  evidencePayload?: Record<string, unknown> | null;
  rawBody?: string | null;
}

export interface ReconcileObservationResult {
  changed: boolean;
  snapshot: MultiremiScmEntitySnapshot;
  events: ScmRecordResult[];
}

export function reconcileObservation(input: ReconcileObservationInput): ReconcileObservationResult {
  const {
    store,
    binding,
    observation,
    baseline,
    source = "poll",
    fidelity = source === "webhook" ? "exact" : "inferred",
  } = input;
  const previous = store.getEntitySnapshot(
    binding.connectionId,
    binding.repositoryId,
    observation.entityType,
    observation.externalId,
  );
  const contentHash = stableJsonHash(observation.payload);
  const changed = previous?.contentHash !== contentHash || previous?.version !== observation.version;
  const snapshot = store.upsertEntitySnapshot({
    connectionId: binding.connectionId,
    repositoryId: binding.repositoryId,
    entityType: observation.entityType,
    externalId: observation.externalId,
    version: observation.version,
    contentHash,
    payload: observation.payload,
    observedAt: observation.observedAt,
  });
  if (!changed || baseline) return { changed, snapshot, events: [] };

  const candidates = deriveCanonicalCandidates(observation, previous);
  const events = candidates.map((candidate) => {
    const logicalKey = buildScmLogicalKey(binding.repositoryId, candidate);
    return store.recordCanonicalEvent({
      workspaceId: binding.workspaceId,
      connectionId: binding.connectionId,
      repositoryId: binding.repositoryId,
      type: candidate.type,
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      logicalKey,
      fidelity,
      occurredAt: candidate.occurredAt,
      observedAt: observation.observedAt,
      payload: candidate.payload,
      evidence: {
        source,
        providerEventId: input.providerEventId ?? null,
        dedupeKey: buildEvidenceDedupeKey(source, input.providerEventId, logicalKey, contentHash),
        payload: input.evidencePayload ?? observation.payload,
        rawBody: input.rawBody ?? null,
      },
    });
  });
  return { changed, snapshot, events };
}

export function deriveCanonicalCandidates(
  observation: ScmEntityObservation,
  previous: MultiremiScmEntitySnapshot | null,
): ScmCanonicalCandidate[] {
  const current = observation.payload;
  const prior = previous?.payload ?? null;
  if (observation.stream === "default_branch") {
    const branch = stringValue(current.branch) || "HEAD";
    const headSha = stringValue(current.head_sha);
    if (!headSha || (prior && stringValue(prior.head_sha) === headSha)) return [];
    const common = {
      subjectType: "ref",
      subjectId: branch,
      logicalVersion: headSha,
      occurredAt: observation.occurredAt,
      payload: current,
    };
    return [
      { type: "default_branch.updated", ...common },
      { type: "push.observed", ...common },
    ];
  }

  if (observation.stream === "change_requests") {
    const state = normalizeChangeState(current.state);
    const priorState = prior ? normalizeChangeState(prior.state) : null;
    let type: ScmCanonicalCandidate["type"];
    if (!prior || priorState !== state) {
      type = state === "merged"
        ? "change.merged"
        : state === "closed"
          ? "change.closed"
          : priorState === "closed" || priorState === "merged"
            ? "change.reopened"
            : "change.opened";
    } else {
      type = "change.updated";
    }
    return [{
      type,
      subjectType: "change_request",
      subjectId: observation.externalId,
      logicalVersion: logicalVersion(observation, state),
      occurredAt: eventOccurredAt(type, current, observation.occurredAt),
      payload: current,
    }];
  }

  if (observation.stream === "comments") {
    const deleted = current.deleted === true;
    return [{
      type: deleted ? "comment.deleted" : previous ? "comment.updated" : "comment.created",
      subjectType: "comment",
      subjectId: observation.externalId,
      logicalVersion: logicalVersion(observation, deleted ? "deleted" : previous ? "updated" : "created"),
      occurredAt: observation.occurredAt,
      payload: current,
    }];
  }

  if (observation.stream === "reviews") {
    const state = stringValue(current.state).toLowerCase();
    const dismissed = state === "dismissed" || current.dismissed === true;
    return [{
      type: dismissed ? "review.dismissed" : "review.submitted",
      subjectType: "review",
      subjectId: observation.externalId,
      logicalVersion: logicalVersion(observation, state || "submitted"),
      occurredAt: observation.occurredAt,
      payload: current,
    }];
  }

  if (observation.stream === "pipelines") {
    const status = stringValue(current.status).toLowerCase();
    const completed = status === "completed" || Boolean(current.conclusion) || current.completed === true;
    return [{
      type: completed ? "pipeline.completed" : "pipeline.started",
      subjectType: "pipeline",
      subjectId: observation.externalId,
      logicalVersion: logicalVersion(observation, completed ? stringValue(current.conclusion) || "completed" : status || "started"),
      occurredAt: observation.occurredAt,
      payload: current,
    }];
  }

  return [];
}

export function buildScmLogicalKey(repositoryId: string, candidate: ScmCanonicalCandidate): string {
  return [
    candidate.type,
    repositoryId,
    candidate.subjectType,
    candidate.subjectId,
    candidate.logicalVersion,
  ].map(encodeLogicalKeyPart).join(":");
}

export function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function buildEvidenceDedupeKey(
  source: MultiremiScmEventSource,
  providerEventId: string | null | undefined,
  logicalKey: string,
  contentHash: string,
): string {
  if (providerEventId) return `${source}:${providerEventId}:${logicalKey}`;
  return `${source}:${logicalKey}:${contentHash}`;
}

function logicalVersion(observation: ScmEntityObservation, suffix: string): string {
  return [observation.version || stableJsonHash(observation.payload), suffix].join(":");
}

function eventOccurredAt(
  type: ScmCanonicalCandidate["type"],
  payload: Record<string, unknown>,
  fallback: string | null,
): string | null {
  if (type === "change.merged") return nullableString(payload.merged_at) ?? fallback;
  if (type === "change.closed") return nullableString(payload.closed_at) ?? fallback;
  return fallback;
}

function normalizeChangeState(value: unknown): "open" | "closed" | "merged" {
  const state = stringValue(value).toLowerCase();
  if (state === "merged" || state === "merge") return "merged";
  if (state === "closed" || state === "close" || state === "declined") return "closed";
  return "open";
}

function encodeLogicalKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

