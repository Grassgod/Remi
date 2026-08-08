// Card JSON builders for the Feishu streaming session (audit S17 split).
//
// Everything here is a pure function of its arguments: no session identity, no
// HTTP, no timers. Each body was moved verbatim out of FeishuStreamingSession /
// streaming.ts; the only substitutions were `this.<field>` -> a named argument
// and `FeishuStreamingSession.MAX_VISIBLE_STEPS` -> the module constant below.
//
// streaming.ts re-exports buildFinalCard/StepInfo so its public surface is
// unchanged.
import { type ToolEntry, buildToolDiv, buildStepDiv, buildThinkingDiv } from "../tool-formatters.js";
import { buildAskQuestionForm, buildPlanReviewForm, type PermissionFormElements } from "../permission-ui.js";
import { buildCardHeader, buildContentElements } from "../send.js";

export type RetainedPermissionPanel = {
  hr: Record<string, unknown>;
  panel: Record<string, unknown>;
};

/** Step data for process panel rendering. */
export interface StepInfo {
  tool: string;
  desc: string;
  /** Thinking text offset when this step was added (for timeline interleaving). */
  thinkingOffset?: number;
  durationMs?: number;
}

// Feishu cards have a 200-element limit. Each div step = ~4 elements.
// Keep at most 40 steps as divs to stay under the limit.
export const MAX_VISIBLE_STEPS = 40;

function appendPermissionElements(
  elements: Record<string, unknown>[],
  form: PermissionFormElements,
): void {
  elements.push(form.hr);
  if (form.panel) elements.push(form.panel);
  elements.push(form.form);
}

/**
 * Build plain-text summary for Feishu card detail page.
 * Strips markdown syntax, preserves full content so the detail page isn't blank.
 */
export function buildSummary(text: string): string {
  if (!text) return "";
  return text
    .replace(/[*_~`>#\-|]/g, "")    // strip markdown formatting
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [link](url) → link
    .replace(/\n{2,}/g, "\n")       // collapse blank lines
    .trim();
}

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
  /** Display name from DB registry — takes precedence over sessionId-derived name. */
  displayName?: string | null;
  /** AskUserQuestion questions from permission_denials — rendered as form in final card. */
  askQuestions?: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
  /** ExitPlanMode from permission_denials — rendered as approve/reject buttons. */
  planReview?: { actionId: string; planContent?: string };
  /** Permission panels retained after their interactive form was submitted. */
  retainedPermissionPanels?: RetainedPermissionPanel[];
  /** Suffix appended to card header name (e.g. " · msn_xxx"). */
  nameSuffix?: string;
  /** Subtitle shown below the header title (e.g. "Claude Plan"). */
  subtitle?: string | null;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  const hasTools = opts.toolEntries && opts.toolEntries.length > 0;
  const hasSteps = opts.steps && opts.steps.length > 0;
  const hasThinking = opts.thinking || hasTools || hasSteps;

  if (hasThinking) {
    const panelElements: Record<string, unknown>[] = [];
    let stepCount = 0;

    if (hasTools) {
      const entries = opts.toolEntries!;
      stepCount = entries.length;
      const omitted = Math.max(0, entries.length - MAX_VISIBLE_STEPS);
      const visibleEntries = omitted > 0 ? entries.slice(-MAX_VISIBLE_STEPS) : entries;
      if (omitted > 0) {
        panelElements.push(buildStepDiv("_default", `+${omitted} earlier steps`));
      }
      for (const entry of visibleEntries) {
        if (entry.thinkingBefore?.trim()) panelElements.push(buildThinkingDiv(entry.thinkingBefore));
        panelElements.push(buildToolDiv(entry));
      }
      if (opts.trailingThinking?.trim()) panelElements.push(buildThinkingDiv(opts.trailingThinking));
    } else if (hasSteps) {
      const steps = opts.steps!;
      stepCount = steps.length;
      const omitted = Math.max(0, steps.length - MAX_VISIBLE_STEPS);
      const visibleSteps = omitted > 0 ? steps.slice(-MAX_VISIBLE_STEPS) : steps;
      if (omitted > 0) {
        panelElements.push(buildStepDiv("_default", `+${omitted} earlier steps`));
      }
      for (const step of visibleSteps) panelElements.push(buildStepDiv(step.tool, step.desc));
    } else if (opts.thinking) {
      panelElements.push(buildThinkingDiv(opts.thinking));
    }

    if (panelElements.length > 0) {
      const displayCount = opts.toolCount ?? (stepCount || panelElements.length);
      if (displayCount > 0 || hasTools || hasSteps) {
        elements.push({
          tag: "collapsible_panel",
          expanded: false,
          border: { color: "grey-300", corner_radius: "6px" },
          header: {
            title: {
              tag: "plain_text",
              content: `Show ${displayCount} steps`,
              text_color: "grey",
              text_size: "notation",
            },
            icon_position: "right",
          },
          elements: panelElements,
        });
      }
    }
  }

  elements.push(...buildContentElements(opts.text || ""));

  if (opts.retainedPermissionPanels?.length) {
    for (const retained of opts.retainedPermissionPanels) {
      elements.push(retained.hr);
      elements.push(retained.panel);
    }
  }

  // AskUserQuestion form — between content and stats bar
  if (opts.askQuestions) {
    appendPermissionElements(
      elements,
      buildAskQuestionForm(opts.askQuestions.actionId, { questions: opts.askQuestions.questions }),
    );
  }

  // ExitPlanMode — between content and stats bar (matches Claude Code CLI wording)
  if (opts.planReview) {
    appendPermissionElements(
      elements,
      buildPlanReviewForm(opts.planReview.actionId, opts.planReview.planContent),
    );
  }

  // Stats bar with optional @mention (always last)
  if (opts.mentionOpenId) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<at id=${opts.mentionOpenId}></at>` });
  }

  if (opts.stats) {
    if (!opts.mentionOpenId) elements.push({ tag: "hr" });
    // Parse stats string "21.3s · 5→569 · 2 tools" into column_set
    const statsParts = opts.stats.split(" · ");
    if (statsParts.length >= 1) {
      const iconMap = ["time_outlined", "translate_outlined", "setting-inter_outlined"];
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
    header: buildCardHeader(opts.sessionId, opts.displayName, opts.nameSuffix, opts.subtitle),
    config: { width_mode: "fill", summary: { content: buildSummary(opts.text) } },
    body: { elements },
  };
}

