import type { TaskStreamEvent, TaskStreamMeta } from "../../base.js";
import type { PermissionOption } from "@shared/contracts/acp-protocol.js";
import type { FeishuStreamingSession } from "../streaming.js";
import type { ToolEntry } from "../tool-formatters.js";
import { executionModel, readContextUsage, type ContextUsage } from "@shared/agent-execution.js";
import { formatCardStats } from "../card-metadata.js";
import { formatToolInputSummary } from "../tool-formatters.js";
import {
  buildAskQuestionForm,
  buildPlanReviewForm,
  buildToolApprovalForm,
  type AskUserQuestionData,
} from "../permission-ui.js";
import {
  hasPendingAction,
  registerPendingAction,
  rejectPendingAction,
} from "../card-actions.js";

interface TaskStreamResult {
  contentText: string;
  thinkingText: string;
  toolEntries: ToolEntry[];
  toolCount: number;
  stats: string | null;
  sessionId: string | null;
  failed: boolean;
  cancelled: boolean;
}

export async function handleTaskStream(
  session: FeishuStreamingSession,
  stream: AsyncIterable<TaskStreamEvent>,
  chatId: string,
  meta: TaskStreamMeta,
): Promise<TaskStreamResult> {
  let contentText = "";
  let thinkingText = "";
  let sessionId = meta.sessionId ?? null;
  let failed = false;
  let cancelled = false;
  let contextUsage: ContextUsage | null = null;
  let currentModel: string | null | undefined;
  const tools: ToolEntry[] = [];
  const toolIndexes = new Map<string, number>();

  for await (const event of stream) {
    meta.signal?.throwIfAborted();
    if (event.kind === "snapshot") {
      const snapshot = event.snapshot;
      sessionId = snapshot.sessionId ?? sessionId;
      // Billing usage in the terminal snapshot must never replace context used/size.
      failed = snapshot.status === "failed";
      cancelled = snapshot.status === "cancelled";
      if (snapshot.status === "completed" && snapshot.result && !contentText.trim()) {
        contentText = snapshot.result;
        await session.update(contentText);
      }
      if (failed && snapshot.error) {
        contentText = `${contentText}${contentText ? "\n\n" : ""}**Error:** ${snapshot.error}`;
        await session.update(contentText);
      }
      continue;
    }

    const message = event.message;
    switch (message.type) {
      case "text":
        contentText += message.content ?? "";
        await session.update(contentText);
        break;
      case "thinking":
        thinkingText += message.content ?? "";
        await session.updateThinking(thinkingText);
        break;
      case "compaction":
        session.addStep("_thinking", message.content || "Context compacted");
        break;
      case "plan":
        await session.updateStatus(renderPlan(message.meta?.entries));
        break;
      case "usage":
        if (message.meta?.parent_tool_call_id) break;
        {
          const usage = readContextUsage(message.meta);
          if (usage) {
            contextUsage = usage;
            session.updateContextUsage(usage);
          }
        }
        break;
      case "execution":
        if (message.meta?.parent_tool_call_id) break;
        {
          const info = message.meta ?? {};
          const model = Object.hasOwn(info, "model") ? executionModel(info.model) : undefined;
          if (model !== undefined) {
            if (currentModel !== undefined && model !== currentModel) {
              contextUsage = null;
              session.updateContextUsage(null);
            }
            currentModel = model;
          }
          session.updateExecution({
            ...(typeof info.agentName === "string" ? { agentName: info.agentName } : {}),
            ...(typeof info.provider === "string" ? { provider: info.provider } : {}),
            ...(model !== undefined ? { model, modelName: typeof info.modelName === "string" ? info.modelName : null } : {}),
          });
        }
        break;
      case "tool_use": {
        const name = message.tool || String(message.meta?.title ?? "Tool");
        const existingIndex = message.toolCallId ? toolIndexes.get(message.toolCallId) : undefined;
        if (existingIndex != null) {
          const existing = tools[existingIndex]!;
          existing.input = { ...existing.input, ...message.input };
          if (existingIndex === tools.length - 1) {
            session.updateStepDesc(`${existing.name} ${formatToolInputSummary(existing.name, existing.input)}`.trim());
          }
          continue;
        }
        const entry: ToolEntry = {
          name,
          input: message.input ?? undefined,
          status: "pending",
          thinkingBefore: thinkingText,
        };
        const index = tools.push(entry) - 1;
        if (message.toolCallId) toolIndexes.set(message.toolCallId, index);
        const summary = formatToolInputSummary(name, message.input ?? undefined);
        session.addStep(name, `${name}${summary ? ` ${summary}` : ""}`);
        await session.updateStatus(`Running ${name}...`);
        break;
      }
      case "tool_result": {
        const index = message.toolCallId ? toolIndexes.get(message.toolCallId) : undefined;
        const entry = index == null ? tools.findLast((item) => item.status === "pending") : tools[index];
        if (entry) {
          entry.status = "done";
          entry.resultPreview = message.output ?? message.content ?? undefined;
          entry.durationMs = numberValue(message.meta?.duration_ms);
          if (entry.resultPreview) session.updateStepDesc(
            `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}: ${entry.resultPreview.slice(0, 400)}`.trim(),
          );
          if (entry.durationMs) session.updateStepDuration(entry.durationMs);
        }
        await session.updateStatus(message.status === "failed" ? "Tool failed" : "Thinking...");
        break;
      }
      case "permission_request":
        await handleHumanRequest(session, chatId, meta, message.input ?? {}, false);
        break;
      case "question_request":
        await handleHumanRequest(session, chatId, meta, message.input ?? {}, true);
        break;
      case "permission_response":
      case "question_response":
        await session.updateStatus("Running...");
        break;
    }
  }

  const elapsed = session.getElapsed();
  const stats = formatCardStats(elapsed, contextUsage, tools.length);
  return { contentText, thinkingText, toolEntries: tools, toolCount: tools.length, stats, sessionId, failed, cancelled };
}

