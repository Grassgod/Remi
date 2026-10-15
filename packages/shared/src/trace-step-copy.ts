/**
 * Step copy for turn + items traces (PR 2): one descriptor per step row, shared by
 * the web (Chat steps, transcript, share page), Feishu and the CLI.
 *
 * `describeStep` returns a copy key, its interpolation args and a display state;
 * it never returns text, so every surface localizes the same key. `STEP_COPY_ZH`
 * is the zh-CN table (Codex wording, PLAN.md §2.3), in i18next form: `{{name}}`
 * placeholders, and plural fragments as `<key>_other`. The web's zh-Hans locale
 * must equal it (parity test in P3); other locales use the same keys.
 *
 * Group summaries (`summarizeSteps`) are fragments in a fixed category order
 * (file changes → exploration → commands → web → other → subagents) with no
 * numbers; the count only selects the plural form. Join them with
 * `Intl.ListFormat(locale, { type: "unit" })`.
 *
 * Agent-control rows (PR 5 §4.1): a tool call that messages, interrupts,
 * resumes, closes or lists subagents ({@link agentControl}) reads as what it
 * did to which agent, and a Codex `wait` is hidden ({@link isHiddenStep}).
 *
 * Pure; the web bundles this module, so it has no relative imports.
 */

import type { CommandAction, FileChange, TraceItem, TraceSubagentItem, TraceToolItem } from "@multiremi/contracts/trace";

export type StepState = "active" | "done" | "stopped" | "declined";

export const STEP_COPY_ZH = {
  // Command actions (one row per parsed action).
  read_active: "正在读取 {{file}}",
  read_done: "已读取 {{file}}",
  search_query_path_active: "正在 {{path}} 中搜索“{{query}}”",
  search_query_path_done: "已在 {{path}} 中搜索“{{query}}”",
  search_query_active: "正在搜索“{{query}}”",
  search_query_done: "已对“{{query}}”进行搜索",
  search_files_active: "正在搜索文件",
  search_files_done: "已搜索文件",
  list_files_path_active: "正在列出 {{path}} 中的文件",
  list_files_path_done: "已列出 {{path}} 中的文件",
  list_files_active: "正在列出文件",
  list_files_done: "已列出文件",
  run_active: "正在运行命令",
  run_done: "已运行 {{command}}",
  run_stopped: "已停止 {{command}}",
  run_declined: "已拒绝运行 {{command}}",
  // A command the model labelled itself (Claude's Bash description): the label
  // is the row, the command stays in the detail (PR 2 §13).
  titled_done: "{{title}}",
  titled_stopped: "已停止 {{title}}",
  titled_declined: "已拒绝运行 {{title}}",
  // File changes (one row per changed file).
  create_active: "正在创建 {{file}}",
  create_done: "已创建 {{file}}",
  create_stopped: "已停止创建 {{file}}",
  create_declined: "已拒绝 {{file}}",
  edit_active: "正在编辑 {{file}}",
  edit_done: "已编辑 {{file}}",
  edit_stopped: "已停止编辑 {{file}}",
  edit_declined: "已拒绝 {{file}}",
  delete_active: "正在删除 {{file}}",
  delete_done: "已删除 {{file}}",
  delete_stopped: "已停止删除 {{file}}",
  delete_declined: "已拒绝 {{file}}",
  // Web.
  web_search_active: "正在搜索网页",
  web_search_done: "已搜索网页",
  web_search_detail_active: "正在搜索网页：{{detail}}",
  web_search_detail_done: "已搜索网页：{{detail}}",
  web_fetch_active: "正在打开 {{url}}",
  web_fetch_done: "已打开 {{url}}",
  // Other tools.
  tool_active: "正在调用 {{tool}}",
  tool_done: "已调用 {{tool}}",
  tool_stopped: "已停止调用 {{tool}}",
  tool_declined: "已拒绝调用 {{tool}}",
  // Agent-control rows (PR 5 §4.1). `{{agent}}` is the subagent's name, or the
  // target as the call names it; `_generic` stands in for an id-like target
  // that names no subagent of the trace.
  agent_message_active: "正在发送消息给 {{agent}}",
  agent_message_done: "已发送消息给 {{agent}}",
  agent_message_generic_active: "正在发送消息给子代理",
  agent_message_generic_done: "已发送消息给子代理",
  agent_interrupt_active: "正在中断 {{agent}}",
  agent_interrupt_done: "已中断 {{agent}}",
  agent_interrupt_generic_active: "正在中断子代理",
  agent_interrupt_generic_done: "已中断子代理",
  agent_resume_active: "正在恢复 {{agent}}",
  agent_resume_done: "已恢复 {{agent}}",
  agent_resume_generic_active: "正在恢复子代理",
  agent_resume_generic_done: "已恢复子代理",
  agent_close_active: "正在关闭 {{agent}}",
  agent_close_done: "已关闭 {{agent}}",
  agent_close_generic_active: "正在关闭子代理",
  agent_close_generic_done: "已关闭子代理",
  agent_list_active: "正在列出子代理",
  agent_list_done: "已列出子代理",
  // Breaker and non-step items.
  subagent_active: "正在运行子代理：{{title}}",
  subagent_background: "后台运行中：{{title}}",
  subagent_done: "子代理已完成：{{title}}",
  subagent_stopped: "子代理已停止：{{title}}",
  reasoning_active: "正在思考",
  reasoning_done: "已思考",
  plan_active: "正在更新计划",
  plan_done: "已更新计划",
  permission_active: "正在等待批准：{{title}}",
  permission_done: "已批准：{{title}}",
  permission_stopped: "批准已取消：{{title}}",
  permission_declined: "已拒绝：{{title}}",
  question_active: "正在询问问题",
  question_done: "已询问问题",
  question_stopped: "问题未获回答",
  compaction_active: "正在压缩上下文",
  compaction_done: "已压缩上下文",
  compaction_failed: "上下文压缩失败",
  compaction_stopped: "已停止压缩上下文",
  message: "{{text}}",
  user_message: "{{text}}",
  notice: "{{title}}",
  // Group summary fragments: `_first` opens the summary, `_rest` follows it.
  summary_edit_first_other: "编辑了文件",
  summary_edit_rest_other: "编辑了多个文件",
  summary_explore_first_other: "已读取文件",
  summary_explore_rest_other: "读取文件",
  summary_command_first_other: "运行了命令",
  summary_command_rest_other: "运行了命令",
  summary_web_first_other: "已搜索网页",
  summary_web_rest_other: "已搜索网页",
  summary_tool_first_other: "调用了工具",
  summary_tool_rest_other: "调用了工具",
  // A group with a message row says so; any other agent-control group "managed" them.
  summary_agent_first_other: "给子代理发了消息",
  summary_agent_rest_other: "给子代理发了消息",
  summary_agent_control_first_other: "管理了子代理",
  summary_agent_control_rest_other: "管理了子代理",
  summary_empty: "已完成",
} as const satisfies Record<string, string>;

