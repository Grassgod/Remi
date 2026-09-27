import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import {
  buildTaskInteractionCard as buildSharedTaskInteractionCard,
  interactionMarker,
  normalizePermissionOptions,
  normalizeQuestions,
  type TaskInteractionCardOptions,
} from "@shared/feishu-task-card.js";
import { buildCardHeader } from "./send.js";
import type { AskUserQuestion } from "./permission-ui.js";

type Card = Record<string, unknown>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export {
  buildQuestionElements,
  escapeCardText,
  interactionMarker,
  normalizePermissionOptions,
  normalizeQuestions,
} from "@shared/feishu-task-card.js";

/**
 * The card shape itself is shared with the control plane so a topic card and a
 * proactive decision card render identically. Only the header (which derives
 * the conversation label from connector-owned state) is built here.
 */
export function buildTaskInteractionCard(
  request: MultiremiTaskHumanRequest,
  options: Omit<TaskInteractionCardOptions, "header">,
): Card {
  return buildSharedTaskInteractionCard(request, {
    ...options,
    header: buildCardHeader({ sessionId: options.sessionId, agentName: options.agentName }),
  });
}

function checked(value: unknown): boolean {
  if (value == null || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  if (typeof value === "object") return checked(object(value).checked ?? object(value).value);
  throw new Error("选项值无效，请重新选择");
}

function answerText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  const row = object(value);
  if (typeof row.value === "string") return row.value.trim();
  if (typeof row.content === "string") return row.content.trim();
  throw new Error("自定义回答格式无效");
}

export function parseQuestionAnswers(questions: AskUserQuestion[], form: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = Object.create(null);
  questions.forEach((q, qi) => {
    const selected = q.options.filter((_, oi) => checked(form[`q${qi}_option${oi}`])).map(o => o.label);
    if (!q.multiSelect && selected.length > 1) throw new Error(`问题 ${qi + 1} 只能选择一项`);
    const custom = answerText(form[`q${qi}_custom`]);
    if (custom.length > 500) throw new Error(`问题 ${qi + 1} 的自定义回答过长`);
    if (!selected.length && !custom) throw new Error(`请回答问题 ${qi + 1}`);
    answers[q.question] = [selected.join("、"), custom ? `自定义回答：${custom}` : ""].filter(Boolean).join("\n");
  });
  return answers;
}

interface PendingInteraction {
  appId: string; chatId: string; messageId: string; recipientOpenId?: string;
  /** Present for a Task-stream card; a decision card resolves it on demand. */
  request?: MultiremiTaskHumanRequest; agentName?: string | null; sessionId?: string | null;
  /**
   * Decision cards resolve their request on demand (MUL-407); a Task-stream
   * card already holds the request it was rendered from.
   */
  getRequest?: () => Promise<MultiremiTaskHumanRequest | null>;
  submit: (response: Record<string, unknown>) => Promise<MultiremiTaskHumanRequest>;
  settled?: MultiremiTaskHumanRequest;
  submitting?: Promise<MultiremiTaskHumanRequest>;
}
const pending = new Map<string, PendingInteraction>();

/** Re-registered using the persisted message ID when a delivery is reclaimed. */
export function registerTaskInteraction(entry: PendingInteraction): { current: () => MultiremiTaskHumanRequest | undefined; dispose: () => void } {
  const key = `${entry.appId}:${entry.messageId}`;
  pending.set(key, entry);
  return { current: () => entry.settled, dispose: () => { if (pending.get(key) === entry) pending.delete(key); } };
}

/** What a decision card needs from its owner to answer a click (MUL-407). */
export interface DecisionCardInteraction {
  appId: string;
  chatId: string;
  messageId: string;
  recipientOpenId: string;
  /**
   * Re-read the request on every click. Capturing it would freeze the payload
   * and status the host happened to hold when it registered, which is wrong
   * for a restarted host re-registering a card it did not send in this process.
   */
  getRequest: () => Promise<MultiremiTaskHumanRequest | null>;
  submit: (response: Record<string, unknown>) => Promise<MultiremiTaskHumanRequest>;
  agentName?: string | null;
  sessionId?: string | null;
}

