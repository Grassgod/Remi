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
export interface QuestionCardCredential { token: string; operatorOpenId: string }
export interface QuestionCardClient {
  getRequest(taskId: string, requestId: string): Promise<MultiremiTaskHumanRequest | null>;
  respond(taskId: string, requestId: string, response: Record<string, unknown>, credential: QuestionCardCredential): Promise<MultiremiTaskHumanRequest>;
  getDecision(issueId: string, decisionId: string): Promise<MultiremiIssueDecision | null>;
  answer(issueId: string, decisionId: string, answer: string, credential: QuestionCardCredential): Promise<MultiremiIssueDecision>;
}
const clients = new Map<string, QuestionCardClient>();
export function registerQuestionCardClient(appId: string, client: QuestionCardClient): () => void {
  clients.set(appId, client);
  return () => { if (clients.get(appId) === client) clients.delete(appId); };
}
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

export interface CardPatchMetadata {
  appId: string;
  messageId: string;
  agentName?: string | null;
  sessionId?: string | null;
}

const pendingDecisions = new Map<string, CardPatchMetadata>();

function issueDecisionFailureToast(error: unknown): string {
  const value = object(error);
  const code = typeof value.code === "string" ? value.code.trim() : "";
  const status = typeof value.status === "number" ? value.status : null;
  if (code === "recipient_mismatch") return "本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。";
  if (code === "token_invalid") return "本次没有提交：卡片已更新，请在最新卡片上回答。";
  if (code === "token_consumed") return "本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。";
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
    return code
      ? `本次没有提交：这次没能提交（错误码：${code}）。这个决定可能还没结束，请到网页端查看；如果还在等回答，请在网页端回答。`
      : "本次没有提交：这次没能提交。这个决定可能还没结束，请到网页端查看；如果还在等回答，请在网页端回答。";
  }
  return code
    ? `本次没有提交：提交失败，请稍后重试（错误码：${code}）。`
    : "本次没有提交：提交失败，请稍后重试。";
}

/** Optional receipt styling, never an authorisation or routing registry. */
export function registerIssueDecisionCardInteraction(
  entry: CardPatchMetadata,
): { dispose: () => void } {
  const key = `${entry.appId}:${entry.messageId}`;
  pendingDecisions.set(key, entry);
  return { dispose: () => { if (pendingDecisions.get(key) === entry) pendingDecisions.delete(key); } };
}

interface PendingInteraction extends CardPatchMetadata {
  settled?: MultiremiTaskHumanRequest;
  listeners?: Set<(request?: MultiremiTaskHumanRequest) => void>;
}
const pending = new Map<string, PendingInteraction>();

/** Re-registered using the persisted message ID when a delivery is reclaimed. */
export function registerTaskInteraction(entry: PendingInteraction): {
  current: () => MultiremiTaskHumanRequest | undefined;
  wait: (signal: AbortSignal) => Promise<MultiremiTaskHumanRequest | undefined>;
  dispose: () => void;
} {
  const key = `${entry.appId}:${entry.messageId}`;
  pending.set(key, entry);
  return {
    current: () => entry.settled,
    wait: signal => {
      if (entry.settled || signal.aborted) return Promise.resolve(entry.settled);
      return new Promise(resolve => {
        const listeners = entry.listeners ??= new Set();
        const finish = (request?: MultiremiTaskHumanRequest) => {
          listeners.delete(finish);
          signal.removeEventListener("abort", onAbort);
          resolve(request);
        };
        const onAbort = () => finish();
        listeners.add(finish);
        signal.addEventListener("abort", onAbort, { once: true });
        if (entry.settled) finish(entry.settled);
      });
    },
    dispose: () => {
      if (pending.get(key) === entry) pending.delete(key);
      for (const listener of entry.listeners ?? []) listener();
    },
  };
}

