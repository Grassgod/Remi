import { timingSafeEqual } from "node:crypto";
import { codebaseAuthHeaders } from "./access-token.js";
import { CODEBASE_SCM_CAPABILITIES } from "./capabilities.js";
import { appendQuery, lowerCaseHeaders, scmRequestJson } from "./http.js";
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

export class CodebaseScmProviderAdapter implements ScmProviderAdapter {
  readonly provider = "codebase" as const;
  readonly capabilities = CODEBASE_SCM_CAPABILITIES;

  async poll(context: ScmPollContext): Promise<ScmPollPage> {
    switch (context.stream) {
      case "default_branch": return this.pollDefaultBranch(context);
      case "change_requests": return this.pollMergeRequests(context);
      case "comments": return this.pollComments(context);
      case "reviews": return this.pollReviews(context);
      case "pipelines": return this.pollPipelines(context);
    }
  }

  verifyWebhook(request: ScmWebhookRequest): boolean {
    const secret = request.credential.webhookSecret?.trim();
    const supplied = lowerCaseHeaders(request.headers)["x-vecode-token"]?.trim();
    if (!secret || !supplied) return false;
    const expectedBytes = Buffer.from(secret);
    const suppliedBytes = Buffer.from(supplied);
    return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
  }

  parseWebhook(request: ScmWebhookRequest): ScmWebhookParseResult {
    const headers = lowerCaseHeaders(request.headers);
    const providerEvent = (headers["x-vecode-event"]?.trim() || stringPick(request.body, "event_name", "event", "Event") || "unknown").toLowerCase();
    const deliveryId = headers["x-vecode-event-id"]?.trim()
      || headers["x-vecode-delivery"]?.trim()
      || nullableString(valuePick(request.body, "event_id", "EventId"));
    const repository = recordPick(request.body, "repository", "Repository", "project", "Project");
    const repositoryExternalId = nullableString(valuePick(repository, "id", "Id", "repo_id", "RepoId"));
    const path = stringPick(repository, "path", "Path", "path_with_namespace", "PathWithNamespace");
    const pathParts = path.split("/").filter(Boolean);
    const repositoryOwner = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : null;
    const repositoryName = stringPick(repository, "name", "Name") || pathParts.at(-1) || null;
    const candidates: ScmWebhookCandidate[] = [];
    const base = { repositoryExternalId, repositoryOwner, repositoryName, providerEventId: deliveryId };

    if (providerEvent === "merge_request") {
      const mergeRequest = webhookEntity(request.body, "merge_request", "MergeRequest");
      const action = stringPick(request.body, "action", "Action")
        || stringPick(mergeRequest, "action", "Action", "status", "Status");
      const normalized = normalizeCodebaseMergeRequest(mergeRequest);
      const normalizedAction = action.toLowerCase();
      const state = normalizeCodebaseChangeState(stringPick(normalized, "state"));
      const subjectId = stringPick(mergeRequest, "id", "Id") || stringPick(mergeRequest, "number", "Number");
      const version = codebaseChangeVersion(normalized);
      const type = normalizedAction.includes("merge") || state === "merged"
        ? "change.merged"
        : normalizedAction === "close" || normalizedAction === "closed" || state === "closed"
          ? "change.closed"
          : normalizedAction === "reopen" || normalizedAction === "reopened"
            ? "change.reopened"
            : normalizedAction === "open" || normalizedAction === "opened" || normalizedAction === "create"
              ? "change.opened"
              : "change.updated";
      const logicalState = type === "change.merged" ? "merged" : type === "change.closed" ? "closed" : "open";
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
        logicalVersion: `${version}:${logicalState}`,
        occurredAt,
        payload: normalized,
        snapshotObservation: webhookObservation(
          "change_requests", "change_request", subjectId, version, occurredAt, request.observedAt, normalized,
        ),
      });
    } else if (providerEvent === "comment" || providerEvent === "merge_request_review_thread") {
      const comment = webhookEntity(request.body, "comment", "Comment", "note", "Note");
      const action = (stringPick(request.body, "action", "Action") || stringPick(comment, "action", "Action")).toLowerCase();
      const normalized = normalizeCodebaseComment(comment, null);
      const type = action === "delete" || action === "deleted"
        ? "comment.deleted"
        : providerEvent === "merge_request_review_thread"
          || action === "update" || action === "updated" || action === "edit" || action === "edited"
          ? "comment.updated"
          : "comment.created";
      const subjectId = stringPick(comment, "id", "Id");
      const version = codebaseCommentVersion(normalized);
      const occurredAt = type === "comment.deleted"
        ? request.observedAt
        : nullableString(normalized.updated_at) ?? nullableString(normalized.created_at);
      const payload = { ...normalized, deleted: type === "comment.deleted" };
      candidates.push({
        ...base,
        type,
        subjectType: "comment",
        subjectId,
        logicalVersion: `${version}:${type.split(".")[1]}`,
        occurredAt,
        payload,
        snapshotObservation: webhookObservation(
          "comments", "comment", subjectId, version, occurredAt, request.observedAt, payload,
        ),
      });
    } else if (providerEvent === "merge_request_review") {
      const review = webhookEntity(request.body, "review", "Review");
      const action = (stringPick(request.body, "action", "Action") || stringPick(review, "action", "Action", "status", "Status")).toLowerCase();
      const normalized = normalizeCodebaseReview(review, null);
      const dismissed = action === "dismiss" || action === "dismissed" || stringPick(normalized, "state") === "dismissed";
      const subjectId = stringPick(review, "id", "Id");
      const version = codebaseReviewVersion(normalized);
      const occurredAt = dismissed ? request.observedAt : nullableString(normalized.submitted_at);
      candidates.push({
        ...base,
        type: dismissed ? "review.dismissed" : "review.submitted",
        subjectType: "review",
        subjectId,
        logicalVersion: `${version}:${dismissed ? "dismissed" : stringPick(normalized, "state") || "submitted"}`,
        occurredAt,
        payload: normalized,
        snapshotObservation: webhookObservation(
          "reviews", "review", subjectId, version, occurredAt, request.observedAt, normalized,
        ),
      });
    } else if (providerEvent === "push") {
      const ref = stringPick(request.body, "ref", "Ref").replace(/^refs\/heads\//u, "");
      const after = stringPick(request.body, "after", "After", "after_sha", "AfterSha");
      const defaultBranch = stringPick(repository, "default_branch", "DefaultBranch");
      const payload = {
        branch: ref,
        ref: stringPick(request.body, "ref", "Ref"),
        head_sha: after,
        before_sha: nullableString(valuePick(request.body, "before", "Before", "before_sha", "BeforeSha")),
      };
      const common = {
        ...base,
        subjectType: "ref",
        subjectId: ref || "HEAD",
        logicalVersion: after,
        occurredAt: nullableString(valuePick(request.body, "timestamp", "Timestamp")) ?? request.observedAt,
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
      ignoredReason: validCandidates.length ? null : `unsupported or malformed Codebase event: ${providerEvent}`,
    };
  }

  private async pollDefaultBranch(context: ScmPollContext): Promise<ScmPollPage> {
    const repository = await this.resolveRepository(context);
    const repoId = stringPick(repository, "Id", "id");
    const branch = context.binding.defaultBranch || stringPick(repository, "DefaultBranch", "default_branch");
    if (!repoId || !branch) throw new Error("Codebase repository has no id or default branch");
    const result = await this.action(context, "GetBranch", { RepoId: repoId, Name: branch });
    const branchValue = recordPick(result, "Branch", "branch");
    const commit = recordPick(branchValue, "Commit", "commit");
    const headSha = stringPick(commit, "Id", "id", "sha", "Sha");
    const observedAt = context.now.toISOString();
    return {
      observations: [{
        stream: "default_branch",
        entityType: "ref",
        externalId: branch,
        version: headSha || null,
        occurredAt: stringPick(repository, "PushedAt", "pushed_at") || observedAt,
        observedAt,
        payload: { branch, head_sha: headSha },
      }],
      cursor: null,
      watermark: observedAt,
      done: true,
    };
  }

  private async pollMergeRequests(context: ScmPollContext): Promise<ScmPollPage> {
    const repoId = await this.resolveRepositoryId(context);
    const page = cursorNumber(context, "page", 1);
    const result = await this.action(context, "ListRepoMergeRequests", {
      TargetRepoId: repoId,
      Since: overlapWatermarkIso(context.cursor?.watermark),
      PageNumber: page,
      PageSize: PAGE_SIZE,
      SortOrder: "desc",
      Selector: {
        URL: true,
        ReviewStatus: true,
        CheckRunSummaryStatus: true,
        Branch: true,
        Version: true,
      },
    });
    const mergeRequests = arrayRecords(valuePick(result, "MergeRequests", "merge_requests"));
    const observations = mergeRequests.map((mergeRequest) => codebaseChangeObservation(mergeRequest, context.now));
    const total = numberPick(result, "TotalCount", "total_count");
    const hasNext = total !== null ? page * PAGE_SIZE < total : mergeRequests.length === PAGE_SIZE;
    return {
      observations,
      cursor: hasNext ? { page: page + 1 } : null,
      watermark: context.now.toISOString(),
      done: !hasNext,
    };
  }

  private async pollComments(context: ScmPollContext): Promise<ScmPollPage> {
    const repoId = await this.resolveRepositoryId(context);
    const { mergeRequests, nextCursor } = await this.listRelatedMergeRequestsPage(context, repoId);
    const observations: ScmEntityObservation[] = [];
    for (const mergeRequest of mergeRequests) {
      const changeId = stringPick(mergeRequest, "Id", "id");
      if (!changeId) continue;
      const result = await this.action(context, "ListThreads", {
        CommentableType: "merge_request",
        CommentableId: changeId,
        RepoId: repoId,
      });
      for (const thread of arrayRecords(valuePick(result, "Threads", "threads"))) {
        for (const comment of arrayRecords(valuePick(thread, "Comments", "comments"))) {
          observations.push(codebaseCommentObservation(comment, thread, context.now));
        }
      }
    }
    return {
      observations,
      cursor: nextCursor,
      watermark: context.now.toISOString(),
      done: nextCursor === null,
    };
  }

  private async pollReviews(context: ScmPollContext): Promise<ScmPollPage> {
    const repoId = await this.resolveRepositoryId(context);
    const { mergeRequests, nextCursor } = await this.listRelatedMergeRequestsPage(context, repoId);
    const observations: ScmEntityObservation[] = [];
    for (const mergeRequest of mergeRequests) {
      const changeId = stringPick(mergeRequest, "Id", "id");
      if (!changeId) continue;
      const result = await this.action(context, "GetReviewStatus", { MergeRequestId: changeId, RepoId: repoId });
      const status = recordPick(result, "Status", "status");
      for (const review of arrayRecords(valuePick(status, "EffectiveReviews", "effective_reviews"))) {
        observations.push(codebaseReviewObservation(review, mergeRequest, context.now));
      }
    }
    return {
      observations,
      cursor: nextCursor,
      watermark: context.now.toISOString(),
      done: nextCursor === null,
    };
  }

  private async pollPipelines(context: ScmPollContext): Promise<ScmPollPage> {
    const repoId = await this.resolveRepositoryId(context);
    const page = cursorNumber(context, "page", 1);
    const threshold = overlapWatermark(context.cursor?.watermark);
    const result = await this.action(context, "ListCheckRuns", {
      RepoId: repoId,
      PageNumber: page,
      PageSize: PAGE_SIZE,
    });
    const checkRuns = arrayRecords(valuePick(result, "CheckRuns", "check_runs"));
    const observations = checkRuns
      .filter((run) => !threshold || timestampValue(
        valuePick(run, "UpdatedAt", "updated_at") ?? valuePick(run, "CreatedAt", "created_at"),
      ) >= threshold)
      .map((run) => codebasePipelineObservation(run, context.now));
    const total = numberPick(result, "TotalCount", "total_count");
    const hasNext = total !== null ? page * PAGE_SIZE < total : checkRuns.length === PAGE_SIZE;
    return {
      observations,
      cursor: hasNext ? { page: page + 1 } : null,
      watermark: context.now.toISOString(),
      done: !hasNext,
    };
  }

  private async listRelatedMergeRequestsPage(
    context: ScmPollContext,
    repoId: string,
  ): Promise<{ mergeRequests: Record<string, unknown>[]; nextCursor: Record<string, unknown> | null }> {
    const page = cursorNumber(context, "page", 1);
    const result = await this.action(context, "ListRepoMergeRequests", {
      TargetRepoId: repoId,
      Since: overlapWatermarkIso(context.cursor?.watermark),
      PageNumber: page,
      PageSize: PAGE_SIZE,
      SortOrder: "desc",
    });
    const mergeRequests = arrayRecords(valuePick(result, "MergeRequests", "merge_requests"));
    const total = numberPick(result, "TotalCount", "total_count");
    const hasNext = total !== null ? page * PAGE_SIZE < total : mergeRequests.length === PAGE_SIZE;
    return { mergeRequests, nextCursor: hasNext ? { page: page + 1 } : null };
  }

  private async resolveRepositoryId(context: ScmPollContext): Promise<string> {
    if (context.binding.externalId?.trim()) return context.binding.externalId.trim();
    const repository = await this.resolveRepository(context);
    const id = stringPick(repository, "Id", "id");
    if (!id) throw new Error("Codebase GetRepository response has no repository id");
    return id;
  }

  private async resolveRepository(context: ScmPollContext): Promise<Record<string, unknown>> {
    const result = await this.action(context, "GetRepository", {
      ...(context.binding.externalId?.trim()
        ? { Id: context.binding.externalId.trim() }
        : { Path: [context.binding.owner, context.binding.name].filter(Boolean).join("/") }),
      Selector: { PushedAt: true },
    });
    const repository = recordPick(result, "Repository", "repository");
    if (!Object.keys(repository).length) throw new Error("Codebase repository was not found");
    return repository;
  }

  private async action(context: ScmPollContext, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = context.connection.apiBaseUrl.replace(/\/$/u, "") + "/";
    const url = appendQuery(base, { Action: action });
    const token = context.credential.accessToken?.trim();
    context.heartbeat?.();
    try {
      const response = await scmRequestJson<Record<string, unknown>>(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "multiremi-scm-poller",
          ...codebaseAuthHeaders(token),
        },
        body: JSON.stringify(removeUndefined(body)),
      }, { signal: context.signal });
      const metadata = recordPick(response.data, "ResponseMetadata", "response_metadata");
      const error = recordPick(metadata, "Error", "error");
      if (Object.keys(error).length) {
        throw new Error(`Codebase ${action} failed: ${stringPick(error, "Code", "code") || "Error"}: ${stringPick(error, "Message", "message")}`);
      }
      return recordPick(response.data, "Result", "result");
    } finally {
      context.heartbeat?.();
    }
  }
}

