/**
 * Multiremi CLI — `issue` command handlers (issues, comments, sessions,
 * metadata, subscribers).
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import {
  type CliOptions,
  addQueryParam,
  hasOption,
  integerOption,
  rawStringOption,
  stringOpt,
} from "../options.js";
import {
  MultiremiCliHttpError,
  attachmentStringField,
  multiremiApiConnection,
  multiremiApiFetch,
  multiremiApiRequest,
  multiremiApiUploadFile,
  normalizedAttachmentRecord,
  isRecord,
  readAttachmentFiles,
  responseIssueId,
} from "../http.js";
import {
  extractList,
  field,
  printIssueCollection,
  printIssueComments,
  printIssueSearch,
  printIssueSessionCollection,
  printIssueSessionResultCollection,
  printIssueSubscribers,
  printJson,
  printTaskMessages,
  printTaskRuns,
} from "../output.js";
import {
  VALID_ISSUE_STATUSES,
  actorBodyFromOptions,
  addAssigneeBodyFields,
  addStringBodyField,
  citationRefsOption,
  metadataFilterFromOptions,
  parseMetadataValue,
  readCommentBody,
  readContentBody,
  readOptionalTextBody,
  subscriberBodyFromOptions,
} from "./fields.js";

export interface CliIssueComment {
  id: string;
  parentId?: string | null;
  parent_id?: string | null;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const SESSION_RESULT_KINDS = ["mr", "report", "deploy", "decision", "doc", "other"] as const;

export async function issue(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "list") {
    const query = buildIssueListQuery(options);
    const response = await multiremiApiRequest("GET", `/api/issues${query ? `?${query}` : ""}`, undefined, options);
    printIssueCollection(response, options);
    return;
  }
  if (action === "get") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue get <issue-id> [--output json]");
    const response = await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}`, undefined, options);
    printJson(response);
    return;
  }
  if (action === "create") {
    await issueCreate(options);
    return;
  }
  if (action === "bind-topic") {
    const issueRef = positional[1]?.trim();
    if (!issueRef) throw new Error("usage: multiremi issue bind-topic <issue-id-or-key>");
    await issueBindTopic(issueRef, options);
    return;
  }
  if (action === "update") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue update <issue-id> [--title <title>] [--description <text>] [--status <status>] [--priority <priority>] [--assignee <id|name|email> --assignee-type <type>] [--project <id>] [--parent <id>] [--start-date <date>] [--due-date <date>]");
    await issueUpdate(issueId, options);
    return;
  }
  if (action === "assign") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue assign <issue-id> (--to <id|name|email> [--to-type agent|member|squad] | --unassign)");
    await issueAssign(issueId, options);
    return;
  }
  if (action === "status") {
    const issueId = positional[1]?.trim();
    const status = positional[2]?.trim();
    if (!issueId || !status) throw new Error("usage: multiremi issue status <issue-id> <status> [--output json]");
    if (!VALID_ISSUE_STATUSES.includes(status)) {
      throw new Error(`invalid status ${JSON.stringify(status)}; valid values: ${VALID_ISSUE_STATUSES.join(", ")}`);
    }
    const response = await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, { status }, options);
    printJson(response);
    return;
  }
  if (action === "delete") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue delete <issue-id>");
    await multiremiApiRequest("DELETE", `/api/issues/${encodeURIComponent(issueId)}`, undefined, options);
    printJson({ deleted: true });
    return;
  }
  if (action === "comment") {
    await issueComment(positional.slice(1), options);
    return;
  }
  if (action === "session") {
    await issueSession(positional.slice(1), options);
    return;
  }
  if (action === "archive") {
    await issueArchive(positional.slice(1), options);
    return;
  }
  if (action === "metadata") {
    await issueMetadata(positional.slice(1), options);
    return;
  }
  if (action === "subscriber") {
    await issueSubscriber(positional.slice(1), options);
    return;
  }
  if (action === "runs") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue runs <issue-id>");
    printTaskRuns(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/task-runs`, undefined, options), options);
    return;
  }
  if (action === "run-messages") {
    const taskId = positional[1]?.trim();
    if (!taskId) throw new Error("usage: multiremi issue run-messages <task-id> [--since <seq>]");
    const since = integerOption(options, "since");
    const query = since === null ? "" : `?since=${encodeURIComponent(String(since))}`;
    printTaskMessages(await multiremiApiRequest("GET", `/api/tasks/${encodeURIComponent(taskId)}/messages${query}`, undefined, options), options);
    return;
  }
  if (action === "rerun") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue rerun <issue-id> [--agent-id <id>] [--prompt <text>]");
    const body: Record<string, unknown> = {};
    const agentId = rawStringOption(options, "agent-id", "agentId");
    const prompt = rawStringOption(options, "prompt");
    if (agentId) body.agent_id = agentId;
    if (prompt) body.prompt = prompt;
    printJson(await multiremiApiRequest("POST", `/api/issues/${encodeURIComponent(issueId)}/rerun`, body, options));
    return;
  }
  if (action === "retitle") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: remi issue retitle <issue> [--dry-run]");
    printJson(await multiremiApiRequest(
      "POST",
      `/api/multiremi/issues/${encodeURIComponent(issueId)}/retitle`,
      { apply: !Boolean(options["dry-run"] ?? options.dryRun) },
      options,
    ));
    return;
  }
  if (action === "cancel-task") {
    const taskId = positional[1]?.trim();
    if (!taskId) throw new Error("usage: multiremi issue cancel-task <task-id>");
    printJson(await multiremiApiRequest("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {}, options));
    return;
  }
  if (action === "task") {
    await issueTask(positional.slice(1), options);
    return;
  }
  if (action === "search") {
    const queryText = positional[1]?.trim();
    if (!queryText) throw new Error("usage: multiremi issue search <query> [--limit <n>] [--include-closed]");
    const params = new URLSearchParams({ q: queryText });
    const limit = integerOption(options, "limit");
    if (limit !== null) params.set("limit", String(limit));
    if (Boolean(options.includeClosed ?? options["include-closed"])) params.set("include_closed", "true");
    printIssueSearch(await multiremiApiRequest("GET", `/api/issues/search?${params.toString()}`, undefined, options), options);
    return;
  }
  throw new Error("usage: multiremi issue list|get|create|bind-topic|update|assign|status|delete|search|runs|run-messages|rerun|retitle|cancel-task|task|comment|session|archive|subscriber|metadata ...");
}

/**
 * Mid-run task intervention. `steer` records a directive the daemon injects
 * into the live provider session (the run keeps going); `--force-answer` asks
 * the agent to stop exploring and deliver its conclusion now.
 */