/** Recovered message ids provide receipt metadata only. */
export function registerDecisionCardInteraction(
  entry: CardPatchMetadata,
): { dispose: () => void } {
  const key = `${entry.appId}:${entry.messageId}`;
  pending.set(key, {
    appId: entry.appId,
    messageId: entry.messageId,
    agentName: entry.agentName ?? null,
    sessionId: entry.sessionId ?? null,
  });
  return { dispose: () => { if (pending.get(key)) pending.delete(key); } };
}

/**
 * Handle a click on an Issue decision card (MUL-412).
 *
 * The host forwards the card credential; only the server authorises and
 * consumes it. Message registrations provide receipt presentation metadata.
 */
export async function handleIssueDecisionInteractionEvent(appId: string, raw: unknown): Promise<Card | null> {
  const event = object(raw), action = object(event.action), context = object(event.context);
  if (typeof action.name !== "string" || !action.name.startsWith("fd_")) return null;
  const entry = pendingDecisions.get(`${appId}:${String(context.open_message_id ?? "")}`);
  const value = object(action.value);
  const client = clients.get(appId);
  const credential = { token: typeof value.t === "string" ? value.t : "", operatorOpenId: String(object(event.operator).open_id ?? "") };
  const toast = (content: string, type = "error") => ({ toast: { type, content } });
  if (!credential.token || typeof value.r !== "string") return toast(issueDecisionFailureToast({ code: "token_invalid" }));
  if (!client) return toast("本次没有提交：卡片正在恢复，或这个决定已经处理。请稍后重试，或到网页端查看。", "info");
  let decision: MultiremiIssueDecision | null = null;
  try {
    decision = await client.getDecision(String(value.issue_id ?? ""), value.r);
  } catch (error) {
    return toast(issueDecisionFailureToast(error));
  }
  if (!decision) return toast("本次没有提交：卡片正在恢复，或这个决定已经处理。请稍后重试，或到网页端查看。", "info");
  if (decision.id !== value.r) return toast(issueDecisionFailureToast({ code: "token_invalid" }));
  if (decision.status !== "escalated") return {
    ...toast(issueDecisionFailureToast({ code: "token_consumed" }), "info"),
    card: { type: "raw", data: buildIssueDecisionCard(decision,
      { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) },
  };
  const marker = decisionInteractionMarker(decision.issueId, decision.id);
  const form = object(action.form_value);
  // The form submits as one button whose name is the marker; individual option
  // buttons append `_o<index>`. Both carry the free-text field, so either may be
  // combined with a custom answer.
  if (action.name !== marker && !action.name.startsWith(`${marker}_o`)) {
    return toast("本次没有提交：这个按钮和卡片上当前的问题对不上，可能是旧卡片。请到网页端回答。");
  }
  let custom = "";
  try {
    custom = answerText(form[`${marker}_answer`]);
  } catch {
    return toast("本次没有提交：自定义回答的格式无法识别。请重新填写文字后再提交，或到网页端回答。");
  }
  const choices = Array.isArray(decision.options) ? decision.options : [];
  let optionIndex = action.name === marker ? -1 : Number(action.name.slice(marker.length + 2));
  try {
    const selected = choices.map((_, i) => i).filter(i => checked(form[`${marker}_o${i}`]));
    if (selected.length > 1) return toast("本次没有提交：只能选择一项。");
    if (selected.length) optionIndex = selected[0]!;
  } catch {
    return toast("本次没有提交：选项值无效，请重新选择。");
  }
  const option = Number.isSafeInteger(optionIndex) && optionIndex >= 0 && optionIndex < choices.length
    ? String(choices[optionIndex])
    : null;
  if (!option && !custom) {
    return toast(choices.length
      ? "本次没有提交：请选择一项，或填写自定义回答后再提交。"
      : "本次没有提交：请填写回答后再提交。");
  }
  const answer = option && custom ? `${option}\n自定义回答：${custom}` : option ?? custom;
  try {
    const settled = await client.answer(decision.issueId, value.r, answer, credential);
    if (settled.status === "answered") {
      return { ...toast("已提交", "success"),
        card: { type: "raw", data: buildIssueDecisionCard(settled,
          { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) } };
    }
    if (settled.status !== "escalated") {
      return { ...toast("本次没有提交：这个决定已经结束了。请到网页端查看最新结果，不需要再提交。", "info"),
        card: { type: "raw", data: buildIssueDecisionCard(settled,
          { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) } };
    }
    return toast("本次没有提交：这次没能提交。这个决定可能还没结束，请到网页端查看；如果还在等回答，请在网页端回答。");
  } catch (error) {
    if (object(error).code === "token_consumed") {
      try {
        const latest = await client.getDecision(decision.issueId, value.r);
        if (latest && latest.status !== "escalated") return {
          ...toast(issueDecisionFailureToast(error), "info"),
          card: { type: "raw", data: buildIssueDecisionCard(latest,
            { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) },
        };
      } catch { /* The rejection is still safe to acknowledge if the reread fails. */ }
    }
    return toast(issueDecisionFailureToast(error));
  }
}

/** Native-task actions are never passed to the legacy in-memory permission map. */
export async function handleTaskInteractionEvent(appId: string, raw: unknown): Promise<Card | null> {
  const event = object(raw), action = object(event.action), context = object(event.context);
  if (typeof action.name !== "string" || !action.name.startsWith("fr_")) return null;
  const entry = pending.get(`${appId}:${String(context.open_message_id ?? "")}`);
  const value = object(action.value);
  const client = clients.get(appId);
  const credential = { token: typeof value.t === "string" ? value.t : "", operatorOpenId: String(object(event.operator).open_id ?? "") };
  const toast = (content: string, type = "error") => ({ toast: { type, content } });
  if (!credential.token || typeof value.r !== "string") return toast("卡片已更新，请在最新卡片上回答");
  if (!client) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  // A decision card re-reads the request so an answer given on the web while
  // the card was on screen is reflected instead of being overwritten.
  let request: MultiremiTaskHumanRequest | null;
  try {
    request = await client.getRequest(String(value.task_id ?? ""), value.r);
  } catch {
    return toast("提交未确认，请稍后重试");
  }
  if (!request) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (request.id !== value.r) return toast("卡片已更新，请在最新卡片上回答");
  if (request.status !== "pending") return {
    ...toast("请求已结束", "info"),
    card: { type: "raw", data: buildTaskInteractionCard(request,
      { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) },
  };
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
    const submitting = client.respond(request.taskId, value.r, response, credential)
      .then(result => {
        if (entry) {
          entry.settled = result;
          for (const listener of entry.listeners ?? []) listener(result);
        }
        return result;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); });
    const settled = await Promise.race([submitting, deadline]).finally(() => clearTimeout(timer));
    // Stay inside Feishu's callback deadline. The delivery loop will patch the
    // receipt once the same in-flight server request is actually acknowledged.
    if (!settled) return toast("正在提交，请稍候", "info");
    return { ...toast(settled.status === "responded" ? "已提交" : "请求已结束", settled.status === "responded" ? "success" : "info"),
      card: { type: "raw", data: buildTaskInteractionCard(settled, { agentName: entry?.agentName, sessionId: entry?.sessionId, receipt: true }) } };
  } catch (error) {
    const code = object(error).code;
    if (code === "token_invalid") return toast("卡片已更新，请在最新卡片上回答");
    if (code === "token_consumed") return toast("请求已结束", "info");
    if (code === "recipient_mismatch") return toast("请由卡片中指定的处理人提交");
    const message = error instanceof Error ? error.message : "";
    return toast(message && !message.includes(credential.token) && !/HTTP|fetch|token/i.test(message) ? message.slice(0, 100) : "提交未确认，请稍后重试");
  }
}