function codebaseChangeObservation(mergeRequest: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeCodebaseMergeRequest(mergeRequest);
  return {
    stream: "change_requests",
    entityType: "change_request",
    externalId: stringPick(mergeRequest, "Id", "id") || stringPick(mergeRequest, "Number", "number"),
    version: codebaseChangeVersion(payload),
    occurredAt: nullableString(payload.updated_at) ?? now.toISOString(),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeCodebaseMergeRequest(value: Record<string, unknown>): Record<string, unknown> {
  const status = stringPick(value, "Status", "status");
  const sourceBranch = recordPick(value, "SourceBranch", "source_branch");
  const sourceCommit = recordPick(sourceBranch, "Commit", "commit");
  const latestVersion = latestCodebaseMergeRequestVersion(valuePick(value, "Versions", "versions"));
  return {
    id: nullableString(valuePick(value, "Id", "id")),
    number: numberPick(value, "Number", "number"),
    title: stringPick(value, "Title", "title"),
    body: nullableString(valuePick(value, "Description", "description", "Body", "body")),
    state: normalizeCodebaseChangeState(status),
    draft: valuePick(value, "Draft", "draft") === true,
    url: nullableString(valuePick(value, "URL", "url")),
    source_branch: stringPick(value, "SourceBranchName", "source_branch_name", "source_branch"),
    target_branch: stringPick(value, "TargetBranchName", "target_branch_name", "target_branch"),
    head_sha: stringPick(sourceCommit, "Id", "id", "Sha", "sha")
      || nullableString(valuePick(latestVersion, "SourceCommitId", "source_commit_id"))
      || nullableString(valuePick(value, "SourceCommitId", "source_commit_id")),
    base_sha: nullableString(valuePick(value, "TargetCommitId", "target_commit_id", "BaseCommitId", "base_commit_id")),
    author: stringPick(recordPick(value, "CreatedBy", "created_by", "author"), "Username", "username") || null,
    created_at: nullableString(valuePick(value, "CreatedAt", "created_at")),
    updated_at: nullableString(valuePick(value, "UpdatedAt", "updated_at")),
    closed_at: nullableString(valuePick(value, "ClosedAt", "closed_at")),
    merged_at: nullableString(valuePick(value, "MergedAt", "merged_at")),
    merge_sha: nullableString(valuePick(value, "MergeCommitId", "merge_commit_id")),
    review_status: valuePick(value, "ReviewStatus", "review_status") ?? null,
    check_status: nullableString(valuePick(value, "CheckRunSummaryStatus", "check_run_summary_status")),
    mergeable_state: nullableString(valuePick(value, "MergeableState", "mergeable_state")),
    checks_conclusion: nullableString(valuePick(value, "CheckRunSummaryStatus", "check_run_summary_status")),
    checks_passed: numberPick(value, "ChecksPassed", "checks_passed"),
    checks_failed: numberPick(value, "ChecksFailed", "checks_failed"),
    checks_pending: numberPick(value, "ChecksPending", "checks_pending"),
    additions: numberPick(value, "Additions", "additions"),
    deletions: numberPick(value, "Deletions", "deletions"),
    changed_files: numberPick(value, "ChangedFiles", "changed_files"),
  };
}

function codebaseCommentObservation(comment: Record<string, unknown>, thread: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeCodebaseComment(comment, thread);
  return {
    stream: "comments",
    entityType: "comment",
    externalId: stringPick(comment, "Id", "id"),
    version: codebaseCommentVersion(payload),
    occurredAt: nullableString(payload.updated_at) ?? nullableString(payload.created_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeCodebaseComment(comment: Record<string, unknown>, thread: Record<string, unknown> | null): Record<string, unknown> {
  const author = recordPick(comment, "CreatedBy", "created_by", "author");
  return {
    id: nullableString(valuePick(comment, "Id", "id")),
    kind: "review_thread",
    change_id: nullableString(valuePick(comment, "CommentableId", "commentable_id")),
    thread_id: nullableString(valuePick(comment, "ThreadId", "thread_id")) ?? (thread ? nullableString(valuePick(thread, "Id", "id")) : null),
    body: stringPick(comment, "Content", "content", "body"),
    author: stringPick(author, "Username", "username") || null,
    path: nullableString(valuePick(recordPick(comment, "Position", "position"), "Path", "path")),
    created_at: nullableString(valuePick(comment, "CreatedAt", "created_at")),
    updated_at: nullableString(valuePick(comment, "UpdatedAt", "updated_at", "EditedAt", "edited_at")),
    deleted: false,
  };
}

function codebaseReviewObservation(review: Record<string, unknown>, mergeRequest: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = normalizeCodebaseReview(review, mergeRequest);
  return {
    stream: "reviews",
    entityType: "review",
    externalId: stringPick(review, "Id", "id"),
    version: codebaseReviewVersion(payload),
    occurredAt: nullableString(payload.submitted_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function normalizeCodebaseReview(review: Record<string, unknown>, mergeRequest: Record<string, unknown> | null): Record<string, unknown> {
  const author = recordPick(review, "CreatedBy", "created_by", "author");
  return {
    id: nullableString(valuePick(review, "Id", "id")),
    change_id: nullableString(valuePick(review, "MergeRequestId", "merge_request_id"))
      ?? (mergeRequest ? nullableString(valuePick(mergeRequest, "Id", "id")) : null),
    change_number: mergeRequest ? numberPick(mergeRequest, "Number", "number") : null,
    state: stringPick(review, "Status", "status", "state").toLowerCase(),
    body: stringPick(review, "Content", "content", "body"),
    author: stringPick(author, "Username", "username") || null,
    commit_sha: nullableString(valuePick(review, "CommitId", "commit_id")),
    submitted_at: nullableString(valuePick(review, "CreatedAt", "created_at")),
    outdated: valuePick(review, "Outdated", "outdated") === true,
  };
}

function codebasePipelineObservation(run: Record<string, unknown>, now: Date): ScmEntityObservation {
  const payload = {
    id: nullableString(valuePick(run, "Id", "id")),
    kind: "check_run",
    name: stringPick(run, "Name", "name"),
    status: stringPick(run, "Status", "status").toLowerCase(),
    conclusion: nullableString(valuePick(run, "Conclusion", "conclusion")),
    head_sha: nullableString(valuePick(run, "CommitId", "commit_id")),
    branch: nullableString(valuePick(run, "Branch", "branch")),
    change_id: nullableString(valuePick(run, "MergeRequestId", "merge_request_id")),
    url: nullableString(valuePick(run, "DetailsURL", "details_url")),
    created_at: nullableString(valuePick(run, "CreatedAt", "created_at")),
    updated_at: nullableString(valuePick(run, "UpdatedAt", "updated_at", "CompletedAt", "completed_at")),
  };
  return {
    stream: "pipelines",
    entityType: "pipeline",
    externalId: stringPick(run, "Id", "id") || stringPick(run, "ExternalId", "external_id"),
    version: nullableString(payload.updated_at) || `${stringPick(payload, "status")}:${stringPick(payload, "conclusion")}`,
    occurredAt: nullableString(payload.updated_at) ?? nullableString(payload.created_at),
    observedAt: now.toISOString(),
    payload,
  };
}

function codebaseChangeVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.updated_at) || "unknown-time",
    stringPick(payload, "head_sha"),
    stringPick(payload, "state"),
    stableJsonHash({ title: payload.title, draft: payload.draft, target_branch: payload.target_branch }),
  ].join(":");
}

function codebaseCommentVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.updated_at) || nullableString(payload.created_at) || stringPick(payload, "id"),
    stableJsonHash({ body: payload.body, path: payload.path }),
  ].join(":");
}

function codebaseReviewVersion(payload: Record<string, unknown>): string {
  return [
    nullableString(payload.submitted_at) || "unknown-time",
    stringPick(payload, "commit_sha"),
    stringPick(payload, "state"),
    stableJsonHash(payload.body),
  ].join(":");
}

function latestCodebaseMergeRequestVersion(value: unknown): Record<string, unknown> {
  return arrayRecords(value).reduce<Record<string, unknown>>((latest, candidate) => {
    if (!Object.keys(latest).length) return candidate;
    const latestNumber = numberPick(latest, "Number", "number") ?? Number.NEGATIVE_INFINITY;
    const candidateNumber = numberPick(candidate, "Number", "number") ?? Number.NEGATIVE_INFINITY;
    if (candidateNumber !== latestNumber) return candidateNumber > latestNumber ? candidate : latest;
    const latestTime = timestampValue(valuePick(latest, "CreatedAt", "created_at"));
    const candidateTime = timestampValue(valuePick(candidate, "CreatedAt", "created_at"));
    return candidateTime >= latestTime ? candidate : latest;
  }, {});
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

function normalizeCodebaseChangeState(value: string): "open" | "closed" | "merged" {
  const state = value.toLowerCase();
  if (state.includes("merge")) return "merged";
  if (state === "closed" || state === "close" || state === "declined") return "closed";
  return "open";
}

function validWebhookCandidate(candidate: ScmWebhookCandidate): boolean {
  return Boolean(candidate.subjectId && candidate.logicalVersion && (candidate.repositoryExternalId || candidate.repositoryName));
}

function webhookEntity(body: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const direct = recordPick(body, ...keys);
  if (Object.keys(direct).length) return direct;
  return recordPick(body, "object_attributes", "ObjectAttributes", "data", "Data");
}

function cursorNumber(context: ScmPollContext, key: string, fallback: number): number {
  const value = Number(context.cursor?.cursor?.[key]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
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

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordPick(value: unknown, ...keys: string[]): Record<string, unknown> {
  const source = record(value);
  for (const key of keys) {
    const candidate = record(source[key]);
    if (Object.keys(candidate).length) return candidate;
  }
  return {};
}

function valuePick(value: unknown, ...keys: string[]): unknown {
  const source = record(value);
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  return undefined;
}

function stringPick(value: unknown, ...keys: string[]): string {
  return stringValue(valuePick(value, ...keys));
}

function numberPick(value: unknown, ...keys: string[]): number | null {
  const candidate = Number(valuePick(value, ...keys));
  return Number.isFinite(candidate) ? candidate : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