export async function issueTask(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "steer") {
    const taskId = positional[1]?.trim();
    if (!taskId) {
      throw new Error("usage: multiremi issue task steer <task-id> [--force-answer] (--content <text>|--content-file <path>|--content-stdin)");
    }
    const forceAnswer = Boolean(options.forceAnswer ?? options["force-answer"]);
    let content: string | null = null;
    try {
      content = await readContentBody(options, "steer content");
    } catch (err) {
      // --force-answer works without content; the server injects its default wrap-up directive.
      if (!forceAnswer) throw err;
    }
    const body: Record<string, unknown> = { kind: forceAnswer ? "force_answer" : "steer" };
    if (content?.trim()) body.content = content;
    printJson(await multiremiApiRequest("POST", `/api/tasks/${encodeURIComponent(taskId)}/steer`, body, options));
    return;
  }
  if (action === "steers") {
    const taskId = positional[1]?.trim();
    if (!taskId) throw new Error("usage: multiremi issue task steers <task-id> [--output json]");
    printJson(await multiremiApiRequest("GET", `/api/tasks/${encodeURIComponent(taskId)}/steer`, undefined, options));
    return;
  }
  throw new Error("usage: multiremi issue task steer|steers <task-id> ...");
}

export async function issueArchive(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (!issueId) {
    throw new Error("usage: multiremi issue archive <status|list|verify|retry> <issue-id> [archive-id]");
  }

  const list = async () => multiremiApiRequest(
    "GET",
    `/api/issues/${encodeURIComponent(issueId)}/session-archives`,
    undefined,
    options,
  );

  if (action === "list") {
    printJson(await list());
    return;
  }

  if (action === "status") {
    const response = await list();
    const archives = extractList(response, "archives");
    printJson({
      issue_id: issueId,
      total: archives.length,
      ready: archives.filter((archive) => field(archive, "status") === "ready").length,
      pending: archives.filter((archive) => field(archive, "status") === "pending").length,
      uploading: archives.filter((archive) => field(archive, "status") === "uploading").length,
      failed: archives.filter((archive) => field(archive, "status") === "failed").length,
      superseded: archives.filter((archive) => field(archive, "status") === "superseded").length,
      latest: isRecord(response) ? response.latest ?? null : null,
      latest_ready: isRecord(response) ? response.latest_ready ?? null : null,
    });
    return;
  }

  if (action === "verify" || action === "retry") {
    let archiveId = positional[2]?.trim() ?? "";
    if (!archiveId) {
      const response = await list();
      if (action === "retry") {
        const failed = extractList(response, "archives").find(
          (archive) => field(archive, "status") === "failed",
        );
        archiveId = String(field(failed ?? {}, "id") ?? "");
      } else if (isRecord(response)) {
        const candidate = isRecord(response.latest_ready) ? response.latest_ready : null;
        archiveId = candidate ? String(field(candidate, "id") ?? "") : "";
      }
    }
    if (!archiveId) {
      throw new Error(
        action === "retry"
          ? `no failed session archive found for ${issueId}`
          : `no ready session archive found for ${issueId}`,
      );
    }
    printJson(await multiremiApiRequest(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/${action}`,
      {},
      options,
    ));
    return;
  }

  throw new Error("usage: multiremi issue archive <status|list|verify|retry> <issue-id> [archive-id]");
}

export async function issueSession(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "list") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue session list <issue-id> [--output json]");
    const response = await multiremiApiRequest(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}/sessions`,
      undefined,
      options,
    );
    printIssueSessionCollection(response, options);
    return;
  }
  if (action === "result") {
    await issueSessionResult(positional.slice(1), options);
    return;
  }
  throw new Error("usage: multiremi issue session list|result ...");
}

export async function issueSessionResult(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (action === "list") {
    if (!issueId) {
      throw new Error("usage: multiremi issue session result list <issue-id> [--session <session-id>] [--output json]");
    }
    const response = await multiremiApiRequest(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}/session-results`,
      undefined,
      options,
    );
    const sessionId = rawStringOption(options, "session", "session-id");
    const filtered = sessionId
      ? extractList(response).filter((row) => field(row, "source_session_id", "sourceSessionId") === sessionId)
      : response;
    printIssueSessionResultCollection(filtered, options);
    return;
  }
  if (action === "publish") {
    if (!issueId) {
      throw new Error(`usage: multiremi issue session result publish <issue-id> --session <session-id> [--title <title>] [--type ${SESSION_RESULT_KINDS.join("|")}] [--ref <type>:<value>] (--content <text>|--content-file <path>|--content-stdin)`);
    }
    const sessionId = rawStringOption(options, "session", "session-id");
    if (!sessionId) throw new Error("--session is required");
    const body = await readContentBody(options, "result body");
    if (!body.trim()) throw new Error("result body is required");
    const metadata = sessionResultMetadata(options);
    printJson(await multiremiApiRequest(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/sessions/${encodeURIComponent(sessionId)}/results`,
      {
        title: rawStringOption(options, "title") ?? "",
        body,
        ...(metadata ? { metadata } : {}),
      },
      options,
    ));
    return;
  }
  throw new Error("usage: multiremi issue session result list|publish ...");
}

