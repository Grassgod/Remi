/** Native CoT rows for turn + items traces. Titles use the shared Codex-style
 * step copy (`@shared/trace-step-copy`, zh), so Feishu reads like Chat; icons
 * keep aiden-bot's semantic categories. Tool outputs are deliberately not used
 * here: the Task transcript in the workbench owns logs. */
import type {
  CommandAction,
  FileChange,
  TraceCommandItem,
  TraceCompactionItem,
  TraceFileChangeItem,
  TracePlanItem,
  TraceSubagentItem,
  TraceToolItem,
  TraceWebSearchItem,
} from "@multiremi/contracts/trace.js";
import { describeStep, formatStepCopy } from "@shared/trace-step-copy.js";

export interface CotListResult { type: "list"; items: Array<{ text: string; icon?: "task" }> }

/** The tool items a native row is written for (`subagent` is a step instead). */
export type CotToolItem = TraceCommandItem | TraceFileChangeItem | TraceWebSearchItem | TraceToolItem;

/** One native tool invocation: a command action, a changed file, a search or a tool call. */
export interface CotStepRow {
  /** Stable across replays: the item ID plus the action/change index. */
  key: string;
  title: string;
  icon: string;
  args?: string;
  /** A short status the title cannot carry (a failed command still reads "已运行"). */
  note?: string;
}

const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const line = (v: string) => v.replace(/\s+/g, " ").trim();

/** Leave room for both layers of JSON encoding in TOOL_CALL_RESULT. */
export function cotPreview(text: string, budget = 2400): string {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(JSON.stringify(JSON.stringify(result + char))) > budget) return `${result}…`;
    result += char;
  }
  return result;
}

export function cotPlan(entries: TracePlanItem["entries"] | unknown): { title: string; result: CotListResult } | undefined {
  if (!Array.isArray(entries) || !entries.length) return undefined;
  const rows = entries.filter((e): e is Record<string, unknown> => !!e && typeof e === "object"
    && typeof (e as Record<string, unknown>).content === "string" && !!str((e as Record<string, unknown>).content));
  if (!rows.length) return undefined;
  const done = rows.filter(e => e.status === "completed").length;
  const statuses: Record<string, string> = { completed: "已完成", in_progress: "进行中", pending: "待开始" };
  const result: CotListResult = { type: "list", items: [] };
  for (const row of rows) {
    // Feishu's task icon is a checked box, not a status-aware task glyph.
    // Only completed entries may use it; other states use their text label.
    const item = { ...(row.status === "completed" ? { icon: "task" as const } : {}),
      text: cotPreview(`${statuses[String(row.status)] ?? "待开始"} · ${line(String(row.content))}`, 600) };
    // Budget the whole typed result, including both layers of JSON encoding.
    // Reserve room for the overflow notice and the outer native event fields.
    if (Buffer.byteLength(JSON.stringify(JSON.stringify({ ...result, items: [...result.items, item] }))) > 2800) break;
    result.items.push(item);
  }
  const remaining = rows.length - result.items.length;
  if (remaining) result.items.push({ text: `另有 ${remaining} 项待办，完整计划见工作台` });
  return { title: `更新待办 (${done}/${rows.length})`, result };
}

function toolIcon(name: string): string {
  if (/tool_?search/i.test(name)) return "find-app_outlined";
  if (/skill|todo/i.test(name)) return "doc";
  if (/grep|glob|search|find|web|browser/i.test(name)) return "search";
  if (/read|view|open|fetch/i.test(name)) return "read";
  if (/edit|write|patch|replace/i.test(name)) return "write";
  return "default";
}

function commandAction(item: TraceCommandItem, part: CommandAction | undefined): CommandAction | undefined {
  return part ?? (item.actions.length === 1 ? item.actions[0] : undefined);
}

function icon(item: CotToolItem, part: CommandAction | FileChange | undefined): string {
  switch (item.type) {
    case "command": {
      const action = commandAction(item, part as CommandAction | undefined);
      if (!action || action.type === "unknown") return "bash";
      return action.type === "read" ? "read" : "search";
    }
    case "file_change": return "write";
    case "web_search": return "search";
    case "tool": return toolIcon(item.tool);
  }
}

