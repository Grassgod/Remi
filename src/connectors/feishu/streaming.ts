/**
 * Feishu streaming card session for real-time AI response updates.
 *
 * Flow: AI starts -> create streaming card -> throttled element updates -> close card
 *
 * Key design decisions (learned from Tika bot_stream patterns):
 * - Independent throttle per element (thinking vs content don't block each other)
 * - Fire-and-forget updates (don't block the event consumption loop)
 * - Guaranteed flush before close (no lost pending updates)
 * - Safety timeout to auto-close abandoned cards (2 hours)
 * - Heartbeat: periodic status update every 10s when idle to show liveness
 * - Retry on transient 5xx API failures
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";
import { resolveApiBase } from "./client.js";
import { type ToolEntry, buildToolDiv, buildStepDiv, buildThinkingDiv, TOOL_ICONS } from "./tool-formatters.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  currentThinking: string;
  currentStatus: string;
};

export interface StreamingCloseOptions {
  finalText?: string;
  thinking?: string | null;
  /** Tool entries for building nested collapsible panels in the final card. */
  toolEntries?: ToolEntry[];
  /** Whether the session was aborted by user (/esc). */
  aborted?: boolean;
  /** Thinking text after the last tool call. */
  trailingThinking?: string | null;
  /** Number of tool calls for the process panel header. */
  toolCount?: number;
  stats?: string | null;
  /** Sender open ID — if provided, an @mention is embedded in the final card. */
  mentionOpenId?: string;
  /** Session ID for dynamic card header name (e.g. "好奇的 Remi"). */
  sessionId?: string | null;
  /** Permission denials from CLI — used to embed AskUserQuestion / ExitPlanMode forms. */
  permissionDenials?: import("../../providers/claude-cli/protocol.js").PermissionDenial[];
  /** Pre-built AskUserQuestion form data (actionId + questions). Set by index.ts after registerPendingAction. */
  askQuestions?: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
  /** Pre-built ExitPlanMode data (actionId). Set by index.ts after registerPendingAction. */
  planReview?: { actionId: string };
}

/** Step data for process panel rendering. */
export interface StepInfo {
  tool: string;
  desc: string;
  /** Thinking text offset when this step was added (for timeline interleaving). */
  thinkingOffset?: number;
  durationMs?: number;
}