async function handleHumanRequest(
  session: FeishuStreamingSession,
  chatId: string,
  meta: TaskStreamMeta,
  input: Record<string, unknown>,
  question: boolean,
): Promise<void> {
  const requestId = String(input.request_id ?? "").trim();
  if (!requestId) return;
  if (meta.isHumanRequestPending && !await meta.isHumanRequestPending(requestId)) return;
  meta.signal?.throwIfAborted();
  const savedStatus = session.getLastStatus();
  let actionId = "";
  let actionPromise: Promise<unknown> | null = null;
  let settledElsewhere = false;
  let checking = false;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  const onAbort = () => { if (actionId) rejectPendingAction(actionId, "Task stream interrupted"); };
  try {
    const questions = question ? normalizeQuestions(input.questions) : null;
    actionPromise = new Promise<unknown>((resolve, reject) => {
      actionId = registerPendingAction(
        resolve,
        reject,
        questions?.questions.map((item) => ({ question: item.question, options: item.options })) ?? undefined,
        chatId,
      );
    });
    void actionPromise.catch(() => {});
    meta.signal?.addEventListener("abort", onAbort, { once: true });
    if (meta.isHumanRequestPending) {
      checkTimer = setInterval(() => {
        if (checking) return;
        checking = true;
        void meta.isHumanRequestPending!(requestId).then(pending => {
          if (!pending) {
            settledElsewhere = true;
            rejectPendingAction(actionId, "Request settled outside this card");
          }
        }).catch(onAbort).finally(() => { checking = false; });
      }, 1000);
    }
    if (question && questions) {
      await session.updateStatus("Waiting for input...");
      await session.appendPermissionForm(buildAskQuestionForm(actionId, questions));
    } else {
      const options = normalizePermissionOptions(input.options);
      const toolCall = objectValue(input.tool_call);
      const toolName = String(toolCall?.title ?? toolCall?.name ?? "Tool");
      const rawInput = objectValue(toolCall?.rawInput ?? toolCall?.raw_input);
      await session.updateStatus(`Waiting for ${toolName} approval...`);
      if (toolName === "ExitPlanMode") {
        await session.appendPermissionForm(buildPlanReviewForm(actionId, String(rawInput?.planContent ?? rawInput?.plan ?? "") || undefined));
      } else {
        await session.appendPermissionForm(buildToolApprovalForm(
          actionId,
          toolName,
          formatToolInputSummary(toolName, rawInput ?? undefined),
          options,
        ));
      }
    }
    const value = await actionPromise;
    meta.signal?.throwIfAborted();
    const response = question
      ? { answers: objectValue(value) ?? {} }
      : { option_id: permissionDecision(value) };
    await meta.respondHumanRequest(requestId, response);
  } catch (error) {
    if (actionId && hasPendingAction(actionId)) {
      rejectPendingAction(actionId, error instanceof Error ? error.message : String(error));
      await actionPromise?.catch(() => {});
    }
    if (meta.signal?.aborted) throw meta.signal.reason;
    if (meta.isHumanRequestPending && !settledElsewhere) throw error;
  } finally {
    clearInterval(checkTimer);
    meta.signal?.removeEventListener("abort", onAbort);
    if (actionId) await session.removePermissionForm(actionId).catch(() => {});
    await session.updateStatus(savedStatus || "Running...");
  }
}

export function normalizeQuestions(value: unknown): AskUserQuestionData | null {
  if (!Array.isArray(value)) return null;
  const questions = value.map((raw) => {
    const row = objectValue(raw) ?? {};
    // The daemon persists ElicitationQuestion as
    // { fieldKey, question: AskQuestion }. Accept the old flat shape too so
    // connector-owned callers remain compatible.
    const nestedQuestion = objectValue(row.question);
    const question = nestedQuestion ?? row;
    return {
      question: String(question.question ?? "Question"),
      header: typeof question.header === "string" ? question.header : undefined,
      options: Array.isArray(question.options)
        ? question.options.map((option) => {
          const item = objectValue(option);
          return item
            ? { label: String(item.label ?? item.value ?? "Option"), description: typeof item.description === "string" ? item.description : undefined }
            : { label: String(option) };
        })
        : [],
      multiSelect: question.multiSelect === true || question.multi_select === true,
    };
  });
  return questions.length ? { questions } : null;
}

export function normalizePermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const row = objectValue(raw) ?? {};
    return {
      optionId: String(row.optionId ?? row.option_id ?? `option_${index}`),
      name: String(row.name ?? row.optionId ?? row.option_id ?? `Option ${index + 1}`),
      kind: String(row.kind ?? "allow_once") as PermissionOption["kind"],
    };
  });
}

function permissionDecision(value: unknown): string {
  if (typeof value === "string") return value;
  return String(objectValue(value)?.decision ?? "");
}

function renderPlan(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "Planning...";
  const rows = value.map((raw) => objectValue(raw) ?? {});
  const completed = rows.filter((row) => row.status === "completed").length;
  return [`Plan (${completed}/${rows.length})`, ...rows.map((row) => {
    const icon = row.status === "completed" ? "✓" : row.status === "in_progress" ? "→" : "·";
    return `${icon} ${String(row.content ?? row.subject ?? "")}`;
  })].join("\n");
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
