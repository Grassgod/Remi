/**
 * Pure JSON constructors for the Feishu Task interaction card (MUL-407 / E5).
 *
 * Two very different owners build the same card: the control plane writes it
 * into an outbound delivery, and the connector may rebuild it for a receipt.
 * Keeping the constructors here means both render identically without the
 * server depending on the connector's Lark SDK surface.
 */
import { createHash } from "node:crypto";
import type { MultiremiIssueDecision, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import type { AskUserQuestionData } from "@shared/contracts/acp-protocol.js";
import { getNewbornName, getSessionName } from "@shared/session-name.js";

type Card = Record<string, unknown>;

export interface NormalizedPermissionOption {
  kind: string;
  name: string;
  optionId: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const escapeCardText = (value: string) =>
  value.replace(/[&<>*_`\[\]~]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The marker is the callback name carried by the card's submit button. Its
 * digest is unchanged from the connector-only implementation so a card already
 * on screen keeps matching its request across a platform deploy.
 */
export function interactionMarker(taskId: string, requestId: string): string {
  return `fr_${createHash("sha256").update(`${taskId}:${requestId}`).digest("hex").slice(0, 24)}`;
}

export interface CardHeaderOptions {
  /** Provider session the reply belongs to; drives the conversation label. */
  sessionId?: string | null;
  /** Pre-resolved title from the legacy session registry — used verbatim. */
  displayName?: string | null;
  /** The bot's own name, substituted into the generated session label. */
  agentName?: string | null;
  nameSuffix?: string;
  subtitle?: string | null;
}

/**
 * Build a Remi branded card header.
 * - displayName string → use as-is (from DB registry)
 * - sessionId string + no displayName → deterministic name ("好奇的 Remi·Vulpes")
 * - sessionId null → newborn name ("刚醒来的 Remi")
 * - sessionId undefined → plain agent name (non-streaming and command cards)
 */
export function buildCardHeader(options: CardHeaderOptions = {}): Record<string, unknown> {
  const { sessionId, displayName, agentName, nameSuffix, subtitle } = options;
  const agent = agentName?.trim() || "Remi";
  const baseName =
    displayName ? displayName :
    sessionId ? getSessionName(sessionId, agent) :
    sessionId === null ? getNewbornName(agent) :
    agent;
  const title = nameSuffix ? `${baseName}${nameSuffix}` : baseName;
  const now = new Date();
  const hh = String(((now.getUTCHours() + 8) % 24)).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const header: Record<string, unknown> = {
    title: { tag: "plain_text" as const, content: `${title}  ${hh}:${mm}` },
    template: "default" as const,
    icon: { tag: "standard_icon" as const, token: "robot_outlined", color: "grey" },
  };
  if (subtitle) {
    // Feishu's native subtitle is single-line and ellipsizes overflow.
    header.subtitle = { tag: "plain_text", content: subtitle.replace(/\s+/g, " ") };
  }
  return header;
}

/** Sentinel the control plane writes when only the host can resolve the @. */
export const DECISION_RECIPIENT_SENTINEL = "__remi_decision_recipient__";

/** Element the host rewrites with the resolved requester, or drops. */
export function decisionMentionElement(openId?: string | null): Record<string, unknown> {
  return {
    tag: "markdown",
    content: /^ou_[A-Za-z0-9_-]+$/.test(String(openId ?? ""))
      ? `<at id=${openId}></at>`
      : `<at id=${DECISION_RECIPIENT_SENTINEL}></at>`,
  };
}

/** Normalize the persisted question payload; null when it carries none. */
export function normalizeQuestions(value: unknown): AskUserQuestionData | null {
  if (!Array.isArray(value)) return null;
  const questions: AskUserQuestionData["questions"] = value.map((raw) => {
    const row = object(raw);
    // The daemon persists ElicitationQuestion as { fieldKey, question: AskQuestion }.
    // The old flat shape stays accepted so connector-owned callers keep working.
    const nested = object(row.question);
    const question = Object.keys(nested).length ? nested : row;
    return {
      question: String(question.question ?? "Question"),
      header: typeof question.header === "string" ? question.header : undefined,
      options: Array.isArray(question.options)
        ? question.options.map((option) => {
          const item = object(option);
          return Object.keys(item).length
            ? { label: String(item.label ?? item.value ?? "Option"),
              description: typeof item.description === "string" ? item.description : undefined }
            : { label: String(option) };
        })
        : [],
      multiSelect: question.multiSelect === true || question.multi_select === true,
    };
  });
  return questions.length ? { questions } : null;
}

export function normalizePermissionOptions(value: unknown): NormalizedPermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const row = object(raw);
    return {
      optionId: String(row.optionId ?? row.option_id ?? `option_${index}`),
      name: String(row.name ?? row.optionId ?? row.option_id ?? `Option ${index + 1}`),
      kind: String(row.kind ?? "allow_once"),
    };
  });
}

export function buildQuestionElements(marker: string, data: AskUserQuestionData, value?: Record<string, unknown>): Card {
  const elements: Card[] = [];
  data.questions.forEach((question, qi) => {
    elements.push({
      tag: "markdown",
      content: `**${data.questions.length > 1 ? `${qi + 1}. ` : ""}${escapeCardText(question.question)}**\n`
        + `${question.multiSelect ? "可多选" : "请选择一项"}，也可填写本题的自定义回答。`,
    });
    question.options.forEach((option, oi) => elements.push({
      tag: "column_set", flex_mode: "none", columns: [{
        tag: "column", width: "weighted", weight: 1, padding: "8px", background_style: "grey-50",
        elements: [{
          tag: "checker", name: `q${qi}_option${oi}`, checked: false, overall_checkable: true,
          checked_style: { show_strikethrough: false, opacity: 1 },
          text: { tag: "lark_md", content: `**${escapeCardText(option.label)}**${option.description ? ` · ${escapeCardText(option.description)}` : ""}` },
        }],
      }],
    }));
    elements.push({
      tag: "input", name: `q${qi}_custom`, input_type: "multiline_text", width: "fill",
      label: { tag: "plain_text", content: data.questions.length > 1 ? `问题 ${qi + 1} · 自定义回答` : "自定义回答" },
      placeholder: { tag: "plain_text", content: "可以补充要求，也可以只在这里回答" }, max_length: 500, rows: 3,
    });
  });
  elements.push({
    tag: "button", name: marker, text: { tag: "plain_text", content: "提交" },
    type: "primary_filled", width: "fill", form_action_type: "submit",
    ...(value ? { value } : {}),
  });
  return { tag: "form", name: `form_${marker}`, elements };
}

export interface TaskInteractionCardOptions {
  token?: string;
  agentName?: string | null;
  sessionId?: string | null;
  recipientOpenId?: string;
  /**
   * The recipient is real but only the sending host can name it (`group_owner`
   * needs the bot token to read the chat owner). The card renders exactly as a
   * resolved one and carries the sentinel mention for the host to replace.
   */
  recipientPending?: boolean;
  receipt?: boolean;
  /** Injected so the shared module stays free of clock and naming concerns. */
  header: Record<string, unknown>;
}

/**
 * Wire shape of every decision-card delivery body (MUL-407).
 *
 * The control plane writes it and the host parses it, so the two used to drift
 * the moment one side changed: a terminal patch was written as a bare card while
 * the host only understood the envelope, and the host then PATCHed an empty card
 * over the live one. Both directions now go through the helpers below, so a
 * shape change is a compile error on the writing side.
 */
export interface DecisionCardBody {
  /** Unified decision message; distinct from the Feishu transport target. Required for patches. */
  message_id?: string;
  /** The rendered card for `decision_card` and the terminal card for a patch. */
  card: Record<string, unknown>;
  /** Plain-text twin used when a card cannot be delivered at all. */
  fallback_text?: string;
}

export function questionCardAction(card: Record<string, unknown>): Record<string, unknown> | null {
  const visit = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) { const found = visit(child); if (found) return found; }
      return null;
    }
    const row = node as Record<string, unknown>;
    const value = object(row.value);
    if (row.tag === "button" && typeof value.t === "string" && typeof value.message_id === "string") return value;
    for (const child of Object.values(row)) { const found = visit(child); if (found) return found; }
    return null;
  };
  return visit(card);
}

/** Each rotated credential is a new delivery, not a replay of the old card. */
export function questionCardIdempotencyKey(card: Card, deliveryKey: string): string {
  const token = questionCardAction(card)?.t;
  return typeof token === "string"
    ? createHash("sha256").update(`${deliveryKey}:${token}`).digest("hex").slice(0, 32)
    : deliveryKey;
}

export function encodeDecisionCardBody(body: DecisionCardBody): string {
  return JSON.stringify(body);
}

/**
 * Decode a delivery body. Returns `null` for anything that is not an envelope,
 * so a caller cannot mistake "unparseable" for "a card with no elements" and
 * send an empty PATCH. Legacy plain-text bodies (a reminder, a topic seed) are
 * the caller's business, not this function's.
 */
export function decodeDecisionCardBody(raw: string): DecisionCardBody | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const card = parsed?.card;
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    if (Object.keys(card).length === 0) return null;
    return {
      card: card as Record<string, unknown>,
      ...(typeof parsed.message_id === "string" && parsed.message_id.trim() ? { message_id: parsed.message_id } : {}),
      ...(typeof parsed.fallback_text === "string" ? { fallback_text: parsed.fallback_text } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Build the interaction card body. `header` comes from the caller because the
 * session label is connector-owned; everything else is a pure JSON shape.
 */
export function buildTaskInteractionCard(
  request: MultiremiTaskHumanRequest,
  options: TaskInteractionCardOptions,
): Card {
  const marker = interactionMarker(request.taskId, request.id);
  const elements: Card[] = [];
  const questions = normalizeQuestions(request.payload.questions);
  const tool = object(request.payload.tool_call);
  const input = object(tool.rawInput ?? tool.raw_input);
  const plan = String(input.planContent ?? input.plan ?? "");
  if (options.receipt || request.status !== "pending") {
    elements.push({ tag: "markdown", content: `**${interactionStatusText(request.status)}**` });
    if (request.kind === "question" && request.response?.answers) {
      const answers = object(request.response.answers);
      for (const question of questions?.questions ?? []) {
        elements.push({
          tag: "markdown",
          content: `**${escapeCardText(question.question)}**\n${escapeCardText(String(answers[question.question] ?? ""))}`,
        });
      }
    } else if (request.response?.option_id) {
      const choice = normalizePermissionOptions(request.payload.options)
        .find((option) => option.optionId === request.response!.option_id);
      elements.push({ tag: "markdown", content: escapeCardText(choice?.name || String(request.response.option_id)) });
      if (request.response.feedback) {
        elements.push({ tag: "markdown", content: escapeCardText(String(request.response.feedback)) });
      }
    } else if (request.kind === "question" && questions) {
      // Unanswered: the card must still say what was asked, otherwise the
      // terminal state is unreadable next to a thread of many requests.
      for (const question of questions.questions) {
        elements.push({ tag: "markdown", content: `**${escapeCardText(question.question)}**` });
      }
    } else {
      const title = String(tool.title ?? tool.name ?? "操作审批");
      elements.push({ tag: "markdown", content: `**${escapeCardText(title)}**` });
    }
    const receipt = interactionReceiptLine(request);
    if (receipt) elements.push({ tag: "markdown", content: receipt });
  } else if (!options.recipientOpenId && !options.recipientPending) {
    elements.push({ tag: "markdown", content: "未能确定处理人，请在 Remi 工作台处理此请求。" });
  } else if (request.kind === "question" && questions) {
    elements.push(buildQuestionElements(marker, questions,
      options.token ? { t: options.token, message_id: request.id } : undefined));
  } else {
    const title = String(tool.title ?? tool.name ?? "操作审批");
    elements.push({ tag: "markdown", content: `**${escapeCardText(title)}**` });
    const detail = plan || JSON.stringify(input, null, 2);
    if (detail && detail !== "{}") {
      elements.push({
        tag: "collapsible_panel", expanded: true,
        header: { title: { tag: "plain_text", content: plan ? "计划" : "操作详情" } },
        elements: [{ tag: "markdown", content: escapeCardText(detail.slice(0, 6000)) }],
      });
    }
    const choices = normalizePermissionOptions(request.payload.options);
    elements.push({
      tag: "form", name: `form_${marker}`, elements: [
        {
          tag: "column_set", flex_mode: "none", columns: choices.map((choice, index) => ({
            tag: "column", width: "weighted", weight: 1, elements: [{
              tag: "button", name: `${marker}_o${index}`, form_action_type: "submit",
              ...(options.token ? { value: { t: options.token, message_id: request.id } } : {}),
              type: /reject|deny/.test(choice.kind) ? "danger" : "default", width: "fill",
              text: { tag: "plain_text", content: choice.name || choice.optionId },
            }],
          })),
        },
      ],
    });
  }
  if (!options.receipt && request.status === "pending") {
    if (/^ou_[A-Za-z0-9_-]+$/.test(String(options.recipientOpenId ?? ""))) {
      elements.push({ tag: "markdown", content: `<at id=${options.recipientOpenId}></at>` });
    } else if (options.recipientPending) {
      elements.push(decisionMentionElement(null));
    }
  }
  return {
    schema: "2.0",
    header: options.header,
    config: {
      update_multi: true, enable_forward: false, width_mode: "default",
      summary: { content: request.kind === "question" ? "Remi · 等待回答" : "Remi · 操作审批" },
    },
    body: { padding: "12px 16px", elements },
  };
}

export function interactionStatusText(status: MultiremiTaskHumanRequest["status"]): string {
  if (status === "responded") return "已提交";
  if (status === "timeout") return "已超时，未回答";
  return "已取消";
}

/**
 * Who answered (or why nobody did) plus the timestamp, so a card answered in
 * the web workbench reads the same as one answered in the topic. The timeout
 * wording restates assumption A2: an expired request is never an approval.
 */
export function interactionReceiptLine(request: MultiremiTaskHumanRequest): string | null {
  const at = request.respondedAt ? formatCardTimestamp(request.respondedAt) : null;
  if (request.status === "responded") {
    const who = escapeCardText(String(request.respondedBy ?? "未知"));
    return at ? `答者：${who} · ${at}` : `答者：${who}`;
  }
  if (request.status === "timeout") {
    return at
      ? `超时视为未回答（${at}），授权类请求不会被自动批准。`
      : "超时视为未回答，授权类请求不会被自动批准。";
  }
  return at ? `任务已取消，未回答（${at}）。` : "任务已取消，未回答。";
}

/** Absolute time keeps the receipt readable long after the card was sent. */
function formatCardTimestamp(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/**
 * The callback name a decision card's submit button carries (MUL-412).
 *
 * A decision has no Task to key on: the row hangs on the parent Issue and the
 * person who answers may be on a machine that never ran the asking Task, so the
 * marker is derived from the Issue and the decision. Deriving it instead of
 * persisting one is what lets a host that restarted re-register the same card
 * from the delivery row.
 */
export function decisionInteractionMarker(issueId: string, decisionId: string): string {
  return `fd_${createHash("sha256").update(`${issueId}:${decisionId}`).digest("hex").slice(0, 24)}`;
}

/** Option ids are positional and stable across a re-render of the same row. */
export function decisionOptionValue(index: number): string {
  return `option_${index + 1}`;
}

export interface IssueDecisionCardOptions {
  token?: string;
  header: Record<string, unknown>;
  recipientOpenId?: string;
  /** Only the sending host can resolve the recipient; see TaskInteractionCardOptions. */
  recipientPending?: boolean;
  /** Render the terminal state instead of the form. */
  receipt?: boolean;
}

/**
 * The rendered answer text of a decision, or the state it ended in.
 * `withdrawn` is a terminal state of its own: E4 has no expiry, so the only
 * ways a card closes are "answered" and "the asker took it back".
 */
export function issueDecisionStatusText(decision: Pick<MultiremiIssueDecision, "status">): string {
  if (decision.status === "answered") return "已回答";
  if (decision.status === "withdrawn") return "已撤回";
  return "等待回答";
}

/** Who answered and when, so web and Feishu answers read identically. */
export function issueDecisionReceiptLine(
  decision: Pick<MultiremiIssueDecision, "status" | "answer" | "updatedAt">,
): string | null {
  if (decision.status === "withdrawn") {
    const at = formatCardTimestamp(decision.updatedAt);
    return at ? `已被撤回（${at}）。` : "已被撤回。";
  }
  if (decision.status !== "answered") return null;
  const answer = decision.answer;
  if (!answer) return null;
  const at = formatCardTimestamp(answer.answeredAt);
  const who = escapeCardText(answer.answererId);
  return at ? `答者：${who} · ${at}` : `答者：${who}`;
}

/**
 * Build the Issue decision card (MUL-412 / MUL-400 E5).
 *
 * Pure JSON so the control plane and the connector render the same thing; the
 * header stays caller-supplied because the conversation label is
 * connector-owned. The form posts one option or free text — the same two
 * shapes the HTTP answer endpoint accepts.
 */
export function buildIssueDecisionCard(
  decision: MultiremiIssueDecision,
  options: IssueDecisionCardOptions,
): Card {
  const marker = decisionInteractionMarker(decision.issueId, decision.id);
  const elements: Card[] = [];
  const terminal = options.receipt || decision.status === "answered" || decision.status === "withdrawn";
  elements.push({ tag: "markdown", content: `**${escapeCardText(decision.title)}**` });
  const body = decision.body.trim();
  if (body) elements.push({ tag: "markdown", content: escapeCardText(body.slice(0, 6000)) });
  if (terminal) {
    elements.push({ tag: "markdown", content: `**${issueDecisionStatusText(decision)}**` });
    const receipt = issueDecisionReceiptLine(decision);
    if (receipt) elements.push({ tag: "markdown", content: receipt });
    if (decision.status === "answered" && decision.answer) {
      elements.push({ tag: "markdown", content: escapeCardText(decision.answer.answer) });
      const reason = decision.answer.reason.trim();
      if (reason) elements.push({ tag: "markdown", content: `理由：${escapeCardText(reason)}` });
      const overturn = decision.answer.overturn?.trim();
      if (overturn) elements.push({ tag: "markdown", content: `如何推翻：${escapeCardText(overturn)}` });
    }
  } else if (!options.recipientOpenId && !options.recipientPending) {
    elements.push({ tag: "markdown", content: "未能确定处理人，请在 Remi 工作台处理此决策。" });
  } else {
    const choices = Array.isArray(decision.options) ? decision.options : [];
    const lines: string[] = ["请在下面选择一项，或直接写下你的决定。"];
    const form: Card[] = [{
      tag: "markdown",
      content: choices.length
        ? lines.concat(choices.map((choice, index) => `${index + 1}. ${escapeCardText(String(choice))}`)).join("\n")
        : lines[0]!,
    }];
    choices.forEach((choice, index) => form.push({
      tag: "column_set", flex_mode: "none", columns: [{
        tag: "column", width: "weighted", weight: 1, padding: "8px", background_style: "grey-50",
        elements: [{
          tag: "checker", name: `${marker}_o${index}`, checked: false, overall_checkable: true,
          checked_style: { show_strikethrough: false, opacity: 1 },
          text: { tag: "lark_md", content: `**${escapeCardText(String(choice))}**` },
        }],
      }],
    }));
    form.push({
      tag: "input", name: `${marker}_answer`, input_type: "multiline_text", width: "fill",
      label: { tag: "plain_text", content: "自定义回答" },
      placeholder: { tag: "plain_text", content: "可以补充要求，也可以只在这里回答" },
      max_length: 1000, rows: 3,
    });
    form.push({
      tag: "button", name: marker, text: { tag: "plain_text", content: "提交" },
      type: "primary_filled", width: "fill", form_action_type: "submit",
      ...(options.token ? { value: { t: options.token, message_id: decision.id } } : {}),
    });
    elements.push({ tag: "form", name: `form_${marker}`, elements: form });
  }
  if (!terminal) {
    if (/^ou_[A-Za-z0-9_-]+$/.test(String(options.recipientOpenId ?? ""))) {
      elements.push({ tag: "markdown", content: `<at id=${options.recipientOpenId}></at>` });
    } else if (options.recipientPending) {
      elements.push(decisionMentionElement(null));
    }
  }
  return {
    schema: "2.0",
    header: options.header,
    config: {
      update_multi: true, enable_forward: false, width_mode: "default",
      summary: { content: decision.status === "answered" || decision.status === "withdrawn"
        ? "Remi · 待你决定"
        : "Remi · 等你决定" },
    },
    body: { padding: "12px 16px", elements },
  };
}