// ── Token cache (shared across sessions) ────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const res = await fetch(
    `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
  );
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

import { buildCardHeader, buildContentElements } from "./send.js";

/**
 * Build the final static card JSON.
 *
 * Process panel uses two layers:
 * 1. Outer: icon step divs (grey, notation size) — quick overview
 * 2. Inner: each step is a collapsible_panel with input/output details on click
 */
export function buildFinalCard(opts: {
  text: string;
  thinking?: string | null;
  toolEntries?: ToolEntry[];
  /** Step descriptions collected during streaming (tool + desc pairs). */
  steps?: Array<{ tool: string; desc: string }>;
  trailingThinking?: string | null;
  toolCount?: number;
  stats?: string | null;
  mentionOpenId?: string;
  sessionId?: string | null;
  /** AskUserQuestion questions from permission_denials — rendered as form in final card. */
  askQuestions?: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
  /** ExitPlanMode from permission_denials — rendered as approve/reject buttons. */
  planReview?: { actionId: string };
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  const hasTools = opts.toolEntries && opts.toolEntries.length > 0;
  const hasSteps = opts.steps && opts.steps.length > 0;
  const hasThinking = opts.thinking || hasTools || hasSteps;

  // Max tool entries in final card to avoid Feishu element limits
  const MAX_FINAL_TOOL_ENTRIES = 20;

  if (hasThinking) {
    // Build step elements for the collapsed panel
    const panelElements: Record<string, unknown>[] = [];

    if (hasTools) {
      const entries = opts.toolEntries!;
      const omitted = Math.max(0, entries.length - MAX_FINAL_TOOL_ENTRIES);
      const visibleEntries = omitted > 0 ? entries.slice(-MAX_FINAL_TOOL_ENTRIES) : entries;
      if (omitted > 0) {
        panelElements.push({ tag: "markdown", content: `<font color='grey'>*+${omitted} earlier steps omitted*</font>` });
      }
      for (const entry of visibleEntries) {
        if (entry.thinkingBefore?.trim()) {
          panelElements.push(buildThinkingDiv(entry.thinkingBefore));
        }
        panelElements.push(buildToolDiv(entry));
      }
      // Trailing thinking after last tool
      if (opts.trailingThinking?.trim()) {
        panelElements.push(buildThinkingDiv(opts.trailingThinking));
      }
    } else if (hasSteps) {
      const steps = opts.steps!;
      const omitted = Math.max(0, steps.length - MAX_FINAL_TOOL_ENTRIES);
      const visibleSteps = omitted > 0 ? steps.slice(-MAX_FINAL_TOOL_ENTRIES) : steps;
      if (omitted > 0) {
        panelElements.push({ tag: "markdown", content: `<font color='grey'>*+${omitted} earlier steps omitted*</font>` });
      }
      for (const step of visibleSteps) {
        panelElements.push(buildStepDiv(step.tool, step.desc));
      }
    } else if (opts.thinking) {
      // No tools/steps — fallback to thinking div (consistent with tool steps)
      panelElements.push(buildThinkingDiv(opts.thinking));
    }

    if (panelElements.length > 0) {
      const stepCount = opts.toolCount ?? opts.steps?.length ?? panelElements.length;
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        border: { color: "grey-300", corner_radius: "6px" },
        header: {
          title: {
            tag: "plain_text",
            content: `Show ${stepCount} steps`,
            text_color: "grey",
            text_size: "notation",
          },
          icon: { tag: "standard_icon", token: "list-check_outlined", color: "grey" },
          icon_position: "right",
          icon_expanded_angle: 90,
        },
        vertical_spacing: "2px",
        elements: panelElements,
      });
    }
  }

  elements.push(...buildContentElements(opts.text || ""));

  // AskUserQuestion form — between content and stats bar
  if (opts.askQuestions) {
    const formElements: Record<string, unknown>[] = [];
    for (let i = 0; i < opts.askQuestions.questions.length; i++) {
      const q = opts.askQuestions.questions[i];
      // Full description as markdown list (no truncation)
      const optionLines = (q.options ?? []).map((opt) =>
        opt.description ? `- **${opt.label}** — ${opt.description}` : `- ${opt.label}`
      );
      formElements.push({
        tag: "markdown",
        content: `**${i + 1}. ${q.question}**\n${optionLines.join("\n")}`,
      });
      // Dropdown for quick selection (multi_select_static when multiSelect=true)
      if (q.options && q.options.length > 0) {
        formElements.push({
          tag: q.multiSelect ? "multi_select_static" : "select_static",
          name: `q${i}`,
          placeholder: { tag: "plain_text", content: q.multiSelect ? "可多选..." : "请选择..." },
          options: q.options.map((opt) => ({
            text: { tag: "plain_text", content: opt.label },
            value: opt.label,
          })),
        });
      }
      // Custom input (overrides selection)
      formElements.push({
        tag: "input",
        name: `q${i}_custom`,
        placeholder: { tag: "plain_text", content: "或自定义回答..." },
        max_length: 500,
      });
    }
    formElements.push({
      tag: "button",
      name: opts.askQuestions.actionId,
      text: { tag: "plain_text", content: "📤 提交回答" },
      type: "primary",
      form_action_type: "submit",
    });
    elements.push({ tag: "hr" });
    elements.push({
      tag: "form",
      name: `form_${opts.askQuestions.actionId}`,
      elements: formElements,
    });
  }

  // ExitPlanMode — between content and stats bar (matches Claude Code CLI wording)
  if (opts.planReview) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: "**Plan ready for review.** How would you like to proceed?",
    });
    elements.push({
      tag: "form",
      name: `form_plan_${opts.planReview.actionId}`,
      elements: [
        {
          tag: "select_static",
          name: "decision",
          placeholder: { tag: "plain_text", content: "Select action..." },
          options: [
            { text: { tag: "plain_text", content: "Yes, proceed" }, value: "approved" },
            { text: { tag: "plain_text", content: "No, stop" }, value: "rejected" },
            { text: { tag: "plain_text", content: "Give feedback" }, value: "feedback" },
          ],
        },
        {
          tag: "input",
          name: "feedback_text",
          placeholder: { tag: "plain_text", content: "Optional feedback or changes..." },
          max_length: 1000,
        },
        {
          tag: "button",
          name: opts.planReview.actionId,
          text: { tag: "plain_text", content: "Submit" },
          type: "primary",
          form_action_type: "submit",
        },
      ],
    });
  }

  // Stats bar with optional @mention (always last)
  if (opts.mentionOpenId) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<at id=${opts.mentionOpenId}></at>` });
  }

  if (opts.stats) {
    if (!opts.mentionOpenId) elements.push({ tag: "hr" });
    // Parse stats string "21.3s · 5→569 · 116K/1M · 2 tools" into column_set
    const statsParts = opts.stats.split(" · ");
    if (statsParts.length >= 1) {
      const iconMap = ["time_outlined", "translate_outlined", "insert-chart_outlined", "setting-inter_outlined"];
      elements.push({
        tag: "column_set",
        flex_mode: "flow",
        horizontal_spacing: "small",
        columns: statsParts.map((part, i) => ({
          tag: "column",
          width: "auto",
          elements: [{
            tag: "div",
            icon: { tag: "standard_icon", token: iconMap[i] ?? "setting-inter_outlined", color: "grey" },
            text: { tag: "plain_text", content: part.trim(), text_color: "grey", text_size: "notation" },
          }],
        })),
      });
    } else {
      // Fallback: single markdown line
      elements.push({ tag: "markdown", content: opts.stats });
    }
  }

  return {
    schema: "2.0",
    header: buildCardHeader(opts.sessionId),
    config: { width_mode: "fill", summary: { content: truncateSummary(opts.text) } },
    body: { elements },
  };
}

