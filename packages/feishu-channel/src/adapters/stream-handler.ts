/**
 * handleAgentStream — translates an ACP SessionUpdate stream into Feishu streaming card operations.
 *
 * Protocol conversion: ACP events → FeishuStreamingSession calls.
 * Supports both Claude Code and Codex via the AgentAdapter interface.
 */

import type {
  SessionUpdate,
  RequestPermissionParams,
  PermissionOutcome,
  PermissionOption,
  ElicitationCreateParams,
  ElicitationResult,
  AskUserQuestionData,
  AgentAdapter,
  StreamMeta,
  StreamHandlerLog,
} from "@remi/acp-provider";
import { elicitationToQuestions, answersToElicitationContent } from "@remi/acp-provider";
export type { StreamMeta, StreamHandlerLog } from "@remi/acp-provider";
import type { FeishuStreamingSession } from "../streaming.js";
import type { ToolEntry } from "../tool-formatters.js";
import { formatToolInputSummary, shortPath } from "../tool-formatters.js";
import { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "../permission-ui.js";
import { registerPendingAction, rejectPendingAction, rejectPendingActionsForChat, hasPendingAction } from "../card-actions.js";

// ── Plan task tracking ────────────────────────────────────────

interface PlanTask {
  id: string;
  subject: string;
  status: string;
}

interface ActiveAgent {
  toolUseId: string;
  description: string;
  startTime: number;
}

const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);

function renderPlanStatus(tasks: PlanTask[], elapsed?: number): string {
  if (tasks.length === 0) return "";
  const completed = tasks.filter((t) => t.status === "completed").length;
  const header = elapsed != null
    ? `Plan (${completed}/${tasks.length}) · ${elapsed}s`
    : `Plan (${completed}/${tasks.length})`;
  const lines = [header];
  for (const t of tasks) {
    const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·";
    lines.push(`${icon} ${t.subject}`);
  }
  return lines.join("\n");
}

function renderCombinedStatus(planTasks: PlanTask[], activeAgents: ActiveAgent[], elapsed?: number): string {
  const parts: string[] = [];
  if (planTasks.length > 0) parts.push(renderPlanStatus(planTasks, elapsed));
  if (activeAgents.length > 0) {
    const elapsedSuffix = elapsed != null && planTasks.length === 0 ? ` · ${elapsed}s` : "";
    const agentLines = [`Agents (${activeAgents.length} active)${elapsedSuffix}`];
    for (const a of activeAgents) {
      const agentElapsed = ((Date.now() - a.startTime) / 1000).toFixed(0);
      agentLines.push(`→ ${a.description} (${agentElapsed}s)`);
    }
    parts.push(agentLines.join("\n"));
  }
  return parts.join("\n\n");
}

function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const trunc = (t: string, max: number) => t.length <= max ? t : t.slice(0, max - 3) + "...";
  const MAX = 400;
  switch (name) {
    case "Read": return `Reading ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Bash": return `Running: ${trunc(shortPath(s(input?.command).split("\n")[0]), MAX)}`;
    case "Grep": return `Searching: ${trunc(s(input?.pattern), MAX)}...`;
    case "Edit": case "Write": return `Editing ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Glob": return `Finding: ${trunc(s(input?.pattern), MAX)}...`;
    case "WebFetch": return `Fetching: ${trunc(s(input?.url), MAX)}...`;
    case "WebSearch": return `Searching: ${trunc(s(input?.query), MAX)}...`;
    case "Agent": return `Agent: ${trunc(s(input?.description ?? input?.prompt), MAX)}...`;
    default: return `Tool: ${name}...`;
  }
}

// ── Permission option helpers ─────────────────────────────────

function selectPermissionOption(
  options: PermissionOption[],
  preferredIds: string[],
  fallbackKinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const id of preferredIds) {
    const option = options.find((o) => o.optionId === id);
    if (option) return option;
  }
  for (const kind of fallbackKinds) {
    const option = options.find((o) => o.kind === kind);
    if (option) return option;
  }
  return undefined;
}

