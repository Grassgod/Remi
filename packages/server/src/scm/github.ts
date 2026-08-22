import { createHmac, timingSafeEqual } from "node:crypto";
import type { MultiremiScmSyncStream } from "@multiremi/contracts/types.js";
import { GITHUB_SCM_CAPABILITIES } from "./capabilities.js";
import { appendQuery, hasNextLink, lowerCaseHeaders, scmRequestJson } from "./http.js";
import { stableJsonHash } from "./reconcile.js";
import type {
  ScmEntityObservation,
  ScmPollContext,
  ScmPollPage,
  ScmProviderAdapter,
  ScmWebhookCandidate,
  ScmWebhookParseResult,
  ScmWebhookRequest,
} from "./types.js";

const PAGE_SIZE = 100;
const OVERLAP_MS = 2 * 60 * 1000;

export class GitHubScmProviderAdapter implements ScmProviderAdapter {
  readonly provider = "github" as const;
  readonly capabilities = GITHUB_SCM_CAPABILITIES;

  async poll(context: ScmPollContext): Promise<ScmPollPage> {
    switch (context.stream) {
      case "default_branch": return this.pollDefaultBranch(context);
      case "change_requests": return this.pollPullRequests(context);
      case "comments": return this.pollComments(context);
      case "reviews": return this.pollReviews(context);
      case "pipelines": return this.pollPipelines(context);
    }
  }

