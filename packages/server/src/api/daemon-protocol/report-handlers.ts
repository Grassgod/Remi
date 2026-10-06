import type { MultiremiStore } from "@multiremi/store/store.js";
import { UsageValidationError, validateUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { isDeepStrictEqual } from "node:util";
import { TaskDaemonReportError, TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import type { MultiremiIssueWorkspaceRepo, MultiremiIssueWorkspaceStatus, ReportAgentPluginRuntimeStateInput,
  ReportRuntimeUpdateInput, ReportRuntimeCommandInput, ReportRuntimeModelListInput,
  ReportRuntimeLocalSkillListInput, ReportRuntimeLocalSkillImportInput, ReportRuntimeDirectoryScanInput,
  ReportBotMenuPublishInput, FeishuDecisionDegradeReason } from "@multiremi/contracts/types.js";
import { FEISHU_DECISION_DEGRADE_REASONS } from "@multiremi/contracts/types.js";
import { parseFeishuPresentation } from "@multiremi/contracts/feishu-presentation.js";
import { isFeishuOpenId } from "@shared/feishu-mention.js";
import { normalizeFeishuBotErrorCode, redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import type { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { SessionArchiveError } from "@multiremi/session-archive/service.js";
import type { DaemonGcErrorReply, DaemonFeishuOutboundOkReply, DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { createLogger } from "@shared/logger.js";
import { log as apiLog } from "../helpers/common.js";
import { daemonTaskUsageEntries, daemonLocalSkillListReportBody, daemonLocalSkillImportReportBody } from "../helpers.js";
import { daemonAgentPluginStateResponse } from "../wire/index.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonProtocolSession } from "./session.js";
import type { DaemonParsedFrame } from "./frames.js";

class ReportRejection extends Error {
  constructor(readonly code: string) { super(code); }
}

const log = createLogger("daemon-reports");

class GcRejection extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); }
}

function gcError(status: number, code: string | null, message: string): DaemonGcErrorReply {
  return { ok: false, code: status === 404 ? "task_not_found" : [401, 403, 410].includes(status)
    ? "authority_revoked" : status < 500 ? "invalid_report" : "server_error", message, retryable: status >= 500,
    operation_error: { status, code, message } };
}

function reject(code = "invalid_report"): never { throw new ReportRejection(code); }
const string = (value: unknown): string => typeof value === "string" ? value : "";
const nullable = (value: unknown): string | null => string(value).trim() || null;
const terminal = (status: string): boolean => ["completed", "failed", "cancelled"].includes(status);

function completionFields(p: Record<string, unknown>, taskId: string): DaemonTaskCompletionFields | null {
  const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
  const malformed = (field: keyof DaemonTaskCompletionFields): null => {
    log.error("Terminal report has a malformed round-card field", { taskId, field });
    return null;
  };
  if (p.trace !== undefined) {
    if (!p.trace || typeof p.trace !== "object" || Array.isArray(p.trace)) return malformed("trace");
    const trace = p.trace as Record<string, unknown>;
    if (!count(trace.head) || !count(trace.event_count) || trace.closed !== true || !count(trace.tool_call_count)
      || !Array.isArray(trace.type_histogram) || !trace.type_histogram.every((bucket: unknown) => {
        if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return false;
        const b = bucket as Record<string, unknown>;
        return typeof b.type === "string" && (b.tool === null || typeof b.tool === "string") && count(b.count);
      })) return malformed("trace");
  }
  if (p.final_reply_md !== undefined && p.final_reply_md !== null && typeof p.final_reply_md !== "string") return malformed("final_reply_md");
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "object" || Array.isArray(p.model)
      || typeof (p.model as Record<string, unknown>).provider !== "string"
      || typeof (p.model as Record<string, unknown>).model !== "string") return malformed("model");
  }
  // Card metadata must never block a terminal report. Never read trace to fill a blank card.
  if (p.trace === undefined || p.final_reply_md === undefined || p.model === undefined) {
    log.warn("Terminal report is missing round-card fields", { taskId });
    return null;
  }
  return { trace: p.trace, final_reply_md: p.final_reply_md, model: p.model } as DaemonTaskCompletionFields;
}