export function allowCurrentToolOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(options, ["allow"], ["allow_once", "allow_always"]);
}

export function approvePlanOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(options, ["default", "acceptEdits", "auto", "allow"], ["allow_once", "allow_always"]);
}

export function rejectPermissionOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(options, ["reject", "plan"], ["reject_once", "reject_always"]);
}

export function isPlanApproval(value: unknown): boolean {
  const decision = formValueText(value, "decision").toLowerCase();
  return decision === "approved" || decision === "approve" || decision === "allow";
}

function formValueText(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join(", ");
  if (typeof raw === "object" && "value" in raw) return String((raw as Record<string, unknown>).value ?? "");
  return String(raw);
}

function selectedPermissionOption(value: unknown, options: PermissionOption[]): PermissionOption | undefined {
  const decision = typeof value === "string" ? value : formValueText(value, "decision");
  if (!decision) return undefined;
  return options.find((option) => option.optionId === decision);
}

function normalizeAskAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const answers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) continue;
    answers[key] = answerValueText(raw);
  }
  return answers;
}

function answerValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(answerValueText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.content === "string") return obj.content;
    if (obj.text && typeof obj.text === "object") return answerValueText((obj.text as Record<string, unknown>).content);
  }
  return String(value);
}

// ── Main export ───────────────────────────────────────────────

/**
 * Consume an ACP SessionUpdate stream, driving a FeishuStreamingSession.
 * Returns stats: { elapsedSec, usageTokens, contextWindow, toolCount }.
 */