/**
 * Register a click handler for a decision card (MUL-407).
 *
 * The Task-stream presentation registers its own cards from the checkpoint it
 * owns; a decision card has no stream, so the host registers here instead. The
 * request is resolved on demand, which is what lets a restarted host rebuild
 * the same registration from the persisted delivery row.
 */
export function registerDecisionCardInteraction(
  entry: DecisionCardInteraction,
): { dispose: () => void } {
  const key = `${entry.appId}:${entry.messageId}`;
  pending.set(key, {
    appId: entry.appId,
    chatId: entry.chatId,
    messageId: entry.messageId,
    recipientOpenId: entry.recipientOpenId,
    agentName: entry.agentName ?? null,
    sessionId: entry.sessionId ?? null,
    getRequest: entry.getRequest,
    submit: async response => {
      const request = await entry.getRequest();
      if (request && request.status !== "pending") return request;
      try {
        return await entry.submit(response);
      } catch (error) {
        // A concurrent answer (the web workbench, or a second device) wins;
        // report its result rather than failing a request already settled.
        const latest = await entry.getRequest();
        if (latest && latest.status !== "pending") return latest;
        throw error;
      }
    },
  });
  return { dispose: () => { if (pending.get(key)) pending.delete(key); } };
}

/** Native-task actions are never passed to the legacy in-memory permission map. */
export async function handleTaskInteractionEvent(appId: string, raw: unknown): Promise<Card | null> {
  const event = object(raw), action = object(event.action), context = object(event.context);
  if (typeof action.name !== "string" || !action.name.startsWith("fr_")) return null;
  const entry = pending.get(`${appId}:${String(context.open_message_id ?? "")}`);
  const toast = (content: string, type = "error") => ({ toast: { type, content } });
  if (!entry) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (context.open_chat_id !== entry.chatId || !entry.recipientOpenId
    || object(event.operator).open_id !== entry.recipientOpenId) return toast("请由卡片中指定的处理人提交");
  // A decision card re-reads the request so an answer given on the web while
  // the card was on screen is reflected instead of being overwritten.
  const request = entry.getRequest ? await entry.getRequest() : entry.request ?? null;
  if (!request) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (request.status !== "pending") {
    return { ...toast("请求已结束", "info"),
      card: { type: "raw", data: buildTaskInteractionCard(request,
        { agentName: entry.agentName, sessionId: entry.sessionId, receipt: true }) } };
  }
  const marker = interactionMarker(request.taskId, request.id);
  try {
    let response: Record<string, unknown>;
    const form = object(action.form_value);
    if (request.kind === "question") {
      if (action.name !== marker) return toast("操作与当前问题不匹配");
      const data = normalizeQuestions(request.payload.questions);
      if (!data) return toast("问题格式无效，请在工作台处理");
      response = { answers: parseQuestionAnswers(data.questions, form) };
    } else {
      const options = normalizePermissionOptions(request.payload.options);
      const index = options.findIndex((_, i) => action.name === `${marker}_o${i}`);
      if (index < 0) return toast("审批选项无效");
      response = { option_id: options[index]!.optionId };
    }
    // Canonical server compare-and-set happens before acknowledging success.
    // Concurrent callbacks join the first write, never submit a second answer.
    entry.submitting ??= entry.submit(response)
      .then(result => { entry.settled = result; return result; })
      .catch(error => { entry.submitting = undefined; throw error; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); });
    const settled = await Promise.race([entry.submitting, deadline]).finally(() => clearTimeout(timer));
    // Stay inside Feishu's callback deadline. The delivery loop will patch the
    // receipt once the same in-flight server request is actually acknowledged.
    if (!settled) return toast("正在提交，请稍候", "info");
    return { ...toast(settled.status === "responded" ? "已提交" : "请求已结束", settled.status === "responded" ? "success" : "info"),
      card: { type: "raw", data: buildTaskInteractionCard(settled, { agentName: entry.agentName, sessionId: entry.sessionId, receipt: true }) } };
  } catch (error) {
    return toast(error instanceof Error && !/HTTP|fetch|token/i.test(error.message) ? error.message.slice(0, 100) : "提交未确认，请稍后重试");
  }
}