export type StepCopyTable = Readonly<Record<string, string>>;
type ZhKey = keyof typeof STEP_COPY_ZH;
/** Keys `describeStep` returns (summary fragments are separate). */
export type StepCopyKey = Exclude<ZhKey, `summary_${string}`>;

export interface StepDescriptor {
  key: StepCopyKey;
  args: Record<string, string>;
  state: StepState;
}

/** Status → display state. A failed command still reads "已运行"; a failed edit reads as rejected (Codex). */
function stepState(item: TraceItem): StepState {
  switch (item.status) {
    case "in_progress": return "active";
    case "declined": return "declined";
    case "stopped": return "stopped";
    case "failed": return item.type === "file_change" ? "declined" : "done";
    default: return "done";
  }
}

function hasKey(key: string): key is StepCopyKey {
  return Object.prototype.hasOwnProperty.call(STEP_COPY_ZH, key) && !key.startsWith("summary_");
}

/** `${base}_${state}`, else `${base}_done` (Codex reuses the done copy where it has no other). */
function keyFor(base: string, state: StepState): StepCopyKey {
  const exact = `${base}_${state}`;
  if (hasKey(exact)) return exact;
  const done = `${base}_done`;
  if (hasKey(done)) return done;
  return hasKey(base) ? base : "run_done";
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function isFileChange(value: CommandAction | FileChange | undefined): value is FileChange {
  return !!value && "kind" in value && "path" in value && !("type" in value);
}

// ── Agent-control rows (PR 5 §4.1) ──────────────────────────────────────────

export type AgentControlKind = "message" | "interrupt" | "resume" | "close" | "list" | "wait";

export interface AgentControl {
  kind: AgentControlKind;
  /** The agent the call names, as it names it (a name, an agent id or a thread id); null for list and wait. */
  target: string | null;
  /** The text a message or resume call sends, when it sends one. */
  message: string | null;
}

/** The subagent item a control row's target names, or null. Build one with {@link subagentResolver}. */
export type AgentResolver = (target: string) => TraceSubagentItem | null;

/** A target that is an id rather than a name: shown as "子代理" when no subagent matches it. */
const ID_LIKE_TARGET = /^[0-9a-f-]{12,}$/i;

/** A non-blank string, trimmed. */
function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A non-blank string as sent (message bodies are Markdown). */
function body(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Codex collaboration calls name their agent as `receiverThreadIds[0]`. */
function receiver(input: Record<string, unknown>): string | null {
  return Array.isArray(input.receiverThreadIds) ? nonBlank(input.receiverThreadIds[0]) : null;
}

/**
 * What a tool call does to a subagent, or null when it is an ordinary tool:
 *
 * - Claude: `SendMessage` (message `to`), `ListAgents`, and `TaskStop` only when
 *   `resolveAgent` finds the task it stops among the trace's subagents (it also
 *   stops background shells, which stay plain tool rows).
 * - Codex: `sendInput` / `sendMessage` / `followupTask` (message),
 *   `interruptAgent`, `resumeAgent`, `closeAgent`, `listAgents` and `wait`, all
 *   naming `receiverThreadIds[0]`.
 *
 * Only `tool` items qualify; a subagent item is never a control row.
 */
export function agentControl(item: TraceItem, resolveAgent?: AgentResolver): AgentControl | null {
  if (item.type !== "tool") return null;
  const input: Record<string, unknown> = item.input ?? {};
  switch (item.tool) {
    case "SendMessage":
      return { kind: "message", target: nonBlank(input.to), message: body(input.message) };
    case "TaskStop": {
      const target = nonBlank(input.task_id) ?? nonBlank(input.shell_id);
      return target && resolveAgent?.(target) ? { kind: "interrupt", target, message: null } : null;
    }
    case "ListAgents":
    case "listAgents":
      return { kind: "list", target: null, message: null };
    case "sendInput":
    case "sendMessage":
    case "followupTask":
      return { kind: "message", target: receiver(input), message: body(input.prompt) };
    case "interruptAgent":
      return { kind: "interrupt", target: receiver(input), message: null };
    case "resumeAgent":
      return { kind: "resume", target: receiver(input), message: body(input.prompt) };
    case "closeAgent":
      return { kind: "close", target: receiver(input), message: null };
    case "wait":
      return { kind: "wait", target: null, message: null };
    default:
      return null;
  }
}

/**
 * A step no surface draws: Codex's `wait` on its children. The Chat fold, the
 * subagent panel and Feishu skip it and it is not a process item; the transcript
 * dialog still lists every item.
 */
export function isHiddenStep(item: TraceItem): boolean {
  return agentControl(item)?.kind === "wait";
}

/**
 * Resolve control-row targets against a trace's subagent items (any depth): by
 * `thread_id`, then `name` (the latest agent with it), then item `id`.
 */
export function subagentResolver(items: readonly TraceItem[]): AgentResolver {
  const byThread = new Map<string, TraceSubagentItem>();
  const byName = new Map<string, TraceSubagentItem>();
  const byId = new Map<string, TraceSubagentItem>();
  for (const item of items) {
    if (item.type !== "subagent") continue;
    const thread = nonBlank(item.thread_id);
    if (thread && !byThread.has(thread)) byThread.set(thread, item);
    const name = nonBlank(item.name);
    if (name) byName.set(name, item);
    byId.set(item.id, item);
  }
  return (target) => {
    const key = target.trim();
    return byThread.get(key) ?? byName.get(key) ?? byId.get(key) ?? null;
  };
}

/**
 * The `{{agent}}` of a control row: the resolved subagent's name (else its
 * title), else the target as written, or null for an id-like or missing target
 * (the `_generic` copy).
 */
function agentLabel(target: string | null, resolveAgent?: AgentResolver): string | null {
  if (!target) return null;
  const agent = resolveAgent?.(target);
  if (agent) return nonBlank(agent.name) ?? nonBlank(agent.title);
  return ID_LIKE_TARGET.test(target) ? null : target;
}

function controlStep(item: TraceToolItem, control: AgentControl, state: StepState, resolveAgent?: AgentResolver): StepDescriptor {
  // A refused control call did nothing to the agent: it reads as the refused tool.
  if (state === "declined") return { key: "tool_declined", args: { tool: item.title ?? item.tool }, state };
  // Only active and done copy; a stopped call keeps the done copy (Codex reuses done).
  const phase = state === "active" ? "active" : "done";
  if (control.kind === "list") return { key: `agent_list_${phase}`, args: {}, state };
  const kind = control.kind as Exclude<AgentControlKind, "list" | "wait">;
  const agent = agentLabel(control.target, resolveAgent);
  return agent
    ? { key: `agent_${kind}_${phase}`, args: { agent }, state }
    : { key: `agent_${kind}_generic_${phase}`, args: {}, state };
}

/**
 * Copy for one step row. Pass the parsed action for a command row and the
 * change for a file-change row; without one, a command with a single action
 * uses it and a file change uses its first change. `resolveAgent`
 * ({@link subagentResolver}) names the agent of a control row; without it a
 * target reads as written, an id-like one as "子代理", and `TaskStop` stays a
 * plain tool row.
 */
export function describeStep(item: TraceItem, part?: CommandAction | FileChange, resolveAgent?: AgentResolver): StepDescriptor {
  const state = stepState(item);
  const done = (base: string, args: Record<string, string>): StepDescriptor => ({ key: keyFor(base, state), args, state });
  // Reads, searches and listings have only active and done copy (Codex reuses done).
  const twoState = (base: string, args: Record<string, string>): StepDescriptor =>
    ({ key: keyFor(base, state === "active" ? "active" : "done"), args, state });

  switch (item.type) {
    case "command": {
      const title = item.title?.trim();
      if (title) return done("titled", { title, command: item.command ?? item.tool });
      const action = part && !isFileChange(part) ? part : item.actions.length === 1 ? item.actions[0] : undefined;
      const command = action?.command ?? item.command ?? item.tool;
      // A declined read is still a command the user refused (Codex: declined → command branch).
      if (state === "declined" || !action || action.type === "unknown") return done("run", { command });
      if (action.type === "read") return twoState("read", { file: action.name, path: action.path, command });
      if (action.type === "list_files") {
        return action.path ? twoState("list_files_path", { path: action.path, command }) : twoState("list_files", { command });
      }
      if (action.query && action.path) return twoState("search_query_path", { query: action.query, path: action.path, command });
      if (action.query) return twoState("search_query", { query: action.query, command });
      return twoState("search_files", { command });
    }
    case "file_change": {
      const change = isFileChange(part) ? part : item.changes[0];
      const path = change?.path ?? "";
      const verb = change?.kind === "add" ? "create" : change?.kind === "delete" ? "delete" : "edit";
      return done(verb, { file: path ? fileName(path) : item.tool, path });
    }
    case "web_search": {
      if (item.action === "fetch") return twoState("web_fetch", { url: item.url ?? item.query ?? "" });
      const detail = item.query ?? item.url;
      return detail ? twoState("web_search_detail", { detail }) : twoState("web_search", {});
    }
    case "tool": {
      const control = agentControl(item, resolveAgent);
      // A hidden `wait` keeps the plain tool copy for the surfaces that list every item.
      if (control && control.kind !== "wait") return controlStep(item, control, state, resolveAgent);
      return done("tool", { tool: item.title ?? item.tool });
    }
    case "subagent": {
      const title = item.title ?? item.tool;
      // Launched in the background: running until the turn closes (spec §13).
      if (state === "active" && item.background === true) return { key: "subagent_background", args: { title }, state };
      return done("subagent", { title });
    }
    case "reasoning":
      return twoState("reasoning", {});
    case "plan":
      return twoState("plan", {});
    case "permission": {
      if (state === "active") return done("permission", { title: item.title });
      const refused = state === "declined" || (item.decision !== null && !item.decision.kind.startsWith("allow"));
      if (refused) return { key: "permission_declined", args: { title: item.title }, state: "declined" };
      if (item.outcome !== "selected") return { key: "permission_stopped", args: { title: item.title }, state: "stopped" };
      return { key: "permission_done", args: { title: item.title }, state: "done" };
    }
    case "question":
      return done("question", {});
    case "compaction":
      return item.status === "failed" ? { key: "compaction_failed", args: {}, state } : done("compaction", {});
    case "agent_message":
      return { key: "message", args: { text: item.text }, state };
    case "user_message":
      return { key: "user_message", args: { text: item.text }, state };
    case "notice":
      return { key: "notice", args: { title: item.title, description: item.description ?? "" }, state };
  }
}

// ── Group summary ───────────────────────────────────────────────────────────

export type StepCategory = "edit" | "explore" | "command" | "web" | "tool" | "agent";

/** Fixed fragment order, independent of when the steps ran. */
export const STEP_SUMMARY_ORDER: readonly StepCategory[] = ["edit", "explore", "command", "web", "tool", "agent"];

export interface StepRow {
  item: TraceItem;
  part?: CommandAction | FileChange;
}

type SummaryPosition = "first" | "rest";

export interface StepSummaryFragment {
  category: StepCategory;
  /**
   * Look up `${key}_one` / `${key}_other` with `count` (i18next `t(key, { count })`).
   * The agent fragment is `summary_agent_*` when a row of the group sent a
   * message, else `summary_agent_control_*`.
   */
  key: `summary_${StepCategory}_${SummaryPosition}` | `summary_agent_control_${SummaryPosition}`;
  /** Only selects the plural form; never shown. Files count once per path. */
  count: number;
}

/**
 * The summary category of a step row, or null for rows that never group
 * (including hidden steps). Pass the same `resolveAgent` as to `describeStep`.
 */
export function stepCategory(item: TraceItem, part?: CommandAction | FileChange, resolveAgent?: AgentResolver): StepCategory | null {
  if (item.type === "tool") {
    const control = agentControl(item, resolveAgent);
    if (control) return control.kind === "wait" ? null : "agent";
  }
  switch (item.type) {
    case "command": {
      const action = part && !isFileChange(part) ? part : item.actions.length === 1 ? item.actions[0] : undefined;
      return action && action.type !== "unknown" ? "explore" : "command";
    }
    case "file_change": return "edit";
    case "web_search": return "web";
    case "tool": return "tool";
    default: return null;
  }
}

/** Fragments for a group of step rows; empty when nothing groups (show `summary_empty`). */
export function summarizeSteps(rows: readonly StepRow[], resolveAgent?: AgentResolver): StepSummaryFragment[] {
  const counts = new Map<StepCategory, number>();
  const editedPaths = new Set<string>();
  let messaged = false;
  for (const { item, part } of rows) {
    const category = stepCategory(item, part, resolveAgent);
    if (!category) continue;
    if (category === "agent" && agentControl(item, resolveAgent)?.kind === "message") messaged = true;
    if (category === "edit") {
      const paths = isFileChange(part) ? [part.path] : item.type === "file_change" ? item.changes.map((change) => change.path) : [];
      for (const path of paths.length ? paths : [item.id]) editedPaths.add(path);
      counts.set("edit", editedPaths.size);
    } else {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const fragments: StepSummaryFragment[] = [];
  for (const category of STEP_SUMMARY_ORDER) {
    const count = counts.get(category);
    if (!count) continue;
    const position: SummaryPosition = fragments.length === 0 ? "first" : "rest";
    const key = category === "agent" && !messaged ? `summary_agent_control_${position}` as const : `summary_${category}_${position}` as const;
    fragments.push({ category, key, count });
  }
  return fragments;
}

/**
 * Render a key with a copy table (zh by default), for surfaces without i18next
 * (Feishu, CLI). With `count`, a plural key resolves to `_one` (count 1, when the
 * table has it) or `_other`. Unknown placeholders render empty.
 */
export function formatStepCopy(
  key: string,
  args: Readonly<Record<string, string>> = {},
  options: { count?: number; copy?: StepCopyTable } = {},
): string {
  const copy: StepCopyTable = options.copy ?? STEP_COPY_ZH;
  const template = copy[key]
    ?? (options.count === 1 ? copy[`${key}_one`] : undefined)
    ?? copy[`${key}_other`]
    ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => args[name] ?? "");
}
