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
 * (file changes → exploration → commands → web → other) with no numbers; the
 * count only selects the plural form. Join them with
 * `Intl.ListFormat(locale, { type: "unit" })`.
 *
 * Pure; the web bundles this module, so it has no relative imports.
 */

import type { CommandAction, FileChange, TraceItem } from "@multiremi/contracts/trace";

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

/**
 * Copy for one step row. Pass the parsed action for a command row and the
 * change for a file-change row; without one, a command with a single action
 * uses it and a file change uses its first change.
 */
export function describeStep(item: TraceItem, part?: CommandAction | FileChange): StepDescriptor {
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
    case "tool":
      return done("tool", { tool: item.title ?? item.tool });
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

export type StepCategory = "edit" | "explore" | "command" | "web" | "tool";

/** Fixed fragment order, independent of when the steps ran. */
export const STEP_SUMMARY_ORDER: readonly StepCategory[] = ["edit", "explore", "command", "web", "tool"];

export interface StepRow {
  item: TraceItem;
  part?: CommandAction | FileChange;
}

export interface StepSummaryFragment {
  category: StepCategory;
  /** Look up `${key}_one` / `${key}_other` with `count` (i18next `t(key, { count })`). */
  key: `summary_${StepCategory}_${"first" | "rest"}`;
  /** Only selects the plural form; never shown. Files count once per path. */
  count: number;
}

/** The summary category of a step row, or null for rows that never group. */
export function stepCategory(item: TraceItem, part?: CommandAction | FileChange): StepCategory | null {
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
export function summarizeSteps(rows: readonly StepRow[]): StepSummaryFragment[] {
  const counts = new Map<StepCategory, number>();
  const editedPaths = new Set<string>();
  for (const { item, part } of rows) {
    const category = stepCategory(item, part);
    if (!category) continue;
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
    fragments.push({ category, key: `summary_${category}_${fragments.length === 0 ? "first" : "rest"}`, count });
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
