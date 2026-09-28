import type { MultiremiIssueDecision, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import {
  buildIssueDecisionCard as buildSharedIssueDecisionCard,
  buildTaskInteractionCard as buildSharedTaskInteractionCard,
  decisionInteractionMarker,
  interactionMarker,
  normalizePermissionOptions,
  normalizeQuestions,
  type IssueDecisionCardOptions,
  type TaskInteractionCardOptions,
} from "@shared/feishu-task-card.js";
import { buildCardHeader } from "./send.js";
import type { AskUserQuestion } from "./permission-ui.js";

type Card = Record<string, unknown>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export {
  buildQuestionElements,
  decisionInteractionMarker,
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

/**
 * The connector's header for an Issue decision card (MUL-412). Only the header
 * differs from the control plane's copy: the conversation label is
 * connector-owned, exactly as it is for a human-request card.
 */
export function buildIssueDecisionCard(
  decision: MultiremiIssueDecision,
  options: Omit<IssueDecisionCardOptions, "header"> & { agentName?: string | null; sessionId?: string | null },
): Card {
  return buildSharedIssueDecisionCard(decision, {
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

/**
 * What a registered Issue decision card needs to answer a click (MUL-412).
 *
 * The decision is re-read on every click for the same reason a human request
 * is: the card may have been settled in the web workbench while it was on
 * screen, and a restarted host re-registers cards it did not send.
 */
export interface IssueDecisionCardInteraction {
  appId: string;
  chatId: string;
  messageId: string;
  recipientOpenId: string;
  getDecision: () => Promise<MultiremiIssueDecision | null>;
  /**
   * Answer with what the person submitted plus the operator the callback named.
   * The server maps that open_id to a workspace member itself; no member id or
   * answerer field ever travels from here.
   */
  submit: (answer: string, operatorOpenId: string) => Promise<MultiremiIssueDecision>;
  agentName?: string | null;
  sessionId?: string | null;
}

const pendingDecisions = new Map<string, IssueDecisionCardInteraction>();

function issueDecisionFailureToast(error: unknown): string {
  const value = object(error);
  const code = typeof value.code === "string" ? value.code.trim() : "";
  const status = typeof value.status === "number" ? value.status : null;
  if (code === "decision_member_unmapped") {
    return "本次没有提交：飞书身份还未关联到 Remi 成员。请先用飞书登录一次网页端，或在本话题给机器人发一条消息后再试；也可以直接去网页端回答。";
  }
  if (code === "decision_member_ambiguous") {
    return "本次没有提交：飞书身份关联到多个 Remi 成员。请去网页端回答。";
  }
  if (code === "decision_operator_mismatch") {
    return "本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。";
  }
  if (status === 404 || status === 409) {
    return "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。";
  }
  return code
    ? `本次没有提交：提交失败，请稍后重试（错误码：${code}）。`
    : "本次没有提交：提交失败，请稍后重试。";
}

/**
 * Register the click handler for one Issue decision card (MUL-412).
 *
 * The callback name is derived from the Issue and the decision, so answering
 * needs only those two ids plus the recipient — which is exactly what the
 * delivery row persists, and therefore all a restarted host needs to rebuild
 * the registration.
 */
export function registerIssueDecisionCardInteraction(
  entry: IssueDecisionCardInteraction,
): { dispose: () => void } {
  const key = `${entry.appId}:${entry.messageId}`;
  pendingDecisions.set(key, entry);
  return { dispose: () => { if (pendingDecisions.get(key) === entry) pendingDecisions.delete(key); } };
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

/**
 * Handle a click on an Issue decision card (MUL-412).
 *
 * Same gate as a human-request card — the person named on the card, in the chat
 * it was sent to — and the same protocol: the canonical write happens on the
 * server before the toast acknowledges success. The only field that leaves this
 * process is the answer text; the answerer is derived server-side from the
 * callback's operator, so a forged body cannot attribute an answer to somebody
 * else.
 */
export async function handleIssueDecisionInteractionEvent(appId: string, raw: unknown): Promise<Card | null> {
  const event = object(raw), action = object(event.action), context = object(event.context);
  if (typeof action.name !== "string" || !action.name.startsWith("fd_")) return null;
  const entry = pendingDecisions.get(`${appId}:${String(context.open_message_id ?? "")}`);
  const toast = (content: string, type = "error") => ({ toast: { type, content } });
  if (!entry) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (context.open_chat_id !== entry.chatId || !entry.recipientOpenId
    || object(event.operator).open_id !== entry.recipientOpenId) {
    return toast("本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。");
  }
  let decision: MultiremiIssueDecision | null = null;
  try {
    decision = await entry.getDecision();
  } catch (error) {
    return toast(issueDecisionFailureToast(error));
  }
  if (!decision) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (decision.status !== "escalated") {
    return { ...toast("本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。", "info"),
      card: { type: "raw", data: buildIssueDecisionCard(decision,
        { agentName: entry.agentName, sessionId: entry.sessionId, receipt: true }) } };
  }
  const marker = decisionInteractionMarker(decision.issueId, decision.id);
  const form = object(action.form_value);
  // The form submits as one button whose name is the marker; individual option
  // buttons append `_o<index>`. Both carry the free-text field, so either may be
  // combined with a custom answer.
  if (action.name !== marker && !action.name.startsWith(`${marker}_o`)) return toast("操作与当前问题不匹配");
  let custom = "";
  try {
    custom = answerText(form[`${marker}_answer`]);
  } catch {
    return toast("自定义回答格式无效");
  }
  const choices = Array.isArray(decision.options) ? decision.options : [];
  const optionIndex = action.name === marker ? -1 : Number(action.name.slice(marker.length + 2));
  const option = Number.isSafeInteger(optionIndex) && optionIndex >= 0 && optionIndex < choices.length
    ? String(choices[optionIndex])
    : null;
  if (!option && !custom) return toast(choices.length ? "请选择一项，或填写自定义回答" : "请填写回答");
  const answer = option && custom ? `${option}\n自定义回答：${custom}` : option ?? custom;
  try {
    const settled = await entry.submit(answer, String(object(event.operator).open_id ?? ""));
    return { ...toast(settled.status === "answered" ? "已提交" : "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。", settled.status === "answered" ? "success" : "info"),
      card: { type: "raw", data: buildIssueDecisionCard(settled,
        { agentName: entry.agentName, sessionId: entry.sessionId, receipt: true }) } };
  } catch (error) {
    return toast(issueDecisionFailureToast(error));
  }
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
