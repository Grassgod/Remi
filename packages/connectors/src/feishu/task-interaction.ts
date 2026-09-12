import { createHash } from "node:crypto";
import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import { buildCardHeader } from "./send.js";
import type { AskUserQuestion, AskUserQuestionData } from "./permission-ui.js";
import { normalizePermissionOptions, normalizeQuestions } from "./adapters/task-stream-handler.js";

type Card = Record<string, unknown>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const escapeCardText = (v: string) => v.replace(/[&<>*_`\[\]~]/g, c => `&#${c.charCodeAt(0)};`);
export const interactionMarker = (taskId: string, requestId: string) =>
  `fr_${createHash("sha256").update(`${taskId}:${requestId}`).digest("hex").slice(0, 24)}`;

export function buildQuestionElements(marker: string, data: AskUserQuestionData): Card {
  const elements: Card[] = [];
  data.questions.forEach((q, qi) => {
    elements.push({ tag: "markdown", content: `**${data.questions.length > 1 ? `${qi + 1}. ` : ""}${escapeCardText(q.question)}**\n${q.multiSelect ? "可多选" : "请选择一项"}，也可填写本题的自定义回答。` });
    q.options.forEach((option, oi) => elements.push({
      tag: "column_set", flex_mode: "none", columns: [{
        tag: "column", width: "weighted", weight: 1, padding: "8px", background_style: "grey-50",
        elements: [{ tag: "checker", name: `q${qi}_option${oi}`, checked: false, overall_checkable: true,
          checked_style: { show_strikethrough: false, opacity: 1 },
          text: { tag: "lark_md", content: `**${escapeCardText(option.label)}**${option.description ? ` · ${escapeCardText(option.description)}` : ""}` } }],
      }],
    }));
    elements.push({ tag: "input", name: `q${qi}_custom`, input_type: "multiline_text", width: "fill",
      label: { tag: "plain_text", content: data.questions.length > 1 ? `问题 ${qi + 1} · 自定义回答` : "自定义回答" },
      placeholder: { tag: "plain_text", content: "可以补充要求，也可以只在这里回答" }, max_length: 500, rows: 3 });
  });
  elements.push({ tag: "button", name: marker, text: { tag: "plain_text", content: "提交" },
    type: "primary_filled", width: "fill", form_action_type: "submit" });
  return { tag: "form", name: `form_${marker}`, elements };
}

export function buildTaskInteractionCard(request: MultiremiTaskHumanRequest, options: {
  displayName?: string | null; recipientOpenId?: string; receipt?: boolean;
}): Card {
  const marker = interactionMarker(request.taskId, request.id);
  const elements: Card[] = [];
  const questions = normalizeQuestions(request.payload.questions);
  const tool = object(request.payload.tool_call);
  const input = object(tool.rawInput ?? tool.raw_input);
  const plan = String(input.planContent ?? input.plan ?? "");
  if (options.receipt || request.status !== "pending") {
    const status = request.status === "responded" ? "已提交" : request.status === "timeout" ? "已超时" : "已取消";
    elements.push({ tag: "markdown", content: `**${status}**` });
    if (request.kind === "question" && request.response?.answers) {
      const answers = object(request.response.answers);
      for (const q of questions?.questions ?? []) {
        elements.push({ tag: "markdown", content: `**${escapeCardText(q.question)}**\n${escapeCardText(String(answers[q.question] ?? ""))}` });
      }
    } else if (request.response?.option_id) {
      const choice = normalizePermissionOptions(request.payload.options).find(o => o.optionId === request.response!.option_id);
      elements.push({ tag: "markdown", content: escapeCardText(choice?.name || String(request.response.option_id)) });
      if (request.response.feedback) elements.push({ tag: "markdown", content: escapeCardText(String(request.response.feedback)) });
    }
    // A receipt has no mention: the original request already notified the user.
  } else {
    if (!options.recipientOpenId) {
      elements.push({ tag: "markdown", content: "未能确定处理人，请在 Remi 工作台处理此请求。" });
    } else if (request.kind === "question" && questions) {
      elements.push(buildQuestionElements(marker, questions));
    } else {
      const title = String(tool.title ?? tool.name ?? "操作审批");
      elements.push({ tag: "markdown", content: `**${escapeCardText(title)}**` });
      const detail = plan || JSON.stringify(input, null, 2);
      if (detail && detail !== "{}") elements.push({ tag: "collapsible_panel", expanded: true,
        header: { title: { tag: "plain_text", content: plan ? "计划" : "操作详情" } },
        elements: [{ tag: "markdown", content: escapeCardText(detail.slice(0, 6000)) }] });
      const choices = normalizePermissionOptions(request.payload.options);
      elements.push({ tag: "form", name: `form_${marker}`, elements: [
        { tag: "column_set", flex_mode: "none", columns: choices.map((choice, index) => ({
          tag: "column", width: "weighted", weight: 1, elements: [{ tag: "button", name: `${marker}_o${index}`,
            form_action_type: "submit", type: /reject|deny/.test(choice.kind) ? "danger" : "default", width: "fill",
            text: { tag: "plain_text", content: choice.name || choice.optionId } }],
        })) },
      ] });
    }
    if (options.recipientOpenId && /^ou_[A-Za-z0-9_-]+$/.test(options.recipientOpenId)) {
      elements.push({ tag: "markdown", content: `<at id=${options.recipientOpenId}></at>` });
    }
  }
  return { schema: "2.0", header: buildCardHeader(undefined, options.displayName),
    config: { update_multi: true, enable_forward: false, width_mode: "default",
      summary: { content: request.kind === "question" ? "Remi · 等待回答" : "Remi · 操作审批" } },
    body: { padding: "12px 16px", elements } };
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
  request: MultiremiTaskHumanRequest; displayName?: string | null;
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

/** Native-task actions are never passed to the legacy in-memory permission map. */
export async function handleTaskInteractionEvent(appId: string, raw: unknown): Promise<Card | null> {
  const event = object(raw), action = object(event.action), context = object(event.context);
  if (typeof action.name !== "string" || !action.name.startsWith("fr_")) return null;
  const entry = pending.get(`${appId}:${String(context.open_message_id ?? "")}`);
  const toast = (content: string, type = "error") => ({ toast: { type, content } });
  if (!entry) return toast("请求已处理，或正在恢复，请稍后重试", "info");
  if (context.open_chat_id !== entry.chatId || !entry.recipientOpenId
    || object(event.operator).open_id !== entry.recipientOpenId) return toast("请由卡片中指定的处理人提交");
  const marker = interactionMarker(entry.request.taskId, entry.request.id);
  try {
    let response: Record<string, unknown>;
    const form = object(action.form_value);
    if (entry.request.kind === "question") {
      if (action.name !== marker) return toast("操作与当前问题不匹配");
      const data = normalizeQuestions(entry.request.payload.questions);
      if (!data) return toast("问题格式无效，请在工作台处理");
      response = { answers: parseQuestionAnswers(data.questions, form) };
    } else {
      const options = normalizePermissionOptions(entry.request.payload.options);
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
      card: { type: "raw", data: buildTaskInteractionCard(settled, { displayName: entry.displayName, receipt: true }) } };
  } catch (error) {
    return toast(error instanceof Error && !/HTTP|fetch|token/i.test(error.message) ? error.message.slice(0, 100) : "提交未确认，请稍后重试");
  }
}