/**
 * Build the initial streaming card JSON posted by FeishuStreamingSession.start().
 * Element ids here are the contract the CardKit element updates target.
 */
export function buildStreamingCardJson(options?: {
  sessionId?: string | null;
  displayName?: string | null;
  nameSuffix?: string;
  subtitle?: string | null;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: buildCardHeader(options?.sessionId, options?.displayName, options?.nameSuffix, options?.subtitle),
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
            icon_position: "right",
          },
          element_id: "process_panel",
          elements: [],
        },
        { tag: "markdown", content: "", element_id: "content" },
        { tag: "hr", element_id: "stats_hr" },
        { tag: "markdown", content: "", element_id: "stats_text" },
      ],
    },
  };
}

/**
 * Build the full card rebuilt on every im.message.patch while in degraded mode
 * (CardKit element updates unavailable — streaming window expired or failing).
 */
export function buildDegradedCard(args: {
  status?: string;
  steps: StepInfo[];
  text?: string;
  retainedPanels: Iterable<RetainedPermissionPanel>;
  pendingPermission: PermissionFormElements | null;
  nameSuffix?: string;
  subtitle: string | null;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  if (args.status) {
    elements.push({ tag: "markdown", content: args.status });
  }

  if (args.steps.length > 0) {
    const omitted = Math.max(0, args.steps.length - MAX_VISIBLE_STEPS);
    const visible = omitted > 0 ? args.steps.slice(-MAX_VISIBLE_STEPS) : args.steps;
    const panelElements: Record<string, unknown>[] = [];
    if (omitted > 0) {
      panelElements.push(buildStepDiv("_default", `+${omitted} earlier steps`));
    }
    for (const step of visible) {
      panelElements.push(buildStepDiv(step.tool, step.desc));
    }
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      border: { color: "grey-300", corner_radius: "6px" },
      header: {
        title: { tag: "plain_text", content: `steps (${args.steps.length})`, text_color: "grey", text_size: "notation" },
        icon_position: "right",
      },
      elements: panelElements,
    });
  }

  if (args.text?.trim()) {
    elements.push(...buildContentElements(args.text));
  }

  for (const retained of args.retainedPanels) {
    elements.push(retained.hr);
    elements.push(retained.panel);
  }

  if (args.pendingPermission) {
    const pf = args.pendingPermission;
    elements.push(pf.hr);
    if (pf.panel) elements.push(pf.panel);
    elements.push(pf.form);
  }

  return {
    schema: "2.0",
    header: buildCardHeader(undefined, undefined, args.nameSuffix, args.subtitle),
    config: { width_mode: "fill" },
    body: { elements },
  };
}

/** @deprecated — card JSON for FeishuStreamingSession.sendPlanReviewCard(), which is no longer called. */
export function buildLegacyPlanReviewCard(actionId: string): Record<string, unknown> {
  return {
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
}