/**
 * MUL-429 (B5): only an explicit `trace.event_count === 0` marks the hot trace
 * `none`. Read on its own, not from `completionFields`, so a frame that lacks
 * the other card fields still reports its count; an invalid count is ignored.
 * Logged on the API logger, as the retired HTTP completion routes did.
 */
function completionTraceEventCount(trace: unknown, taskId: string): number | undefined {
  if (trace === undefined) return undefined;
  if (trace !== null && typeof trace === "object" && !Array.isArray(trace)) {
    const eventCount = (trace as Record<string, unknown>).event_count;
    if (eventCount === undefined) return undefined;
    if (typeof eventCount === "number" && Number.isSafeInteger(eventCount) && eventCount >= 0) {
      return eventCount;
    }
  }
  apiLog.warn("Ignoring invalid daemon completion trace.event_count", { taskId });
  return undefined;
}

export function authorizeReportRuntime(store: MultiremiStore, session: DaemonProtocolSession, runtimeId: string): void {
  const runtime = store.getRuntimeLite(runtimeId);
  const token = session.ownerAccessToken;
  if (!runtime || !session.runtimeIds.includes(runtimeId)) reject("authority_revoked");
  if (runtime.daemonId && runtime.daemonId !== session.daemonId) reject("authority_revoked");
  const workspaceId = runtime.workspaceId ?? "local";
  if (token && (token.workspaceId !== workspaceId || token.daemonId !== session.daemonId)) reject("authority_revoked");
  if (token?.userId && token.userId !== "local" && !store.getUserRoleInWorkspace(token.userId, workspaceId)) reject("authority_revoked");
  if (store.isDaemonRetired(workspaceId, session.daemonId)) reject("authority_revoked");
}

export function authorizeReportTask(store: MultiremiStore, session: DaemonProtocolSession, taskId: string, runtimeId: string | null) {
  const task = store.getTask(taskId);
  if (!task) reject("task_not_found");
  if (!task.runtimeId || (runtimeId && runtimeId !== task.runtimeId)) reject("authority_revoked");
  authorizeReportRuntime(store, session, task.runtimeId);
  if ((store.getRuntimeLite(task.runtimeId)?.workspaceId ?? "local") !== task.workspaceId) reject("authority_revoked");
  return task;
}