// ── Per-element throttle state ──────────────────────────────

interface ElementThrottle {
  lastSendTime: number;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export type TokenProvider = () => Promise<string>;

export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log: (msg: string) => void;
  private _tokenProvider: TokenProvider | null;

  // Independent throttle per element — thinking and content don't interfere
  private throttles = new Map<string, ElementThrottle>();
  private throttleMs = 300;

  // Safety timeout: auto-close if no updates for 10 minutes
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private static SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  // Heartbeat: periodic status update when no events arrive
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private static HEARTBEAT_INTERVAL_MS = 10_000;
  private _startTime = 0;
  private _lastStatusText = "";
  private _heartbeatRenderer: ((elapsed: number) => string) | null = null;

  // (PROCESS_BUDGET removed — steps are now individual div elements, no markdown accumulation)

  // AbortController for signalling upstream when safety timeout fires
  private _abortController: AbortController | null = null;

  // Timeline: thinking + steps interleaved
  private _steps: StepInfo[] = [];
  private _fullThinking = "";

  constructor(
    client: Client,
    creds: Credentials,
    options?: {
      log?: (msg: string) => void;
      tokenProvider?: TokenProvider;
    },
  ) {
    this.client = client;
    this.creds = creds;
    this.log = options?.log ?? ((msg) => console.log(`[streaming] ${msg}`));
    this._tokenProvider = options?.tokenProvider ?? null;
  }

