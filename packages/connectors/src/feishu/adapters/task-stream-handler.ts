import type { TaskStreamEvent, TaskStreamMeta } from "../../base.js";
import type { PermissionOption } from "@shared/contracts/acp-protocol.js";
import type { FeishuStreamingSession } from "../streaming.js";
import type { ToolEntry } from "../tool-formatters.js";
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
  let usageTokens = 0;
  const tools: ToolEntry[] = [];
  const toolIndexes = new Map<string, number>();

  for await (const event of stream) {
    if (event.kind === "snapshot") {
      const snapshot = event.snapshot;
      sessionId = snapshot.sessionId ?? sessionId;
      const snapshotUsageTokens = snapshot.usage.reduce(
        (total, entry) => total + (
          entry.totalTokens && entry.totalTokens > 0
            ? entry.totalTokens
            : entry.inputTokens + entry.outputTokens
        ),
        0,
      );
      if (snapshotUsageTokens > 0) usageTokens = snapshotUsageTokens;
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
        usageTokens = readUsageTokens(message.meta) || usageTokens;
        break;
      case "tool_use": {
        const name = message.tool || String(message.meta?.title ?? "Tool");
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
          if (entry.resultPreview) session.updateStepDesc(entry.resultPreview.slice(0, 400));
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
  const stats = [
    elapsed > 0 ? `${elapsed}s` : "",
    usageTokens > 0 ? `${formatCount(usageTokens)} tokens` : "",
    tools.length > 0 ? `${tools.length} tools` : "",
  ].filter(Boolean).join(" · ") || null;
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
  const savedStatus = session.getLastStatus();
  let actionId = "";
  let actionPromise: Promise<unknown> | null = null;
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
    const response = question
      ? { answers: objectValue(value) ?? {} }
      : { option_id: permissionDecision(value) };
    await meta.respondHumanRequest(requestId, response);
  } catch (error) {
    if (actionId && hasPendingAction(actionId)) {
      rejectPendingAction(actionId, error instanceof Error ? error.message : String(error));
      await actionPromise?.catch(() => {});
    }
  } finally {
    if (actionId) await session.removePermissionForm(actionId).catch(() => {});
    await session.updateStatus(savedStatus || "Running...");
  }
}

function normalizeQuestions(value: unknown): AskUserQuestionData | null {
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

function normalizePermissionOptions(value: unknown): PermissionOption[] {
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

function readUsageTokens(meta: Record<string, unknown> | null): number {
  const usage = objectValue(meta?.usage) ?? meta ?? {};
  return numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.used) ?? 0;
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

function formatCount(value: number): string {
  return value >= 1_000_000 ? `${Math.round(value / 1_000_000)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}