/** Domain handlers are independent of the socket and of removed HTTP routes. */
export function registerDaemonReportHandlers(layer: DaemonProtocolLayer, store: MultiremiStore,
  onTraceClosed?: (taskId: string, head: number, runtimeId: string) => void): void {
  const handle = async (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    try {
      const p = frame.payload;
      if (frame.type.startsWith("task.")) {
        const taskId = string(p.task_id);
        if (!taskId) reject();
        let task;
        let reportingRuntimeId: string | null = null;
        if ((frame.type === "task.usage" && p.usageSnapshot !== undefined) || (frame.type === "task.start" && p.usage_run_id !== undefined)) {
          let runId: string;
          if (frame.type === "task.usage") {
            try { runId = validateUsageSnapshot(p.usageSnapshot).runId; }
            catch (error) { if (error instanceof UsageValidationError) reject(); throw error; }
          } else {
            if (typeof p.usage_run_id !== "string" || !p.usage_run_id.trim() || p.usage_run_id.length > 256) reject();
            runId = p.usage_run_id;
          }
          const owner = store.getTaskUsageRunRuntime(taskId, runId);
          if (owner) {
            reportingRuntimeId = owner;
            if (frame.rt && frame.rt !== owner) reject("authority_revoked");
            authorizeReportRuntime(store, session, owner);
            task = store.getTask(taskId);
            if (!task) reject("task_not_found");
          } else task = authorizeReportTask(store, session, taskId, frame.rt);
        } else task = authorizeReportTask(store, session, taskId, frame.rt);
        const authority = { runtimeId: reportingRuntimeId ?? task.runtimeId!, workspaceId: task.workspaceId,
          daemonId: session.daemonId, userId: session.ownerAccessToken?.userId };
        const isCompletion = frame.type === "task.complete" || frame.type === "task.fail";
        const fields = isCompletion ? completionFields(p, taskId) : null;
        const traceEventCount = isCompletion ? completionTraceEventCount(p.trace, taskId) : undefined;
        switch (frame.type) {
          case "task.start": {
            const runId = typeof p.usage_run_id === "string" ? p.usage_run_id : undefined;
            let outcome: "started" | "replayed";
            try { outcome = store.startTaskFromDaemon(taskId, authority, runId); }
            catch (error) { if (error instanceof UsageValidationError) reject("authority_revoked"); throw error; }
            const permission = runId ? { execution_authorized: store.isTaskUsageExecutionAuthorized(taskId, runId, authority.runtimeId) } : {};
            if (outcome === "replayed") return { ok: true, code: "start_replayed", ...permission };
            if (runId) return { ok: true, ...permission };
            break;
          }
          case "task.prompt":
            if (!["bootstrap", "delta"].includes(string(p.mode)) || typeof p.prompt !== "string" || typeof p.sha256 !== "string") reject();
            try { store.recordTaskPrompt(taskId, { mode: p.mode as "bootstrap" | "delta", prompt: p.prompt, sha256: p.sha256 }); }
            catch { reject(); }
            break;
          case "task.session_pin":
            if (!nullable(p.session_id) && !nullable(p.work_dir)) reject();
            store.pinTaskSession(taskId, nullable(p.session_id), nullable(p.work_dir));
            break;
          case "task.progress": {
            const summary = string(p.summary);
            const step = typeof p.step === "number" ? p.step : undefined;
            const total = typeof p.total === "number" ? p.total : undefined;
            // An identical replay must not repeat a DB write or task notification.
            if (task.progressSummary === summary
              && task.progressStep === (step ?? null) && task.progressTotal === (total ?? null)) break;
            if (!terminal(task.status) || p.final === true) store.reportProgress(taskId, summary, step, total,
              { allowTerminal: p.final === true });
            break;
          }
          case "task.usage": {
            if (p.usageSnapshot !== undefined) {
              try { store.reportTaskUsageSnapshot(taskId, validateUsageSnapshot(p.usageSnapshot), authority); }
              catch (error) { if (error instanceof UsageValidationError) reject(); throw error; }
              break;
            }
            const usage = daemonTaskUsageEntries(p.usage);
            // The ingestion boundary performs replay checks and rejects JSON
            // drift against its protected historical source checkpoint.
            try { store.reportTaskUsage(taskId, usage); }
            catch (error) { if (error instanceof UsageValidationError) reject(); throw error; }
            break;
          }
          case "task.workspace": {
            const runtimeId = string(p.runtime_id);
            if (!task.issueId) reject("task_not_found");
            if (runtimeId !== task.runtimeId) reject("authority_revoked");
            if (!nullable(p.root_path) || typeof p.branch_name !== "string" || !p.status) reject();
            const repos = Array.isArray(p.repos) ? p.repos as Array<Record<string, unknown>> : [];
            const mapped: MultiremiIssueWorkspaceRepo[] = repos.map(repo => ({
              repoUrl: string(repo.repo_url).trim(), repoName: string(repo.repo_name).trim(),
              worktreePath: string(repo.worktree_path).trim(), branchName: string(repo.branch_name ?? p.branch_name).trim(),
              baseRef: string(repo.base_ref).trim(), baseCommit: nullable(repo.base_commit),
              status: (repo.status ?? (repo.dirty ? "dirty" : "ready")) as "ready" | "dirty" | "error",
              dirty: repo.dirty === true, error: nullable(repo.error),
            }));
            const input = { issueId: task.issueId, runtimeId, rootPath: string(p.root_path).trim(),
              branchName: p.branch_name.trim(), status: p.status as MultiremiIssueWorkspaceStatus, repos: mapped, lastTaskId: taskId };
            const current = terminal(task.status) ? store.getIssueWorkspace(task.issueId) : null;
            if (current?.lastTaskId === taskId && current.runtimeId === runtimeId
              && current.rootPath === input.rootPath && current.branchName === input.branchName
              && current.status === input.status && isDeepStrictEqual(current.repos, mapped)) break;
            try { store.reportIssueWorkspace(input); }
            catch { reject(); }
            break;
          }
          case "task.complete":
            try { store.completeTaskFromDaemon(taskId, { output: string(p.output), traceEventCount, branchName: nullable(p.pr_url),
              sessionId: nullable(p.session_id), workDir: nullable(p.work_dir), completionFields: fields }, authority); }
            catch (error) {
              if (error instanceof TaskSteerPendingError) return { ok: false, code: "steer_pending", retryable: false };
              throw error;
            }
            break;
          case "task.fail":
            store.failTaskFromDaemon(taskId, {
              error: string(p.error) || "Task failed", traceEventCount,
              sessionId: nullable(p.session_id), workDir: nullable(p.work_dir), failureReason: nullable(p.failure_reason), completionFields: fields }, authority);
            break;
          default: reject();
        }
        if (isCompletion && fields?.trace) {
          onTraceClosed?.(taskId, fields.trace.head, task.runtimeId!);
        }
        return { ok: true };
      }
      const runtimeId = frame.rt ?? string(p.runtime_id);
      authorizeReportRuntime(store, session, runtimeId);
      const requestId = string(p.request_id);
      const result = p;
      const exists = (request: { status: string } | null, allowTimeout = false): boolean => {
        if (!request) reject("task_not_found");
        return ["completed", "failed", ...(allowTimeout ? [] : ["timeout"])].includes(request.status);
      };
      switch (frame.type) {
        case "runtime.update_result":
          if (exists(store.getRuntimeUpdateRequest(runtimeId, requestId))) break;
          if (!["running", "completed", "failed"].includes(string(result.status))) reject();
          store.reportRuntimeUpdateResult(runtimeId, requestId, result as unknown as ReportRuntimeUpdateInput);
          break;
        case "runtime.command_result":
          if (exists(store.getRuntimeCommandRequest(runtimeId, requestId))) break;
          if (!["completed", "failed", "timeout"].includes(string(result.status))) reject();
          store.reportRuntimeCommandResult(runtimeId, requestId, result as unknown as ReportRuntimeCommandInput);
          break;
        case "runtime.model_list_result":
          if (!requestId) {
            if (!Array.isArray(result.models)) reject();
            store.updateRuntimeModels(runtimeId, result.models, result.model_profile as ReportRuntimeModelListInput["model_profile"]);
          } else if (!exists(store.getRuntimeModelListRequest(runtimeId, requestId))) {
            if (!["completed", "failed"].includes(string(result.status))) reject();
            store.reportRuntimeModelListResult(runtimeId, requestId, result as unknown as ReportRuntimeModelListInput);
          }
          break;
        case "runtime.local_skills_result":
          if (exists(store.getRuntimeLocalSkillListRequest(runtimeId, requestId))) break;
          if (!["completed", "failed"].includes(string(result.status))) reject();
          store.reportRuntimeLocalSkillListResult(runtimeId, requestId, daemonLocalSkillListReportBody(result as unknown as ReportRuntimeLocalSkillListInput));
          break;
        case "runtime.directory_scan_result":
          if (exists(store.getRuntimeDirectoryScanRequest(runtimeId, requestId))) break;
          if (!["completed", "failed"].includes(string(result.status))) reject();
          store.reportRuntimeDirectoryScanResult(runtimeId, requestId, result as unknown as ReportRuntimeDirectoryScanInput);
          break;
        case "runtime.local_skill_import_result":
          if (exists(store.getRuntimeLocalSkillImportRequest(runtimeId, requestId))) break;
          if (!["completed", "failed"].includes(string(result.status))) reject();
          store.reportRuntimeLocalSkillImportResult(runtimeId, requestId, daemonLocalSkillImportReportBody(result as unknown as ReportRuntimeLocalSkillImportInput));
          break;
        case "runtime.bot_menu_result":
          if (exists(store.getBotMenuPublishRequest(runtimeId, requestId), true)) break;
          if (!["completed", "failed"].includes(string(result.status))) reject();
          store.reportBotMenuPublishResult(runtimeId, requestId, result as unknown as ReportBotMenuPublishInput);
          break;
        case "plugin.state": {
          try {
            const { state, changed } = store.reportAgentPluginRuntimeStateResult(runtimeId, string(p.version_id), p as unknown as ReportAgentPluginRuntimeStateInput);
            if (changed) store.emitWorkspaceEvent({ type: "agent_plugin:runtime_state", workspaceId: state.workspaceId,
              actorType: "daemon", actorId: session.daemonId, payload: { state: daemonAgentPluginStateResponse(state) } });
          } catch (error) {
            if (typeof (error as { status?: unknown }).status === "number") reject();
            throw error;
          }
          break;
        }
        case "feishu.outbound_result": {
          const runtime = store.getRuntimeLite(runtimeId)!;
          const claimToken = nullable(p.claim_token);
          if (!claimToken) reject();
          if (p.status === "prepared") {
            if (p.mention_open_id !== null && !isFeishuOpenId(p.mention_open_id)) reject();
            const prepared = store.prepareFeishuBotOutboundMention(runtime.workspaceId ?? "local", runtimeId, requestId, claimToken, p.mention_open_id as string | null);
            if (!prepared) {
              const current = store.getFeishuBotOutboundReportState(runtime.workspaceId ?? "local", runtimeId, requestId, claimToken);
              log.warn("Absorbed Feishu mention checkpoint whose lease or policy is no longer current", { deliveryId: requestId, status: current.status });
              return { ok: true, lease_lost: true } satisfies DaemonFeishuOutboundOkReply;
            }
            return { ok: true, mention_open_id: prepared.openId } satisfies DaemonFeishuOutboundOkReply;
          }
          if (!["sent", "failed", "streaming"].includes(string(p.status))) reject();
          const presentation = p.presentation === undefined ? undefined : parseFeishuPresentation(p.presentation);
          if (presentation === null) reject();
          const accepted = store.reportFeishuBotOutbound(runtime.workspaceId ?? "local", runtimeId, requestId, {
            claimToken, status: p.status as "sent" | "failed" | "streaming", externalMessageId: nullable(p.external_message_id),
            error: p.error ? redactFeishuBotError(String(p.error)) : null, presentation,
            retryable: typeof p.retryable === "boolean" ? p.retryable : undefined,
            interactionOpenId: p.interaction_open_id === null ? null : nullable(p.interaction_open_id),
            degraded: FEISHU_DECISION_DEGRADE_REASONS.includes(p.degraded as FeishuDecisionDegradeReason) ? p.degraded as FeishuDecisionDegradeReason : undefined,
          });
          if (!accepted) {
            const current = store.getFeishuBotOutboundReportState(runtime.workspaceId ?? "local", runtimeId, requestId, claimToken);
            const duplicate = current.currentRuntime && current.status === p.status && ["sent", "failed"].includes(current.status);
            if (duplicate || (p.status === "streaming" && current.currentLease)) {
              log.debug("Absorbed replayed Feishu result or old checkpoint", { deliveryId: requestId, status: current.status });
            } else {
              log.warn("Absorbed Feishu result whose lease is no longer current", { deliveryId: requestId, status: current.status });
              return { ok: true, lease_lost: true } satisfies DaemonFeishuOutboundOkReply;
            }
          }
          break;
        }
        case "concierge.status":
        case "concierge.status_report": {
          if (!["stopped", "starting", "online", "failed"].includes(string(p.state))) reject();
          const revision = Number(p.applied_revision);
          store.reportFeishuBotRuntimeStatus(store.getRuntimeLite(runtimeId)!.workspaceId ?? "local", runtimeId, {
            appliedRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
            state: p.state as "stopped" | "starting" | "online" | "failed", botName: nullable(p.bot_name), botOpenId: nullable(p.bot_open_id),
            errorCode: normalizeFeishuBotErrorCode(p.error_code), errorMessage: p.error_message ? redactFeishuBotError(String(p.error_message)) : null,
          });
          break;
        }
        default: reject();
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof TaskDaemonReportError) return { ok: false, code: error.code, retryable: error.retryable };
      if (error instanceof ReportRejection) return { ok: false, code: error.code, retryable: false };
      throw error;
    }
  };
  for (const type of ["task.start", "task.prompt", "task.session_pin", "task.progress", "task.usage", "task.workspace", "task.complete", "task.fail",
    "runtime.update_result", "runtime.command_result", "runtime.model_list_result", "runtime.local_skills_result", "runtime.directory_scan_result",
    "runtime.local_skill_import_result", "runtime.bot_menu_result", "feishu.outbound_result", "plugin.state"]) layer.registerEventHandler(type, handle);
  layer.registerBestEffortHandler("concierge.status", handle);
  // Keep the legacy best-effort frame for older daemons during a rolling upgrade.
  layer.registerRpcHandler("concierge.status_report", handle);
}