  verifyWebhook(request: ScmWebhookRequest): boolean {
    const secret = request.credential.webhookSecret?.trim();
    if (!secret) return false;
    const signature = lowerCaseHeaders(request.headers)["x-hub-signature-256"] ?? "";
    if (!signature.startsWith("sha256=")) return false;
    const actualHex = signature.slice("sha256=".length);
    if (!/^[0-9a-f]{64}$/iu.test(actualHex)) return false;
    const expected = createHmac("sha256", secret).update(request.rawBody).digest();
    const actual = Buffer.from(actualHex, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  parseWebhook(request: ScmWebhookRequest): ScmWebhookParseResult {
    const headers = lowerCaseHeaders(request.headers);
    const providerEvent = headers["x-github-event"]?.trim() || "unknown";
    const deliveryId = headers["x-github-delivery"]?.trim() || null;
    const body = request.body;
    const repository = record(body.repository);
    const owner = stringAt(repository, "owner", "login") || stringValue(repository.owner_name);
    const name = stringValue(repository.name);
    const repositoryExternalId = nullableString(repository.id) ?? (owner && name ? `${owner}/${name}` : null);
    const candidates: ScmWebhookCandidate[] = [];
    const base = { repositoryExternalId, repositoryOwner: owner || null, repositoryName: name || null, providerEventId: deliveryId };

    if (providerEvent === "pull_request") {
      const pull = record(body.pull_request);
      const action = stringValue(body.action).toLowerCase();
      const normalized = normalizeGitHubPull(pull);
      const subjectId = stringValue(pull.id) || stringValue(pull.number);
      const version = changeVersion(normalized);
      const type = pull.merged === true || action === "merged"
        ? "change.merged"
        : action === "closed"
          ? "change.closed"
          : action === "reopened"
            ? "change.reopened"
            : action === "opened"
              ? "change.opened"
              : "change.updated";
      const state = type === "change.merged" ? "merged" : type === "change.closed" ? "closed" : "open";
      const occurredAt = type === "change.merged"
        ? nullableString(normalized.merged_at)
        : type === "change.closed"
          ? nullableString(normalized.closed_at)
          : nullableString(normalized.updated_at);
      candidates.push({
        ...base,
        type,
        subjectType: "change_request",
        subjectId,
        logicalVersion: `${version}:${state}`,
        occurredAt,
        payload: normalized,
        snapshotObservation: webhookObservation(
          "change_requests", "change_request", subjectId, version, occurredAt, request.observedAt, normalized,
        ),
      });
    } else if (providerEvent === "issue_comment" || providerEvent === "pull_request_review_comment") {
      if (providerEvent === "issue_comment" && !isPullRequestIssue(record(body.issue))) {
        return {
          providerEvent,
          deliveryId,
          candidates: [],
          ignoredReason: "GitHub issue comment is not attached to a pull request",
        };
      }
      const comment = record(body.comment);
      const action = stringValue(body.action).toLowerCase();
      const normalized = normalizeGitHubComment(comment, providerEvent === "issue_comment" ? "issue" : "review");
      const type = action === "deleted" ? "comment.deleted" : action === "edited" ? "comment.updated" : "comment.created";
      const subjectId = stringValue(comment.id);
      const version = commentVersion(normalized);
      const occurredAt = type === "comment.deleted"
        ? request.observedAt
        : nullableString(normalized.updated_at) ?? nullableString(normalized.created_at);
      candidates.push({
        ...base,
        type,
        subjectType: "comment",
        subjectId,
        logicalVersion: `${version}:${type.split(".")[1]}`,
        occurredAt,
        payload: { ...normalized, deleted: type === "comment.deleted" },
        snapshotObservation: webhookObservation(
          "comments",
          "comment",
          subjectId,
          version,
          occurredAt,
          request.observedAt,
          { ...normalized, deleted: type === "comment.deleted" },
        ),
      });
    } else if (providerEvent === "pull_request_review") {
      const review = record(body.review);
      const action = stringValue(body.action).toLowerCase();
      const normalized = normalizeGitHubReview(review, record(body.pull_request));
      const dismissed = action === "dismissed" || stringValue(review.state).toLowerCase() === "dismissed";
      const subjectId = stringValue(review.id);
      const version = reviewVersion(normalized);
      const occurredAt = dismissed ? request.observedAt : nullableString(normalized.submitted_at);
      candidates.push({
        ...base,
        type: dismissed ? "review.dismissed" : "review.submitted",
        subjectType: "review",
        subjectId,
        logicalVersion: `${version}:${dismissed ? "dismissed" : stringValue(normalized.state).toLowerCase() || "submitted"}`,
        occurredAt,
        payload: normalized,
        snapshotObservation: webhookObservation(
          "reviews", "review", subjectId, version, occurredAt, request.observedAt, normalized,
        ),
      });
    } else if (providerEvent === "workflow_run") {
      const pipeline = record(body.workflow_run);
      const normalized = normalizeGitHubWorkflowRun(pipeline);
      const completed = stringValue(normalized.status).toLowerCase() === "completed" || Boolean(normalized.conclusion);
      const subjectId = githubWorkflowRunSubjectId(pipeline);
      const version = pipelineVersion(normalized);
      const occurredAt = nullableString(normalized.updated_at) ?? nullableString(normalized.created_at);
      candidates.push({
        ...base,
        type: completed ? "pipeline.completed" : "pipeline.started",
        subjectType: "pipeline",
        subjectId,
        logicalVersion: `${version}:${completed ? stringValue(normalized.conclusion) || "completed" : stringValue(normalized.status) || "started"}`,
        occurredAt,
        payload: normalized,
        snapshotObservation: webhookObservation(
          "pipelines", "pipeline", subjectId, version, occurredAt, request.observedAt, normalized,
        ),
      });
    } else if (providerEvent === "check_run") {
      return {
        providerEvent,
        deliveryId,
        candidates: [],
        ignoredReason: "GitHub check_run is ignored; canonical pipeline events support Actions workflow_run only",
      };
    } else if (providerEvent === "push") {
      const ref = stringValue(body.ref).replace(/^refs\/heads\//u, "");
      const after = stringValue(body.after);
      const defaultBranch = stringValue(repository.default_branch);
      const payload = {
        branch: ref,
        ref: stringValue(body.ref),
        head_sha: after,
        before_sha: nullableString(body.before),
        forced: body.forced === true,
        pusher: stringAt(record(body.pusher), "name") || null,
      };
      const common = {
        ...base,
        subjectType: "ref",
        subjectId: ref || "HEAD",
        logicalVersion: after,
        occurredAt: nullableString(record(body.head_commit).timestamp) ?? request.observedAt,
        payload,
      };
      candidates.push({ ...common, type: "push.observed" });
      if (ref && ref === defaultBranch) {
        candidates.push({
          ...common,
          type: "default_branch.updated",
          snapshotObservation: webhookObservation(
            "default_branch", "ref", ref, after, common.occurredAt, request.observedAt, payload,
          ),
        });
      }
    }

    const validCandidates = candidates.filter(validWebhookCandidate);
    return {
      providerEvent,
      deliveryId,
      candidates: validCandidates,
      ignoredReason: validCandidates.length ? null : `unsupported or malformed GitHub event: ${providerEvent}`,
    };
  }

  private async pollDefaultBranch(context: ScmPollContext): Promise<ScmPollPage> {
    const repo = await this.get<Record<string, unknown>>(context, this.repoPath(context));
    const branch = context.binding.defaultBranch || stringValue(repo.data.default_branch);
    if (!branch) throw new Error("GitHub repository has no default branch");
    const branchResult = await this.get<Record<string, unknown>>(context, `${this.repoPath(context)}/branches/${encodeURIComponent(branch)}`);
    const commit = record(branchResult.data.commit);
    const observedAt = context.now.toISOString();
    return {
      observations: [{
        stream: "default_branch",
        entityType: "ref",
        externalId: branch,
        version: stringValue(commit.sha) || null,
        occurredAt: nullableString(record(record(commit.commit).committer).date) ?? observedAt,
        observedAt,
        payload: { branch, head_sha: stringValue(commit.sha), protected: branchResult.data.protected === true },
      }],
      cursor: null,
      watermark: observedAt,
      done: true,
    };
  }

  private async pollPullRequests(context: ScmPollContext): Promise<ScmPollPage> {
    const page = cursorNumber(context, "page", 1);
    const threshold = overlapWatermark(context.cursor?.watermark);
    const response = await this.get<unknown[]>(context, appendQuery(this.apiUrl(context, `${this.repoPath(context)}/pulls`), {
      state: "all", sort: "updated", direction: "desc", per_page: PAGE_SIZE, page,
    }), true);
    const pulls = arrayRecords(response.data);
    const observations = pulls
      .filter((pull) => !threshold || timestampValue(pull.updated_at) >= threshold)
      .map((pull) => githubPullObservation(pull, context.now));
    const reachedWatermark = Boolean(threshold && pulls.some((pull) => timestampValue(pull.updated_at) < threshold));
    const hasNext = hasNextLink(response.headers.get("link")) && !reachedWatermark;
    return {
      observations,
      cursor: hasNext ? { page: page + 1 } : null,
      watermark: context.now.toISOString(),
      done: !hasNext,
    };
  }

  private async pollComments(context: ScmPollContext): Promise<ScmPollPage> {
    const kind = cursorString(context, "kind") === "review" ? "review" : "issue";
    const page = cursorNumber(context, "page", 1);
    const path = kind === "issue" ? "issues/comments" : "pulls/comments";
    const since = overlapWatermarkIso(context.cursor?.watermark);
    const response = await this.get<unknown[]>(context, appendQuery(this.apiUrl(context, `${this.repoPath(context)}/${path}`), {
      sort: "updated", direction: "asc", since, per_page: PAGE_SIZE, page,
    }), true);
    const comments = arrayRecords(response.data);
    const observations = comments
      .filter((comment) => kind === "review" || isPullRequestIssueCommentRecord(comment))
      .map((comment) => githubCommentObservation(comment, kind, context.now));
    const hasNext = hasNextLink(response.headers.get("link"));
    const nextKind = kind === "issue" && !hasNext ? "review" : kind;
    const done = kind === "review" && !hasNext;
    return {
      observations,
      cursor: done ? null : { kind: nextKind, page: hasNext ? page + 1 : 1 },
      watermark: context.now.toISOString(),
      done,
    };
  }

  private async pollReviews(context: ScmPollContext): Promise<ScmPollPage> {
    const page = cursorNumber(context, "page", 1);
    const threshold = overlapWatermark(context.cursor?.watermark);
    const response = await this.get<unknown[]>(context, appendQuery(this.apiUrl(context, `${this.repoPath(context)}/pulls`), {
      state: "all", sort: "updated", direction: "desc", per_page: PAGE_SIZE, page,
    }), true);
    const batch = arrayRecords(response.data);
    const pulls = batch.filter((pull) => !threshold || timestampValue(pull.updated_at) >= threshold);
    const observations: ScmEntityObservation[] = [];
    for (const pull of pulls) {
      const number = numberValue(pull.number);
      if (!number) continue;
      for (let reviewPage = 1; ; reviewPage += 1) {
        const reviewsResponse = await this.get<unknown[]>(context, appendQuery(this.apiUrl(context, `${this.repoPath(context)}/pulls/${number}/reviews`), {
          per_page: PAGE_SIZE,
          page: reviewPage,
        }), true);
        for (const review of arrayRecords(reviewsResponse.data)) {
          observations.push(githubReviewObservation(review, pull, context.now));
        }
        if (!hasNextLink(reviewsResponse.headers.get("link"))) break;
      }
    }
    const reachedWatermark = Boolean(threshold && batch.some((pull) => timestampValue(pull.updated_at) < threshold));
    const hasNext = hasNextLink(response.headers.get("link")) && !reachedWatermark;
    return {
      observations,
      cursor: hasNext ? { page: page + 1 } : null,
      watermark: context.now.toISOString(),
      done: !hasNext,
    };
  }

  private async pollPipelines(context: ScmPollContext): Promise<ScmPollPage> {
    const page = cursorNumber(context, "page", 1);
    const threshold = overlapWatermark(context.cursor?.watermark);
    const response = await this.get<Record<string, unknown>>(context, appendQuery(this.apiUrl(context, `${this.repoPath(context)}/actions/runs`), {
      per_page: PAGE_SIZE, page,
    }), true);
    const runs = arrayRecords(response.data.workflow_runs);
    const observations = runs
      .filter((run) => !threshold || timestampValue(run.updated_at) >= threshold)
      .map((run) => githubWorkflowRunObservation(run, context.now));
    const hasNext = runs.length === PAGE_SIZE;
    return {
      observations,
      cursor: hasNext ? { page: page + 1 } : null,
      watermark: context.now.toISOString(),
      done: !hasNext,
    };
  }

  private repoPath(context: ScmPollContext): string {
    const owner = context.binding.owner?.trim();
    if (!owner || !context.binding.name.trim()) throw new Error("GitHub repository binding requires owner and name");
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(context.binding.name)}`;
  }

  private apiUrl(context: ScmPollContext, path: string): string {
    return `${context.connection.apiBaseUrl.replace(/\/$/u, "")}${path}`;
  }

  private async get<T>(context: ScmPollContext, pathOrUrl: string, absolute = false) {
    const url = absolute ? pathOrUrl : this.apiUrl(context, pathOrUrl);
    const token = context.credential.accessToken?.trim();
    context.heartbeat?.();
    try {
      return await scmRequestJson<T>(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "multiremi-scm-poller",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, { signal: context.signal });
    } finally {
      context.heartbeat?.();
    }
  }
}

function githubPullObservation(pull: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeGitHubPull(pull);
  return {
    stream: "change_requests",
    entityType: "change_request",
    externalId: stringValue(pull.id) || stringValue(pull.number),
    version: changeVersion(payload),
    occurredAt: nullableString(payload.updated_at) ?? now.toISOString(),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeGitHubPull(pull: Record<string, unknown>): Record<string, unknown> {
  const head = record(pull.head);
  const base = record(pull.base);
  return {
    id: nullableString(pull.id),
    number: numberValue(pull.number),
    title: stringValue(pull.title),
    body: nullableString(pull.body),
    state: pull.merged === true || nullableString(pull.merged_at) ? "merged" : stringValue(pull.state) || "open",
    draft: pull.draft === true,
    url: nullableString(pull.html_url),
    source_branch: stringValue(head.ref),
    target_branch: stringValue(base.ref),
    head_sha: stringAt(head, "sha"),
    base_sha: stringAt(base, "sha"),
    author: stringAt(record(pull.user), "login") || null,
    created_at: nullableString(pull.created_at),
    updated_at: nullableString(pull.updated_at),
    closed_at: nullableString(pull.closed_at),
    merged_at: nullableString(pull.merged_at),
    merge_sha: nullableString(pull.merge_commit_sha),
    mergeable_state: nullableString(pull.mergeable_state),
    checks_conclusion: nullableString(pull.checks_conclusion),
    checks_passed: numberValue(pull.checks_passed),
    checks_failed: numberValue(pull.checks_failed),
    checks_pending: numberValue(pull.checks_pending),
    additions: numberValue(pull.additions),
    deletions: numberValue(pull.deletions),
    changed_files: numberValue(pull.changed_files),
  };
}

function githubCommentObservation(comment: Record<string, unknown>, kind: "issue" | "review", now: Date): ScmEntityObservation {
  const payload = normalizeGitHubComment(comment, kind);
  return {
    stream: "comments",
    entityType: "comment",
    externalId: stringValue(comment.id),
    version: commentVersion(payload),
    occurredAt: nullableString(payload.updated_at) ?? nullableString(payload.created_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeGitHubComment(comment: Record<string, unknown>, kind: "issue" | "review"): Record<string, unknown> {
  return {
    id: nullableString(comment.id),
    kind,
    change_url: nullableString(comment.pull_request_url) ?? nullableString(comment.issue_url),
    body: stringValue(comment.body),
    author: stringAt(record(comment.user), "login") || null,
    path: nullableString(comment.path),
    line: numberValue(comment.line),
    created_at: nullableString(comment.created_at),
    updated_at: nullableString(comment.updated_at),
    deleted: false,
  };
}

function githubReviewObservation(review: Record<string, unknown>, pull: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeGitHubReview(review, pull);
  return {
    stream: "reviews",
    entityType: "review",
    externalId: stringValue(review.id),
    version: reviewVersion(payload),
    occurredAt: nullableString(payload.submitted_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeGitHubReview(review: Record<string, unknown>, pull: Record<string, unknown>): Record<string, unknown> {
  return {
    id: nullableString(review.id),
    change_id: nullableString(pull.id),
    change_number: numberValue(pull.number),
    state: stringValue(review.state).toLowerCase(),
    body: stringValue(review.body),
    author: stringAt(record(review.user), "login") || null,
    commit_sha: nullableString(review.commit_id),
    submitted_at: nullableString(review.submitted_at),
  };
}

function githubWorkflowRunObservation(pipeline: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeGitHubWorkflowRun(pipeline);
  return {
    stream: "pipelines",
    entityType: "pipeline",
    externalId: githubWorkflowRunSubjectId(pipeline),
    version: pipelineVersion(payload),
    occurredAt: nullableString(payload.updated_at) ?? nullableString(payload.created_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeGitHubWorkflowRun(pipeline: Record<string, unknown>): Record<string, unknown> {
  return {
    id: nullableString(pipeline.id),
    kind: "workflow_run",
    name: stringValue(pipeline.name),
    status: stringValue(pipeline.status).toLowerCase(),
    conclusion: nullableString(pipeline.conclusion),
    head_sha: nullableString(pipeline.head_sha),
    branch: nullableString(pipeline.head_branch),
    event: nullableString(pipeline.event),
    attempt: numberValue(pipeline.run_attempt) ?? 1,
    url: nullableString(pipeline.html_url),
    created_at: nullableString(pipeline.created_at),
    updated_at: nullableString(pipeline.updated_at) ?? nullableString(pipeline.completed_at),
  };
}

function changeVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.updated_at) || "unknown-time",
    stringValue(payload.head_sha),
    stringValue(payload.state),
    stableJsonHash({ title: payload.title, draft: payload.draft, target_branch: payload.target_branch }),
  ].join(":");
}

function commentVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.updated_at) || nullableString(payload.created_at) || stringValue(payload.id),
    stableJsonHash({ body: payload.body, path: payload.path, line: payload.line }),
  ].join(":");
}

function reviewVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.submitted_at) || "unknown-time",
    stringValue(payload.commit_sha),
    stringValue(payload.state),
    stableJsonHash(payload.body),
  ].join(":");
}

function pipelineVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.updated_at) || "unknown-time",
    stringValue(payload.status),
    stringValue(payload.conclusion),
    String(numberValue(payload.attempt) ?? 1),
    stringValue(payload.head_sha),
  ].join(":");
}

function githubWorkflowRunSubjectId(pipeline: Record<string, unknown>): string {
  const id = stringValue(pipeline.id);
  if (!id) return "";
  return `workflow_run:${id}:${numberValue(pipeline.run_attempt) ?? 1}`;
}

function webhookObservation(
  stream: ScmEntityObservation["stream"],
  entityType: ScmEntityObservation["entityType"],
  externalId: string,
  version: string | null,
  occurredAt: string | null,
  observedAt: string,
  payload: Record<string, unknown>,
): ScmEntityObservation {
  return { stream, entityType, externalId, version, occurredAt, observedAt, payload };
}

function isPullRequestIssue(issue: Record<string, unknown>): boolean {
  return Object.keys(record(issue.pull_request)).length > 0;
}

function isPullRequestIssueCommentRecord(comment: Record<string, unknown>): boolean {
  if (nullableString(comment.pull_request_url)) return true;
  const htmlUrl = nullableString(comment.html_url);
  if (!htmlUrl) return false;
  try {
    const parsed = new URL(htmlUrl);
    return /\/pull\/\d+(?:\/|#|$)/u.test(parsed.pathname + parsed.hash);
  } catch {
    return /\/pull\/\d+(?:\/|#|$)/u.test(htmlUrl);
  }
}

function validWebhookCandidate(candidate: ScmWebhookCandidate): boolean {
  return Boolean(candidate.subjectId && candidate.logicalVersion && (candidate.repositoryExternalId || (candidate.repositoryOwner && candidate.repositoryName)));
}

function cursorNumber(context: ScmPollContext, key: string, fallback: number): number {
  const value = Number(context.cursor?.cursor?.[key]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function cursorString(context: ScmPollContext, key: string): string {
  return stringValue(context.cursor?.cursor?.[key]);
}

function overlapWatermark(value: string | null | undefined): number | null {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp - OVERLAP_MS : null;
}

function overlapWatermarkIso(value: string | null | undefined): string | null {
  const timestamp = overlapWatermark(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function timestampValue(value: unknown): number {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function stringAt(value: Record<string, unknown>, ...path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return stringValue(current);
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const GITHUB_STREAMS: readonly MultiremiScmSyncStream[] = [
  "default_branch", "change_requests", "comments", "reviews", "pipelines",
];