/**
 * `--type` / `--ref` land in the published result's open metadata bag: `kind`
 * picks the icon on the issue's key-results panel, `refs` become source badges.
 * Both stay optional — a result published without them still shows up, just
 * generically. An unknown `--type` is a usage error rather than a silent pass:
 * the taxonomy is small and the agent should be told when it drifts.
 */
export function sessionResultMetadata(options: CliOptions): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  if (hasOption(options, "type")) {
    const kind = rawStringOption(options, "type")?.trim() ?? "";
    if (!(SESSION_RESULT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`--type ${JSON.stringify(kind)} must be one of ${SESSION_RESULT_KINDS.join(", ")}`);
    }
    metadata.kind = kind;
  }
  const refs = citationRefsOption(options);
  if (refs) metadata.refs = refs;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export async function issueComment(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (action === "list") {
    if (!issueId) throw new Error("usage: multiremi issue comment list <issue-id> [--thread <comment-id>] [--since <iso>] [--tail <n>] [--recent <n>] [--roots-only] [--summary] [--before <iso> --before-id <id>] [--output json]");
    const query = buildIssueCommentListQuery(options);
    const response = await multiremiApiFetch<CliIssueComment[]>(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}/comments${query ? `?${query}` : ""}`,
      undefined,
      options,
    );
    const nextBefore = response.headers.get("X-Multiremi-Next-Before") ?? response.headers.get("X-Multimira-Next-Before");
    const nextBeforeId = response.headers.get("X-Multiremi-Next-Before-Id") ?? response.headers.get("X-Multimira-Next-Before-Id");
    if (nextBefore && nextBeforeId) {
      const label = stringOpt(options.thread, undefined) && hasOption(options, "tail")
        ? "Next reply cursor"
        : "Next thread cursor";
      console.error(`${label}: --before ${nextBefore} --before-id ${nextBeforeId}`);
    }
    printIssueComments(response.data, options);
    return;
  }
  if (action === "add") {
    if (!issueId) throw new Error("usage: multiremi issue comment add <issue-id> [--parent <comment-id>] [--attachment <path>]... (--content <text>|--content-file <path>|--content-stdin)");
    const body = await readCommentBody(options);
    if (!body.trim()) throw new Error("comment body is required");
    const attachmentIds: string[] = [];
    for (const attachmentFile of readAttachmentFiles(options)) {
      const uploaded = await multiremiApiUploadFile(attachmentFile, issueId, options);
      const uploadedId = attachmentStringField(normalizedAttachmentRecord(uploaded), "id");
      if (!uploadedId) throw new Error(`upload attachment ${attachmentFile.path}: upload response missing attachment id`);
      attachmentIds.push(uploadedId);
      console.error(`Uploaded ${attachmentFile.path}`);
    }
    const response = await multiremiApiRequest(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/comments`,
      {
        content: body,
        parent_id: stringOpt(options.parent, undefined) ?? null,
        ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
      },
      options,
    );
    printJson(response);
    return;
  }
  if (action === "update") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment update <comment-id> (--content <text>|--content-file <path>|--content-stdin)");
    const body = await readCommentBody(options);
    if (!body.trim()) throw new Error("comment body is required");
    printJson(await multiremiApiRequest("PUT", `/api/comments/${encodeURIComponent(commentId)}`, { content: body }, options));
    return;
  }
  if (action === "delete") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment delete <comment-id>");
    const response = await multiremiApiRequest("DELETE", `/api/comments/${encodeURIComponent(commentId)}`, undefined, options);
    printJson(response ?? { deleted: true });
    return;
  }
  if (action === "resolve") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment resolve <comment-id> [--actor-type <type>] [--actor-id <id>]");
    printJson(await multiremiApiRequest("POST", `/api/comments/${encodeURIComponent(commentId)}/resolve`, actorBodyFromOptions(options), options));
    return;
  }
  if (action === "unresolve") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment unresolve <comment-id>");
    printJson(await multiremiApiRequest("DELETE", `/api/comments/${encodeURIComponent(commentId)}/resolve`, undefined, options));
    return;
  }
  throw new Error("usage: multiremi issue comment list|add|update|delete|resolve|unresolve ...");
}