export async function handleAgentStream(
  session: FeishuStreamingSession,
  stream: AsyncIterable<SessionUpdate>,
  acpAdapter: AgentAdapter,
  chatId: string,
  log: StreamHandlerLog,
  meta: StreamMeta,
): Promise<{ elapsedSec: number; usageTokens: number; contextWindow: number | null; toolCount: number; contentText: string; thinkingText: string; toolEntries: ToolEntry[] }> {
  let thinkingText = "";
  let contentText = "";
  let toolCount = 0;
  const toolEntries: ToolEntry[] = [];
  let currentThinkingSegment = "";
  let trailingThinkingFlushed = false;
  let usageTokens = 0;
  let usageContextWindow: number | null = null;

  const planTasks: PlanTask[] = [];
  const activeAgents: ActiveAgent[] = [];

  const syncHeartbeatRenderer = () => {
    if (planTasks.length > 0 || activeAgents.length > 0) {
      session.setHeartbeatRenderer((elapsed) =>
        renderCombinedStatus(planTasks, activeAgents, elapsed) || `Running (${elapsed}s)`,
      );
    } else {
      session.setHeartbeatRenderer(null);
    }
  };

  // Serialize permission + elicitation forms so only one card form is shown at a time.
  let permissionQueue: Promise<void> = Promise.resolve();

  // Register permission handler
  if (meta.setPermissionHandler) {
    const handlePermissionRequest = async (params: RequestPermissionParams): Promise<PermissionOutcome> => {
      const askData = acpAdapter.extractAskUserQuestion(params.toolCall);
      const isExitPlan = acpAdapter.isExitPlanMode(params.toolCall);
      const toolName = acpAdapter.resolveToolName(params.toolCall);

      const savedStatus = session.getLastStatus();
      let actionId = "";
      let result: unknown;
      let resolved = false;
      let actionPromise: Promise<unknown> | null = null;

      try {
        actionPromise = new Promise<unknown>((resolve, reject) => {
          const questions = askData
            ? askData.questions.map((q) => ({ question: q.question, options: q.options }))
            : undefined;
          actionId = registerPendingAction(resolve, reject, questions, chatId);
        });

        let form;
        if (askData) {
          form = buildAskQuestionForm(actionId, askData);
          session.updateStatus("Waiting for input...");
        } else if (isExitPlan) {
          const planContent = typeof params.toolCall.rawInput === "object" && params.toolCall.rawInput
            ? String((params.toolCall.rawInput as any).planContent ?? (params.toolCall.rawInput as any).plan ?? "")
            : undefined;
          form = buildPlanReviewForm(actionId, planContent || undefined);
          session.updateStatus("Waiting for approval...");
        } else {
          const inputSummary = formatToolInputSummary(toolName, acpAdapter.extractToolInput(params.toolCall) ?? undefined);
          form = buildToolApprovalForm(actionId, toolName, inputSummary, params.options);
          session.updateStatus(`Waiting for ${toolName} approval...`);
        }

        log.info(`permission request: type=${askData ? "ask" : isExitPlan ? "plan" : "tool"} tool=${toolName} actionId=${actionId}`);
        await session.appendPermissionForm(form);
        result = await actionPromise;
        resolved = true;
      } catch (err) {
        if (actionId && hasPendingAction(actionId)) {
          rejectPendingAction(actionId, String(err));
          await actionPromise?.catch(() => {});
        }
        log.info(`permission cancelled: tool=${toolName} reason=${String(err)}`);
        return { outcome: "cancelled" };
      } finally {
        if (actionId) {
          await session.removePermissionForm(actionId, { preservePanel: isExitPlan && resolved }).catch(() => {});
        }
        await session.updateStatus(savedStatus || "Running...");
      }

      if (askData) {
        const option = allowCurrentToolOption(params.options);
        const answers = normalizeAskAnswers(result);
        return option
          ? { outcome: "selected", optionId: option.optionId, updatedInput: { questions: askData.questions, answers } }
          : { outcome: "cancelled" };
      }

      if (isExitPlan) {
        if (isPlanApproval(result)) {
          const option = approvePlanOption(params.options);
          return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
        }
        const option = rejectPermissionOption(params.options);
        return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
      }

      const selected = selectedPermissionOption(result, params.options);
      return selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" };
    };

    meta.setPermissionHandler((params: RequestPermissionParams): Promise<PermissionOutcome> => {
      const run = () => handlePermissionRequest(params);
      const queued = permissionQueue.then(run, run);
      permissionQueue = queued.then(() => undefined, () => undefined);
      return queued;
    });
  }

  // Register elicitation handler — Claude ACP (>= 0.44.0) delivers AskUserQuestion
  // as a form elicitation. Reuse the same question-form UI as the permission path.
  if (meta.setElicitationHandler) {
    const handleElicitationRequest = async (params: ElicitationCreateParams): Promise<ElicitationResult> => {
      const elicQuestions = elicitationToQuestions(params);
      if (!elicQuestions) {
        log.info(`elicitation declined: unsupported mode=${params.mode}`);
        return { action: "decline" };
      }
      const askData: AskUserQuestionData = { questions: elicQuestions.map((q) => q.question) };

      const savedStatus = session.getLastStatus();
      let actionId = "";
      let result: unknown;
      let actionPromise: Promise<unknown> | null = null;

      try {
        actionPromise = new Promise<unknown>((resolve, reject) => {
          const questions = elicQuestions.map((q) => ({ question: q.question.question, options: q.question.options }));
          actionId = registerPendingAction(resolve, reject, questions, chatId);
        });

        const form = buildAskQuestionForm(actionId, askData);
        session.updateStatus("Waiting for input...");
        log.info(`elicitation request: fields=${elicQuestions.length} actionId=${actionId}`);
        await session.appendPermissionForm(form);
        result = await actionPromise;
      } catch (err) {
        if (actionId && hasPendingAction(actionId)) {
          rejectPendingAction(actionId, String(err));
          await actionPromise?.catch(() => {});
        }
        log.info(`elicitation cancelled: reason=${String(err)}`);
        return { action: "decline" };
      } finally {
        if (actionId) {
          await session.removePermissionForm(actionId).catch(() => {});
        }
        await session.updateStatus(savedStatus || "Running...");
      }

      const answers = normalizeAskAnswers(result);
      const content = answersToElicitationContent(elicQuestions, answers);
      return { action: "accept", content };
    };

    meta.setElicitationHandler((params: ElicitationCreateParams): Promise<ElicitationResult> => {
      const run = () => handleElicitationRequest(params);
      const queued = permissionQueue.then(run, run);
      permissionQueue = queued.then(() => undefined, () => undefined);
      return queued;
    });
  }

  const toolStartTimes = new Map<string, number>();
  const seenInputs = new Set<string>();
  const acpToolNames = new Map<string, string>();

  try {
    for await (const event of stream) {
      if (session.abortSignal.aborted) {
        log.warn("Safety timeout aborted stream consumption");
        break;
      }

      const e = event as any;
      switch (e.sessionUpdate) {
        case "agent_thought_chunk": {
          const blocks = Array.isArray(e.content) ? e.content : [e.content];
          for (const b of blocks) {
            if (b?.type === "text" && b.text) {
              thinkingText += b.text;
              currentThinkingSegment += b.text;
            }
          }
          if (planTasks.length === 0 && activeAgents.length === 0) {
            await session.updateStatus("Thinking...");
          }
          await session.updateThinking(thinkingText);
          break;
        }
        case "agent_message_chunk": {
          const blocks = Array.isArray(e.content) ? e.content : [e.content];
          for (const b of blocks) {
            if (b?.type === "text" && b.text) contentText += b.text;
          }
          if (!trailingThinkingFlushed && currentThinkingSegment.trim()) {
            session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
            trailingThinkingFlushed = true;
          }
          if (planTasks.length === 0 && activeAgents.length === 0) {
            await session.updateStatus("Writing...");
          }
          await session.update(contentText);
          break;
        }
        case "tool_call": {
          const toolName = acpAdapter.resolveToolName(e);
          const input = acpAdapter.extractToolInput(e);
          acpToolNames.set(e.toolCallId, toolName);
          toolStartTimes.set(e.toolCallId, Date.now());
          toolCount++;

          if (toolName === "TodoWrite" && input?.todos) {
            const todos = input.todos as Array<Record<string, unknown>>;
            planTasks.length = 0;
            for (const t of todos) {
              planTasks.push({ id: String(t.id ?? planTasks.length), subject: String(t.content ?? t.subject ?? ""), status: String(t.status ?? "pending") });
            }
            syncHeartbeatRenderer();
            await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
          } else if (toolName === "TaskCreate" && input) {
            planTasks.push({ id: `_pending_${e.toolCallId}`, subject: String(input.subject ?? ""), status: "pending" });
            syncHeartbeatRenderer();
            await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
          } else if (toolName === "TaskUpdate" && input) {
            const task = planTasks.find((t) => t.id === String(input.taskId));
            if (task) {
              if (input.status === "deleted") {
                const idx = planTasks.indexOf(task);
                if (idx !== -1) planTasks.splice(idx, 1);
              } else {
                if (input.status) task.status = String(input.status);
                if (input.subject) task.subject = String(input.subject);
              }
              syncHeartbeatRenderer();
              await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
            }
          } else if (toolName === "Agent") {
            activeAgents.push({ toolUseId: e.toolCallId, description: String(input?.description ?? input?.prompt ?? "").slice(0, 60), startTime: Date.now() });
            syncHeartbeatRenderer();
            await session.updateStatus(renderCombinedStatus(planTasks, activeAgents, session.getElapsed()));
          } else if (!PLAN_TOOLS.has(toolName)) {
            if (planTasks.length === 0 && activeAgents.length === 0) {
              await session.updateStatus(formatToolStatus(toolName, input));
            }
          }

          toolEntries.push({ name: toolName, input, status: "pending", thinkingBefore: currentThinkingSegment });
          if (currentThinkingSegment.trim()) {
            session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
          }
          currentThinkingSegment = "";
          trailingThinkingFlushed = false;
          break;
        }
        case "tool_call_update": {
          const toolName = acpToolNames.get(e.toolCallId) ?? acpAdapter.resolveToolName(e);

          if (e.status === "completed" || e.status === "failed") {
            const startTime = toolStartTimes.get(e.toolCallId);
            const durationMs = startTime ? Date.now() - startTime : undefined;
            toolStartTimes.delete(e.toolCallId);
            acpToolNames.delete(e.toolCallId);
            seenInputs.delete(e.toolCallId);
            const resultPreview = acpAdapter.extractResultPreview(e);
            const resolvedInput = acpAdapter.extractToolInput(e);

            if (toolName === "TaskCreate" && resultPreview) {
              const match = resultPreview.match(/Task #(\S+)/);
              if (match) {
                const task = planTasks.find((t) => t.id === `_pending_${e.toolCallId}`);
                if (task) task.id = match[1];
              }
            }
            if (toolName === "Agent") {
              const idx = activeAgents.findIndex((a) => a.toolUseId === e.toolCallId);
              if (idx !== -1) activeAgents.splice(idx, 1);
              syncHeartbeatRenderer();
            }
            await session.updateStatus(renderCombinedStatus(planTasks, activeAgents, session.getElapsed()) || "Thinking...");

            const entry = toolEntries.findLast((en) => en.status === "pending");
            if (entry) {
              entry.status = "done";
              entry.durationMs = durationMs;
              entry.resultPreview = resultPreview;
              if (resolvedInput && !entry.input) entry.input = resolvedInput;
              if (!entry.stepAdded) {
                entry.stepAdded = true;
                const desc = `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim();
                session.addStep(entry.name, desc);
              }
            }
            if (durationMs) session.updateStepDuration(durationMs);
          } else {
            const alreadySeen = seenInputs.has(e.toolCallId);
            const input = acpAdapter.extractToolInput(e);
            const inputKeys = input ? Object.keys(input) : [];

            if (!alreadySeen && (toolName === "AskUserQuestion" || toolName === "ExitPlanMode")) {
              seenInputs.add(e.toolCallId);
            } else if (!alreadySeen && input && inputKeys.length > 0) {
              seenInputs.add(e.toolCallId);

              if (toolName === "Agent") {
                const desc = String(input.description ?? input.prompt ?? "").slice(0, 60);
                const agent = activeAgents.find((a) => a.toolUseId === e.toolCallId);
                if (agent && desc) {
                  agent.description = desc;
                  syncHeartbeatRenderer();
                  await session.updateStatus(renderCombinedStatus(planTasks, activeAgents, session.getElapsed()));
                }
              }

              const pendingEntry = toolEntries.findLast((en) => en.status === "pending" && en.name === toolName);
              if (pendingEntry && !pendingEntry.stepAdded) {
                pendingEntry.input = input;
                pendingEntry.stepAdded = true;
                const inputSummary = formatToolInputSummary(toolName, input);
                session.addStep(toolName, `${toolName} ${inputSummary}`.trim());
                if (planTasks.length === 0 && activeAgents.length === 0) {
                  await session.updateStatus(formatToolStatus(toolName, input));
                }
              }
            }
          }
          break;
        }
        case "usage_update": {
          if (e.used != null) usageTokens = e.used;
          if (e.size != null) usageContextWindow = e.size;
          break;
        }
        case "plan": {
          if (Array.isArray(e.entries)) {
            planTasks.length = 0;
            for (const entry of e.entries) {
              planTasks.push({ id: String(entry.id ?? planTasks.length), subject: String(entry.content ?? ""), status: String(entry.status ?? "pending") });
            }
            syncHeartbeatRenderer();
            await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
          }
          break;
        }
      }
    }
  } catch (streamErr) {
    const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
    log.error(`Stream error: ${message}`);
    contentText += `\n\n**Error:** ${message}\n`;
  }

  return {
    elapsedSec: session.getElapsed(),
    usageTokens,
    contextWindow: usageContextWindow,
    toolCount,
    contentText,
    thinkingText,
    toolEntries,
  };
}
