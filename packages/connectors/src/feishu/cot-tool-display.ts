/** Native CoT tool labels, following aiden-bot's semantic display rules.
 * Tool outputs are deliberately not used here: the Task transcript owns logs. */
import { isCollabInput, isSubagentActivityInput, subagentName } from "./tool-formatters.js";
export interface CotListResult { type: "list"; items: Array<{ text: string; icon?: "task" }> }
export interface CotToolDisplay { title: string; icon: string; args?: string; result?: CotListResult; subagent?: boolean }
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

export function isCotShell(name: string): boolean { return /bash|shell|exec|command/i.test(name); }
export function isCotSubagent(name: string, input: Record<string, unknown>): boolean {
  return /^(agent|task|spawn_agent|spawnagent)$/i.test(name) || /[/:._](spawn_agent|spawnagent)$/i.test(name)
    || isSubagentActivityInput(input) || isCollabInput(input);
}

export function cotPlan(entries: unknown): { title: string; result: CotListResult } | undefined {
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

export function cotToolDisplay(name: string, input: Record<string, unknown>, metaTitle?: string): CotToolDisplay {
  const description = line(str(input.description));
  const path = str(input.file_path) || str(input.path) || str(input.filePath);
  const query = str(input.pattern) || str(input.query);
  let display: CotToolDisplay;
  if (isCotShell(name)) {
    const command = str(input.command) || str(input.cmd);
    const title = description || (command ? `执行：${line(command)}` : name);
    const icon = /\b(rg|grep|find)\b/.test(command) ? "search"
      : /\b(cat|sed|head|tail)\b/.test(command) ? "read" : "bash";
    display = { title, icon, args: command ? `$ ${command}` : undefined };
  } else if (/todo/i.test(name)) {
    display = { icon: "doc", ...(cotPlan(input.todos) ?? { title: "更新待办" }) };
  } else if (isCotSubagent(name, input)) {
    const child = subagentName(input.agentPath);
    const activity = str(input.activityKind);
    const verb = /wait/i.test(name) ? "等待子任务" : /send|followup/i.test(name) ? "继续子任务"
      : /close|interrupt/i.test(name) ? "结束子任务" : "启动子任务";
    display = { icon: "robot_outlined", title: description || (child ? `${activity || verb} · ${child}` : verb), subagent: true };
  } else if (/tool_?search/i.test(name)) {
    display = { icon: "find-app_outlined", title: query ? `加载工具：${query}` : "加载工具", args: query };
  } else if (/skill/i.test(name)) {
    const skill = str(input.skill) || str(input.name);
    display = { icon: "doc", title: skill ? `阅读 ${skill} 技能` : "阅读技能", args: skill };
  } else if (/grep|glob|search|find/i.test(name)) {
    display = { icon: "search", title: query ? `搜索 ${query}` : name, args: query };
  } else if (/web|browser/i.test(name)) {
    const url = str(input.url);
    display = { icon: "search", title: query ? `搜索 ${query}` : url ? `打开 ${url}` : name, args: query || url };
  } else if (/read|view|open|fetch/i.test(name)) {
    display = { icon: "read", title: path ? `读取 ${path}` : name, args: path };
  } else if (/edit|write|patch|replace/i.test(name)) {
    display = { icon: "write", title: path ? `编辑 ${path}` : name, args: path };
  } else {
    display = { icon: "default", title: description || str(metaTitle) || name };
  }
  if (description && !display.subagent && !/todo/i.test(name)) display.title = description;
  return { ...display, title: cotPreview(line(display.title)), args: display.args ? cotPreview(display.args) : undefined };
}