export async function issueMetadata(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (!issueId) throw new Error("usage: multiremi issue metadata <list|get|set|delete> <issue-id> [--key <key>] [--value <value>]");
  if (action === "list") {
    try {
      printJson(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/metadata`, undefined, options));
    } catch (err) {
      if (err instanceof MultiremiCliHttpError && err.status === 404) {
        printJson({});
        return;
      }
      throw err;
    }
    return;
  }
  const key = stringOpt(options.key, undefined);
  if (!key) throw new Error("--key is required");
  if (action === "get") {
    const metadata = await multiremiApiRequest<Record<string, unknown>>("GET", `/api/issues/${encodeURIComponent(issueId)}/metadata`, undefined, options);
    if (!(key in metadata)) throw new Error(`key ${JSON.stringify(key)} not found on issue`);
    printJson(metadata[key]);
    return;
  }
  if (action === "set") {
    if (!hasOption(options, "value")) throw new Error("--value is required");
    const value = parseMetadataValue(String(options.value ?? ""), stringOpt(options.type, undefined));
    const response = await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}/metadata/${encodeURIComponent(key)}`, { value }, options);
    printJson(response);
    return;
  }
  if (action === "delete") {
    const response = await multiremiApiRequest("DELETE", `/api/issues/${encodeURIComponent(issueId)}/metadata/${encodeURIComponent(key)}`, undefined, options);
    printJson(response ?? { deleted: true });
    return;
  }
  throw new Error("usage: multiremi issue metadata list|get|set|delete <issue-id> [--key <key>] [--value <value>]");
}

export async function issueCreate(options: CliOptions): Promise<void> {
  const title = rawStringOption(options, "title");
  if (!title?.trim()) throw new Error("usage: multiremi issue create --title <title> [--description <text>] [--status <status>] [--priority <priority>] [--project <id>] [--parent <id>] [--assignee <id|name|email> --assignee-type <type>] [--no-project-defaults] [--start-date <date>] [--due-date <date>] [--attachment <path>]... [--allow-duplicate]");
  const attachments = readAttachmentFiles(options);
  const body: Record<string, unknown> = { title };
  const description = await readOptionalTextBody(options, "description");
  if (description.set) body.description = description.value;
  addStringBodyField(body, options, "status", "status", true);
  addStringBodyField(body, options, "priority", "priority");
  addStringBodyField(body, options, "project_id", "project", false, true);
  addStringBodyField(body, options, "parent_issue_id", "parent", false, true);
  addStringBodyField(body, options, "start_date", "start-date", false, true);
  addStringBodyField(body, options, "due_date", "due-date", false, true);
  if (Boolean(options.allowDuplicate ?? options["allow-duplicate"])) body.allow_duplicate = true;
  const hasExplicitAssignee = hasOption(options, "assignee-id")
    || hasOption(options, "assigneeId")
    || hasOption(options, "assignee");
  // The server backfills the project's default assignee whenever the request
  // carries no assignee fields, so inheriting defaults needs no client work.
  // --use-project-defaults is kept as a compatible no-op; --no-project-defaults
  // opts out by sending explicit nulls.
  const useProjectDefaults = booleanFlag(options, "use-project-defaults", "useProjectDefaults");
  const noProjectDefaults = booleanFlag(options, "no-project-defaults", "noProjectDefaults");
  const projectId = rawStringOption(options, "project", "project-id");
  if (useProjectDefaults && noProjectDefaults) throw new Error("--use-project-defaults and --no-project-defaults are mutually exclusive");
  if (useProjectDefaults && !projectId) throw new Error("--use-project-defaults requires --project");
  if (hasExplicitAssignee) {
    addAssigneeBodyFields(body, options, "assignee-id", "assignee-type", "assignee");
  } else if (noProjectDefaults) {
    body.assignee_type = null;
    body.assignee_id = null;
  }
  const topicPreflight = Boolean(options.noBindTopic ?? options["no-bind-topic"])
    ? null
    : await prepareTopicMigration(options);
  const preparedTopic = topicPreflight?.bound ? topicPreflight : null;
  if (preparedTopic?.state && preparedTopic.state !== "prepared") {
    throw new Error(
      `Topic migration ${preparedTopic.migration_id} is already pending for ${preparedTopic.issue_key ?? preparedTopic.issue_id ?? "an existing Issue"}. `
      + `Resume it with: remi issue bind-topic ${preparedTopic.issue_key ?? preparedTopic.issue_id ?? "<issue>"}`,
    );
  }
  let response: unknown;
  try {
    response = await multiremiApiRequest("POST", "/api/issues", body, options);
  } catch (error) {
    if (preparedTopic) await cancelTopicMigration(preparedTopic, options).catch(() => {});
    throw error;
  }
  let topicMigration: Record<string, unknown> | null = null;
  if (preparedTopic) {
    const issueId = responseIssueId(response);
    const issueKey = responseIssueKey(response);
    try {
      console.error(`Waiting for the local daemon to bind this topic to ${issueKey}...`);
      topicMigration = await commitTopicMigration(preparedTopic, issueId, issueKey, options);
      console.error(`Topic migrated to ${String(topicMigration.path)}`);
    } catch (error) {
      throw new Error(
        `Issue ${issueKey} was created, but its topic workspace was not migrated. `
        + `Retry with: remi issue bind-topic ${issueKey}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  if (attachments.length) {
    const issueId = responseIssueId(response);
    for (const attachmentFile of attachments) {
      try {
        await multiremiApiUploadFile(attachmentFile, issueId, options);
        console.error(`Uploaded ${attachmentFile.path}`);
      } catch (err) {
        console.error(`warning: upload attachment ${attachmentFile.path} failed (issue already created, ${issueId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  printJson(topicMigration && isRecord(response) ? { ...response, topic_migration: topicMigration } : response);
  if (isRecord(response) && typeof response.chat_issue_binding_hint === "string") {
    console.error(response.chat_issue_binding_hint);
  }
  warnUndispatchedIssue(response, projectId ?? null, !hasExplicitAssignee && !noProjectDefaults);
}

export async function issueBindTopic(issueRef: string, options: CliOptions): Promise<void> {
  const baseUrl = await localDaemonBaseUrl(options);
  if (!baseUrl) throw new Error("No local Multiremi daemon is available for topic migration");
  const response = await multiremiApiRequest(
    "GET",
    `/api/issues/${encodeURIComponent(issueRef)}`,
    undefined,
    options,
  );
  const issueId = responseIssueId(response);
  const issueKey = responseIssueKey(response);
  const cwd = currentWorkingDirectory();
  console.error(`Waiting for the local daemon to bind this topic to ${issueKey}...`);
  const result = await localTopicMigrationRequest(baseUrl, {
    action: "resume",
    ...(cwd ? { cwd } : {}),
    issue_id: issueId,
    issue_key: issueKey,
  });
  console.error(`Topic migrated to ${String(result.path)}`);
  printJson({ issue_id: issueId, issue_key: issueKey, topic_migration: result });
}

interface PreparedLocalTopicMigration {
  bound: boolean;
  migration_id?: string;
  state?: "prepared" | "migrating" | "returning";
  issue_id?: string;
  issue_key?: string;
  topic_id?: string;
  session_key?: string;
  topic_cwd?: string;
}

async function prepareTopicMigration(options: CliOptions): Promise<PreparedLocalTopicMigration | null> {
  const baseUrl = await localDaemonBaseUrl(options);
  if (!baseUrl) return null;
  const cwd = currentWorkingDirectory();
  if (!cwd) throw new Error("Cannot resolve the current directory for topic migration");
  const result = await localTopicMigrationRequest(baseUrl, {
    action: "prepare",
    cwd,
  });
  return result as unknown as PreparedLocalTopicMigration;
}

async function localDaemonBaseUrl(options: CliOptions): Promise<string | null> {
  const daemonPort = stringOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT);
  if (!daemonPort) return null;
  const baseUrl = `http://127.0.0.1:${daemonPort}`;
  let health: Response;
  try {
    health = await fetch(`${baseUrl}/health`);
  } catch {
    // Ordinary CLI use does not require a daemon. A topic binding cannot exist
    // without the co-resident daemon which created it.
    return null;
  }
  if (!health.ok) return null;
  let healthBody: Record<string, unknown>;
  try {
    healthBody = await health.json() as Record<string, unknown>;
  } catch {
    return null;
  }
  if (healthBody.mode !== "serving") {
    throw new Error(`Local daemon is not serving topic migrations (mode=${String(healthBody.mode ?? "unknown")})`);
  }
  return baseUrl;
}

async function commitTopicMigration(
  prepared: PreparedLocalTopicMigration,
  issueId: string,
  issueKey: string,
  options: CliOptions,
): Promise<Record<string, unknown>> {
  if (!prepared.migration_id) throw new Error("Local daemon did not return a topic migration id");
  const daemonPort = stringOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT);
  if (!daemonPort) throw new Error("MULTIREMI_DAEMON_PORT is required to finish topic migration");
  return localTopicMigrationRequest(`http://127.0.0.1:${daemonPort}`, {
    action: "commit",
    cwd: prepared.topic_cwd ?? process.cwd(),
    migration_id: prepared.migration_id,
    issue_id: issueId,
    issue_key: issueKey,
  });
}

async function cancelTopicMigration(
  prepared: PreparedLocalTopicMigration,
  options: CliOptions,
): Promise<void> {
  if (!prepared.migration_id) return;
  const daemonPort = stringOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT);
  if (!daemonPort) return;
  await localTopicMigrationRequest(`http://127.0.0.1:${daemonPort}`, {
    action: "cancel",
    cwd: prepared.topic_cwd ?? process.cwd(),
    migration_id: prepared.migration_id,
  });
}

async function localTopicMigrationRequest(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/topic/migrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: Record<string, unknown>;
  try {
    result = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error("Local daemon returned invalid topic migration JSON");
  }
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
  return result;
}

function responseIssueKey(value: unknown): string {
  const row = isRecord(value) && isRecord(value.issue) ? value.issue : value;
  const key = isRecord(row)
    ? attachmentStringField(row, "key", "identifier", "issue_key", "issueKey")
    : null;
  if (!key) throw new Error("create issue response missing issue key; cannot migrate topic workspace");
  return key;
}

function currentWorkingDirectory(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

// Assign-on-create can silently end without a task (no assignee, no runnable
// agent, assignment error). The JSON on stdout carries dispatch_status /
// dispatch_skipped_reason for scripts; this prints a human-facing warning so
// an interactive caller cannot mistake "201 created" for "an agent is on it".
function warnUndispatchedIssue(
  response: unknown,
  projectId: string | null,
  serverInheritanceAttempted: boolean,
): void {
  if (!isRecord(response) || response.dispatch_status !== "skipped") return;
  const reason = typeof response.dispatch_skipped_reason === "string" ? response.dispatch_skipped_reason : null;
  // Expected outcomes: a member assignee gets an inbox notification instead of
  // a task, and backlog is a parking lot for pre-assignment issues.
  if (reason === "member_assignee" || reason === "backlog_status") return;
  const ref = (typeof response.identifier === "string" && response.identifier) || String(response.id ?? "");
  const error = typeof response.dispatch_error === "string" ? response.dispatch_error : null;
  console.error("");
  console.error(`⚠ Issue ${ref} was created but NOT dispatched — no agent will pick it up.`);
  if (reason === "no_assignee") {
    console.error("  Reason: the issue has no assignee.");
    // The server backfills the project's default assignee whenever the request
    // omits assignee fields, so reaching no_assignee on such a request means
    // the project has none configured.
    if (projectId && serverInheritanceAttempted) {
      console.error(`  Note: project ${projectId} has no default assignee configured, so none was inherited.`);
    }
    console.error(`  To start execution, assign an agent: issue assign ${ref} --to <agent>`);
  } else if (reason === "no_runnable_agent") {
    console.error(`  Reason: no runnable agent for the assignee${error ? ` (${error})` : ""}.`);
    console.error(`  Reassign it to a runnable agent: issue assign ${ref} --to <agent>`);
  } else {
    console.error(`  Reason: ${error ?? reason ?? "unknown"}`);
  }
}

function booleanFlag(options: CliOptions, ...keys: string[]): boolean {
  for (const key of keys) {
    if (!hasOption(options, key)) continue;
    const value = options[key];
    const last = Array.isArray(value) ? value.at(-1) : value;
    return last === true || (typeof last === "string" && last.toLowerCase() !== "false" && last !== "0");
  }
  return false;
}

export async function issueUpdate(issueId: string, options: CliOptions): Promise<void> {
  const body: Record<string, unknown> = {};
  addStringBodyField(body, options, "title", "title", false, true);
  const description = await readOptionalTextBody(options, "description");
  if (description.set) body.description = description.value;
  addStringBodyField(body, options, "status", "status", true, true);
  addStringBodyField(body, options, "priority", "priority", false, true);
  addStringBodyField(body, options, "project_id", "project", false, true);
  addStringBodyField(body, options, "parent_issue_id", "parent", false, true);
  addStringBodyField(body, options, "start_date", "start-date", false, true);
  addStringBodyField(body, options, "due_date", "due-date", false, true);
  addAssigneeBodyFields(body, options, "assignee-id", "assignee-type", "assignee");
  if (Object.keys(body).length === 0) throw new Error("no fields to update; pass --title, --description, --status, --priority, --assignee, --project, --parent, --start-date, or --due-date");
  printJson(await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, body, options));
}

export async function issueAssign(issueId: string, options: CliOptions): Promise<void> {
  const unassign = Boolean(options.unassign);
  const hasTarget = hasOption(options, "to-id") || hasOption(options, "toId") || hasOption(options, "to");
  if (unassign && hasTarget) throw new Error("--to/--to-id and --unassign are mutually exclusive");
  const body: Record<string, unknown> = {};
  if (unassign) {
    body.assignee_type = null;
    body.assignee_id = null;
  } else {
    if (!hasTarget) throw new Error("provide --to <id|name|email> [--to-type agent|member|squad] or --unassign");
    addAssigneeBodyFields(body, options, "to-id", "to-type", "to");
  }
  printJson(await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, body, options));
}

export async function issueSubscriber(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (!issueId) throw new Error("usage: multiremi issue subscriber <list|add|remove> <issue-id> [--user-id <member-id>]");
  if (action === "list") {
    printIssueSubscribers(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/subscribers`, undefined, options), options);
    return;
  }
  if (action === "add" || action === "remove") {
    const body = subscriberBodyFromOptions(options);
    const pathAction = action === "add" ? "subscribe" : "unsubscribe";
    printJson(await multiremiApiRequest("POST", `/api/issues/${encodeURIComponent(issueId)}/${pathAction}`, body, options));
    return;
  }
  throw new Error("usage: multiremi issue subscriber list|add|remove <issue-id> [--user-id <member-id>]");
}

export function buildIssueListQuery(options: CliOptions): string {
  const params = new URLSearchParams();
  addQueryParam(params, "workspace_id", rawStringOption(options, "workspace", "workspace-id"));
  addQueryParam(params, "status", rawStringOption(options, "status"));
  addQueryParam(params, "priority", rawStringOption(options, "priority"));
  addQueryParam(params, "assignee_id", rawStringOption(options, "assignee-id", "assigneeId", "assignee"));
  addQueryParam(params, "assignee_type", rawStringOption(options, "assignee-type", "assigneeType"));
  addQueryParam(params, "project_id", rawStringOption(options, "project", "project-id"));
  const limit = integerOption(options, "limit");
  const offset = integerOption(options, "offset");
  if (limit !== null) params.set("limit", String(limit));
  if (offset !== null) params.set("offset", String(offset));
  const metadata = metadataFilterFromOptions(options);
  if (metadata) params.set("metadata", JSON.stringify(metadata));
  return params.toString();
}

export function buildIssueCommentListQuery(options: CliOptions): string {
  const thread = stringOpt(options.thread, undefined);
  const since = stringOpt(options.since, undefined);
  const recent = integerOption(options, "recent");
  const tail = integerOption(options, "tail");
  const rootsOnly = Boolean(options.rootsOnly ?? options["roots-only"]);
  const summary = Boolean(options.summary);
  const before = stringOpt(options.before, undefined);
  const beforeId = stringOpt(options.beforeId ?? options["before-id"], undefined);

  if (recent !== null && recent <= 0) throw new Error("--recent must be a positive integer");
  if (tail !== null && tail < 0) throw new Error("--tail must be a non-negative integer (0 returns just the thread root)");
  if (thread && recent !== null) throw new Error("--thread and --recent are mutually exclusive");
  if (rootsOnly && thread) throw new Error("--roots-only and --thread are mutually exclusive");
  if (rootsOnly && recent !== null) throw new Error("--roots-only and --recent are mutually exclusive");
  if (rootsOnly && tail !== null) throw new Error("--roots-only and --tail are mutually exclusive");
  if (rootsOnly && before) throw new Error("--roots-only does not support --before / --before-id");
  if (tail !== null && !thread) throw new Error("--tail requires --thread (it is a thread-scoped limit)");
  if (Boolean(before) !== Boolean(beforeId)) throw new Error("--before and --before-id must be set together (composite cursor for stable pagination)");
  if (before && recent === null && !(thread && tail !== null)) {
    throw new Error("--before / --before-id require --recent (thread cursor) or --thread + --tail (reply cursor)");
  }

  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (thread) params.set("thread", thread);
  if (recent !== null) params.set("recent", String(recent));
  if (tail !== null) params.set("tail", String(tail));
  if (rootsOnly) params.set("roots_only", "true");
  if (summary) params.set("summary", "true");
  if (before && beforeId) {
    params.set("before", before);
    params.set("before_id", beforeId);
  }
  return params.toString();
}