function args(item: CotToolItem, part: CommandAction | FileChange | undefined): string | undefined {
  switch (item.type) {
    case "command": {
      const action = commandAction(item, part as CommandAction | undefined);
      const command = action ? action.command : item.command;
      if (command) return `$ ${command}`;
      if (action?.type === "read") return action.path;
      if (action?.type === "list_files") return action.path ?? undefined;
      if (action?.type === "search") return [action.query, action.path].filter(Boolean).join(" · ") || undefined;
      return undefined;
    }
    case "file_change": {
      const change = part as FileChange | undefined;
      return change ? change.move_path ? `${change.path} → ${change.move_path}` : change.path : undefined;
    }
    case "web_search": return item.query ?? item.url ?? undefined;
    case "tool": {
      const input = item.input ?? {};
      if (/tool_?search/i.test(item.tool)) return str(input.query) || undefined;
      if (/skill/i.test(item.tool)) return str(input.skill) || str(input.name) || undefined;
      return undefined;
    }
  }
}

/**
 * The note a row needs when its copy cannot express the item's status: a failed
 * command reads "已运行 …" and a stopped read "已读取 …" (Codex keeps their done
 * copy), so the result says what happened. Copy that already reads stopped or
 * declined needs none.
 */
function statusNote(item: CotToolItem, key: string): string | undefined {
  switch (item.status) {
    case "failed": return key.endsWith("_declined") ? undefined : "执行失败";
    case "stopped": return key.endsWith("_stopped") ? undefined : "已停止";
    case "declined": return key.endsWith("_declined") ? undefined : "已拒绝";
    default: return undefined;
  }
}

/**
 * Native rows for a finished tool item: one per command action, one per changed
 * file, else one. A command the model labelled (Claude's Bash description,
 * `command.title`) is one row under that label, as in Chat; its command stays
 * in the row's args.
 */
export function cotStepRows(item: CotToolItem): CotStepRow[] {
  const titled = item.type === "command" && !!item.title?.trim();
  const parts: Array<CommandAction | FileChange | undefined> = titled ? [undefined]
    : item.type === "command" && item.actions.length > 1
    ? item.actions
    : item.type === "file_change" && item.changes.length > 1 ? item.changes
      : [item.type === "command" ? item.actions[0] : item.type === "file_change" ? item.changes[0] : undefined];
  let key = "";
  const rows = parts.map((part, index): CotStepRow => {
    const step = describeStep(item, part);
    key = step.key;
    const title = cotPreview(line(formatStepCopy(step.key, step.args))) || item.tool;
    const detail = args(item, part);
    return { key: `${item.id}:${index}`, title, icon: icon(item, part), ...(detail ? { args: cotPreview(detail) } : {}) };
  });
  const note = statusNote(item, key);
  if (note) rows[rows.length - 1]!.note = note;
  return rows;
}

/** Claude's first Agent frame is titled with the tool name alone; the real description follows. */
function placeholderTitle(item: TraceSubagentItem): boolean {
  const title = item.title?.trim();
  return !title || title === item.tool || /^(task|agent)$/i.test(title);
}

/** Whether the subagent carries a real description or prompt yet. */
export function cotSubagentReady(item: TraceSubagentItem): boolean {
  return !placeholderTitle(item) || !!item.prompt?.trim();
}

/** The subagent's own label: its real title, else the start of its prompt, else the tool. */
export function cotSubagentTitle(item: TraceSubagentItem): string {
  const label = !placeholderTitle(item) ? item.title! : item.prompt?.trim() || item.title || item.tool || "";
  return cotPreview(line(label), 600) || "子任务";
}

/** Step name for a subagent: Codex copy while it runs and once it ends. */
export function cotSubagentStep(item: TraceSubagentItem): string {
  const title = cotSubagentTitle(item);
  if (item.status === "failed") return `子代理执行失败：${title}`;
  if (item.status === "declined") return `已拒绝子代理：${title}`;
  return formatStepCopy(describeStep(item).key, { title });
}

export function cotCompactionStep(item: TraceCompactionItem): string {
  return formatStepCopy(describeStep(item).key);
}