export function registerDaemonMaintenanceHandlers(layer: DaemonProtocolLayer, store: MultiremiStore, archives: SessionArchiveService): void {
  const handle = async (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    try {
      const p = frame.payload;
      const runtimeId = frame.rt ?? string(p.runtime_id);
      authorizeReportRuntime(store, session, runtimeId);
      const workspaceId = store.getRuntimeLite(runtimeId)!.workspaceId ?? "local";
      const scoped = <T extends { workspaceId?: string | null }>(value: T | null, message: string, code: string | null = null): T => {
        if (!value || (value.workspaceId ?? "local") !== workspaceId) throw new GcRejection(404, code, message);
        return value;
      };
      switch (frame.type) {
        case "gc.check_issue": {
          const issue = scoped(store.getIssueByRef(string(p.issue_id)), "issue not found");
          const active = store.listTasksForIssue(issue.id).some(task => !terminal(task.status));
          return { ok: true, status: active ? "active" : issue.status, updated_at: issue.updatedAt };
        }
        case "gc.check_chat_session": {
          const chat = scoped(store.getChatSession(string(p.session_id)), "chat session not found");
          return { ok: true, status: chat.status, updated_at: chat.updatedAt };
        }
        case "gc.check_autopilot_run": {
          const run = store.getAutopilotRun(string(p.run_id));
          if (!run) throw new GcRejection(404, null, "autopilot run not found");
          scoped(store.getAutopilot(run.autopilotId), "autopilot run not found");
          return { ok: true, status: run.status, completed_at: run.completedAt };
        }
        case "gc.check_task": {
          const task = scoped(store.getTask(string(p.task_id)), "task not found");
          if (!task.runtimeId || !session.runtimeIds.includes(task.runtimeId)) throw new GcRejection(404, null, "task not found");
          authorizeReportRuntime(store, session, task.runtimeId);
          return { ok: true, status: task.status, completed_at: task.completedAt };
        }
        case "gc.workspace_cleaned": {
          const issueId = string(p.issue_id);
          const archiveId = string(p.archive_id).trim();
          const sourceRevision = string(p.source_revision).trim();
          const sha256 = string(p.sha256).trim().toLowerCase();
          if (!archiveId || !sourceRevision || !/^[a-f0-9]{64}$/.test(sha256)) {
            throw new GcRejection(400, null, "archive_id, source_revision and a 64-character sha256 are required");
          }
          scoped(store.getIssue(issueId), "issue not found", "issue_not_found");
          const current = store.getIssueWorkspace(issueId);
          if (!current) throw new GcRejection(404, "issue_workspace_not_found", "issue workspace not found");
          if (current.runtimeId !== runtimeId) throw new GcRejection(404, "issue_workspace_runtime_mismatch", "runtime does not own issue workspace");
          try {
            const verified = await archives.verify(archiveId);
            if (!verified.valid || verified.archive.issueId !== issueId || verified.archive.sourceRevision !== sourceRevision || verified.archive.sha256 !== sha256) {
              throw new GcRejection(409, "issue_workspace_archive_invalid", "workspace cleanup archive is missing, corrupt, or does not match the exact snapshot");
            }
            const workspace = store.markIssueWorkspaceCleaned({ issueId, runtimeId, archiveId, sourceRevision, sha256 });
            return { ok: true, issue_id: workspace.issueId, status: workspace.status, cleaned_at: workspace.cleanedAt,
              archive_id: workspace.cleanedArchiveId, source_revision: workspace.cleanedArchiveSourceRevision, sha256: workspace.cleanedArchiveSha256 };
          } catch (error) {
            if (error instanceof GcRejection || error instanceof SessionArchiveError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new GcRejection(message.includes("exact ready") ? 409 : 400, null, message);
          }
        }
        default: return null;
      }
    } catch (error) {
      if (error instanceof GcRejection || error instanceof SessionArchiveError) return gcError(error.status, error.code, error.message);
      if (error instanceof ReportRejection) return gcError(error.code === "task_not_found" ? 404 : error.code === "authority_revoked" ? 403 : 400, null, error.message);
      throw error;
    }
  };
  for (const type of ["gc.check_issue", "gc.check_chat_session", "gc.check_autopilot_run", "gc.check_task", "gc.workspace_cleaned"]) layer.registerRpcHandler(type, handle);
}