  /** Get token via 1Passport provider or fall back to direct fetch. */
  private async _getToken(): Promise<string> {
    if (this._tokenProvider) return this._tokenProvider();
    return getToken(this.creds);
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: { replyToMessageId?: string; sessionId?: string | null },
  ): Promise<void> {
    if (this.state) return;

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = {
      schema: "2.0",
      header: buildCardHeader(options?.sessionId),
      config: {
        width_mode: "fill",
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: "", element_id: "status_bar" },
          {
            tag: "collapsible_panel",
            expanded: false,
            border: { color: "grey-300", corner_radius: "6px" },
            header: {
              title: {
                tag: "plain_text",
                content: "steps",
                text_color: "grey",
                text_size: "notation",
              },
              icon: { tag: "standard_icon", token: "list-check_outlined", color: "grey" },
              icon_position: "right",
              icon_expanded_angle: 90,
            },
            vertical_spacing: "2px",
            element_id: "process_panel",
            elements: [],
          },
          { tag: "markdown", content: "", element_id: "content" },
          { tag: "hr", element_id: "stats_hr" },
          { tag: "markdown", content: "", element_id: "stats_text" },
        ],
      },
    };

    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this._getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "card_json",
        data: JSON.stringify(cardJson),
      }),
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;

    const cardContent = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });

    let sendRes;
    if (options?.replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: { msg_type: "interactive", content: cardContent, reply_in_thread: true },
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      currentThinking: "",
      currentStatus: "",
    };
    this._resetSafetyTimer();
    this._startHeartbeat();
    this.log(
      `Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}` +
      (options?.replyToMessageId ? ` (thread reply to ${options.replyToMessageId})` : ` (direct message)`),
    );
  }

  // ── Element update (raw API call with retry on 5xx) ────────

  private async _updateElementRaw(
    elementId: string,
    content: string,
  ): Promise<void> {
    if (!this.state || this.closed) return;
    this.state.sequence += 1;
    const apiBase = resolveApiBase(this.creds.domain);
    const seq = this.state.sequence;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${await this._getToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content,
              sequence: seq,
              uuid: `s_${this.state.cardId}_${seq}`,
            }),
          },
        );
        if (res.ok) return;
        const body = await res.text().catch(() => "");
        if (attempt === 0 && res.status >= 500) {
          this.log(`Update ${elementId} HTTP ${res.status}, retrying...`);
          continue;
        }
        this.log(
          `Update ${elementId} HTTP ${res.status}: ${body.slice(0, 300)}`,
        );
        return;
      } catch (e) {
        if (attempt === 0) {
          this.log(`Update ${elementId} failed, retrying: ${String(e)}`);
          continue;
        }
        this.log(`Update ${elementId} failed: ${String(e)}`);
      }
    }
  }

  /**
   * Append a new element to a container (e.g. collapsible_panel) via CardKit insert element API.
   */
  private async _appendElement(
    targetElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    if (!this.state || this.closed) return;
    this.state.sequence += 1;
    const apiBase = resolveApiBase(this.creds.domain);
    const seq = this.state.sequence;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await this._getToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "append",
              target_element_id: targetElementId,
              sequence: seq,
              elements: JSON.stringify([element]),
            }),
          },
        );
        if (res.ok) return;
        const body = await res.text().catch(() => "");
        if (attempt === 0 && res.status >= 500) {
          this.log(`Append to ${targetElementId} HTTP ${res.status}, retrying...`);
          continue;
        }
        this.log(`Append to ${targetElementId} HTTP ${res.status}: ${body.slice(0, 300)}`);
        return;
      } catch (e) {
        if (attempt === 0) {
          this.log(`Append to ${targetElementId} failed, retrying: ${String(e)}`);
          continue;
        }
        this.log(`Append to ${targetElementId} failed: ${String(e)}`);
      }
    }
  }

  // ── Per-element throttle helpers ───────────────────────────

  private _getThrottle(elementId: string): ElementThrottle {
    if (!this.throttles.has(elementId)) {
      this.throttles.set(elementId, {
        lastSendTime: 0,
        pending: null,
        timer: null,
      });
    }
    return this.throttles.get(elementId)!;
  }

  /**
   * Fire-and-forget throttled update for a specific element.
   * Does NOT await the HTTP call — enqueues it and returns immediately,
   * so the event consumption loop isn't blocked.
   */
  private _throttledUpdate(
    elementId: string,
    content: string,
    stateField: "currentText" | "currentThinking" | "currentStatus",
  ): void {
    if (!this.state || this.closed) return;
    this._resetSafetyTimer();
    this._resetHeartbeat();
    // Track last status for heartbeat display context
    if (stateField === "currentStatus") {
      this._lastStatusText = content;
    }

    const throttle = this._getThrottle(elementId);
    const now = Date.now();

    if (now - throttle.lastSendTime >= this.throttleMs) {
      // Enough time passed — send immediately (fire-and-forget)
      throttle.pending = null;
      throttle.lastSendTime = now;
      this.state[stateField] = content;
      this.queue = this.queue.then(() =>
        this._updateElementRaw(elementId, content),
      );
    } else {
      // Within throttle window — store pending and schedule deferred flush
      throttle.pending = content;
      if (!throttle.timer) {
        const delay = this.throttleMs - (now - throttle.lastSendTime);
        throttle.timer = setTimeout(() => {
          throttle.timer = null;
          if (this.closed || !this.state) return;

          const text = throttle.pending;
          if (text === null) return;
          throttle.pending = null;
          throttle.lastSendTime = Date.now();
          this.state![stateField] = text;
          this.queue = this.queue.then(() =>
            this._updateElementRaw(elementId, text),
          );
        }, delay);
      }
    }
  }

  /** Register a custom renderer for heartbeat status (e.g. plan/agent mode). */
  setHeartbeatRenderer(renderer: ((elapsed: number) => string) | null): void {
    this._heartbeatRenderer = renderer;
  }

  /** Get elapsed seconds since session started. */
  getElapsed(): number {
    return Math.round((Date.now() - this._startTime) / 1000);
  }

  // ── Public update methods (fire-and-forget, don't block caller) ──

  async update(text: string): Promise<void> {
    this._throttledUpdate("content", text, "currentText");
  }

  async updateThinking(text: string): Promise<void> {
    this._fullThinking = text;
    // Thinking text is accumulated for final card only — not rendered during streaming
    // (steps are now individual div elements with icons, not interleaved in markdown)
  }

  async updateStatus(text: string): Promise<void> {
    this._throttledUpdate("status_bar", text, "currentStatus");
  }

  /**
   * Add a step to the process panel by appending a div with standard_icon.
   */
  addStep(toolName: string, desc: string): void {
    const stepIndex = this._steps.length;
    this._steps.push({ tool: toolName, desc, thinkingOffset: this._fullThinking.length });
    const iconToken = TOOL_ICONS[toolName] ?? TOOL_ICONS._default;
    const element = {
      tag: "div",
      element_id: `step_${stepIndex}`,
      icon: { tag: "standard_icon", token: iconToken, color: "grey" },
      text: { tag: "plain_text", content: desc, text_color: "grey", text_size: "notation" },
    };
    // Update process panel header with step count
    this._updateProcessHeader();
    // Append div to process panel (fire-and-forget)
    this._appendElement("process_panel", element);
  }

  /** Update the last pending step with its duration. */
  updateStepDuration(durationMs: number): void {
    const step = this._steps.findLast((s) => !s.durationMs);
    if (!step) return;
    const stepIndex = this._steps.indexOf(step);
    step.durationMs = durationMs;
    const dur = ` (${(durationMs / 1000).toFixed(1)}s)`;
    // Update the existing div's text via element update
    this._updateElementRaw(`step_${stepIndex}`, `${step.desc}${dur}`);
  }

  /** Update the process panel header title with current step count. */
  private _updateProcessHeader(): void {
    const total = this._steps.length;
    // collapsible_panel header title can't be updated via element API,
    // so we keep it as-is ("steps"). The step count is visible from the divs inside.
  }

  // _renderTimeline removed — steps now use _appendElement (div + standard_icon)

  /** Get collected steps for final card rendering. */
  getSteps(): StepInfo[] {
    return this._steps;
  }

  /** Get the card ID (for card action routing). */
  getCardId(): string | null {
    return this.state?.cardId ?? null;
  }

  // ── DEPRECATED: Interactive cards moved to buildFinalCard embedded forms ──

  /** @deprecated — kept only for backwards compat, no longer called. */
  async sendPlanReviewCard(actionId: string, chatId: string): Promise<string | null> {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "📋 执行计划审批" },
        template: "green",
      },
      elements: [
        {
          tag: "markdown",
          content: "计划已就绪，请选择操作：",
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "✅ 批准执行" },
              type: "primary",
              value: { action: actionId, decision: "approved" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "❌ 拒绝" },
              type: "danger",
              value: { action: actionId, decision: "rejected" },
            },
          ],
        },
      ],
    };

    const apiBase = resolveApiBase(this.creds.domain);
    try {
      const res = await fetch(`${apiBase}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this._getToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        }),
      });
      const body = await res.json() as Record<string, unknown>;
      if (body.code !== 0) {
        this.log(`sendPlanReviewCard failed: ${JSON.stringify(body).slice(0, 300)}`);
        return null;
      }
      const messageId = (body.data as Record<string, unknown>)?.message_id as string;
      this.log(`sendPlanReviewCard OK: messageId=${messageId}`);
      return messageId;
    } catch (e) {
      this.log(`sendPlanReviewCard error: ${String(e)}`);
      return null;
    }
  }



  // ── Flush all pending throttled updates ────────────────────

  private async _flushAll(): Promise<void> {
    for (const [elementId, throttle] of this.throttles) {
      // Cancel any scheduled timer
      if (throttle.timer) {
        clearTimeout(throttle.timer);
        throttle.timer = null;
      }
      // Send any pending content
      if (throttle.pending !== null && this.state) {
        const text = throttle.pending;
        throttle.pending = null;
        const field =
          elementId === "content" ? "currentText"
          : elementId === "status_bar" ? "currentStatus"
          : "currentThinking";
        this.state[field] = text;
        this.queue = this.queue.then(() =>
          this._updateElementRaw(elementId, text),
        );
      }
    }
    // Wait for all queued updates to complete
    await this.queue;
  }

  // ── Safety timeout ─────────────────────────────────────────

  /**
   * Get an AbortSignal that fires when the safety timeout closes the card.
   * Upstream consumers can use this to abort blocked iteration.
   */
  get abortSignal(): AbortSignal {
    if (!this._abortController) {
      this._abortController = new AbortController();
    }
    return this._abortController.signal;
  }

  /**
   * Abort the streaming session (triggered by user /esc command).
   * Signals upstream to break the stream loop, then closes the card with a notice.
   */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.log("User abort requested");
    this._abortController?.abort();
    // Update status bar to indicate interruption before closing
    try {
      await this.updateStatus("Interrupted");
    } catch { /* best-effort */ }
    await this.close({ aborted: true });
  }

  private _resetSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      if (this.state && !this.closed) {
        this.log(
          `Safety timeout: closing abandoned streaming card ${this.state.cardId}`,
        );
        // Signal upstream to abort any blocked iteration
        this._abortController?.abort();
        this.close().catch((e) =>
          this.log(`Safety close failed: ${String(e)}`),
        );
      }
    }, FeishuStreamingSession.SAFETY_TIMEOUT_MS);
  }

  private _clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._startTime = Date.now();
    this._resetHeartbeat();
  }

  private _resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, FeishuStreamingSession.HEARTBEAT_INTERVAL_MS);
  }

  private _sendHeartbeat(): void {
    if (!this.state || this.closed) return;
    const elapsed = Math.round((Date.now() - this._startTime) / 1000);
    const heartbeatText = this._heartbeatRenderer
      ? this._heartbeatRenderer(elapsed)
      : `${this._lastStatusText || "Running"} (${elapsed}s)`;
    // Bypass throttle — heartbeat is already rate-limited by its own timer
    this.queue = this.queue.then(() =>
      this._updateElementRaw("status_bar", heartbeatText),
    );
    // Schedule next heartbeat
    this.heartbeatTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, FeishuStreamingSession.HEARTBEAT_INTERVAL_MS);
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Close streaming card ───────────────────────────────────

  async close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (!this.state || this.closed) return;

    this._clearSafetyTimer();
    this._clearHeartbeat();

    // Flush all pending throttled updates first
    await this._flushAll();

    // Normalize arguments
    let finalText: string | undefined;
    let thinking: string | null | undefined;
    let toolEntries: ToolEntry[] | undefined;
    let trailingThinking: string | null | undefined;
    let toolCount: number | undefined;
    let stats: string | null | undefined;
    let mentionOpenId: string | undefined;
    let sessionId: string | null | undefined;

    if (typeof finalTextOrOptions === "string") {
      finalText = finalTextOrOptions;
    } else if (finalTextOrOptions) {
      finalText = finalTextOrOptions.finalText;
      thinking = finalTextOrOptions.thinking;
      toolEntries = finalTextOrOptions.toolEntries;
      trailingThinking = finalTextOrOptions.trailingThinking;
      toolCount = finalTextOrOptions.toolCount;
      stats = finalTextOrOptions.stats;
      mentionOpenId = finalTextOrOptions.mentionOpenId;
      sessionId = finalTextOrOptions.sessionId;
    }

    // Append abort notice to content if user interrupted
    const aborted = typeof finalTextOrOptions === "object" && finalTextOrOptions?.aborted;
    const rawText = finalText ?? this.state.currentText;
    const text = aborted ? (rawText ? rawText + "\n\n---\n⏹ *已被用户中断*" : "⏹ *已被用户中断*") : rawText;
    const thinkingText = thinking ?? this.state.currentThinking;
    const apiBase = resolveApiBase(this.creds.domain);

    // Send final element updates BEFORE setting this.closed
    // (_updateElementRaw checks this.closed and bails out if true)
    if (text && text !== this.state.currentText) {
      await this._updateElementRaw("content", text);
    }
    // process_content removed — steps are now individual div elements appended to process_panel
    if (stats) {
      await this._updateElementRaw("stats_text", stats);
    }

    // Now mark closed so no further updates slip through
    this.closed = true;

    // Close streaming mode via PATCH /settings
    this.state.sequence += 1;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${await this._getToken()}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: truncateSummary(text) },
              },
            }),
            sequence: this.state.sequence,
            uuid: `c_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log(`Close settings HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
    } catch (e) {
      this.log(`Close failed: ${String(e)}`);
    }

    // Extract interactive forms from permission_denials
    const permDenials = typeof finalTextOrOptions === "object" ? finalTextOrOptions?.permissionDenials : undefined;
    const askQuestions = typeof finalTextOrOptions === "object" ? (finalTextOrOptions as StreamingCloseOptions & { askQuestions?: Parameters<typeof buildFinalCard>[0]["askQuestions"] }).askQuestions : undefined;
    const planReview = typeof finalTextOrOptions === "object" ? (finalTextOrOptions as StreamingCloseOptions & { planReview?: Parameters<typeof buildFinalCard>[0]["planReview"] }).planReview : undefined;

    // Replace with static card — process panel collapsed with icon divs
    try {
      const finalCard = buildFinalCard({
        text,
        thinking: thinkingText,
        toolEntries,
        steps: this._steps.length > 0 ? this._steps : undefined,
        trailingThinking,
        toolCount,
        stats,
        mentionOpenId,
        sessionId,
        askQuestions,
        planReview,
      });
      await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: JSON.stringify(finalCard) },
      });
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : "";
      this.log(`Final card patch failed: ${String(e)} ${detail}`);
      // Fallback: rebuild with lightweight step divs only (no nested collapsible_panel)
      try {
        const fallbackCard = buildFinalCard({
          text,
          thinking: thinkingText,
          toolEntries: undefined, // force lightweight mode
          steps: this._steps.length > 0 ? this._steps.slice(-20) : undefined,
          trailingThinking,
          toolCount,
          stats,
          mentionOpenId,
          sessionId,
          askQuestions,
          planReview,
        });
        await this.client.im.message.patch({
          path: { message_id: this.state.messageId },
          data: { content: JSON.stringify(fallbackCard) },
        });
        this.log(`Fallback card patch succeeded`);
      } catch (e2) {
        this.log(`Fallback card patch also failed: ${String(e2)}`);
      }
    }

    this.log(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  getMessageId(): string | null {
    return this.state?.messageId ?? null;
  }
}
