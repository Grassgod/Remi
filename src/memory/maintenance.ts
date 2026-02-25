/**
 * Maintenance agent prompt building and response parsing.
 *
 * The maintenance agent reviews conversation transcripts and decides what
 * memory updates to make (create entities, patch project memory, etc.).
 */

import type { MemoryStore } from "./store.js";

const MAINTENANCE_PROMPT_TEMPLATE = `\
你是 Remi 的记忆维护 agent。审查以下对话（最近 10 轮 + 对话摘要），
将值得长期记忆的信息写入正确的位置。

## 写入层级判断规则

默认只写两层：
- 全局偏好、跨项目通用知识    → ~/.remi/memory/MEMORY.md
- 项目相关的一切知识          → {{project_root}}/.remi/memory.md
- 关于人、组织、具体决策的信息 → ~/.remi/memory/entities/{{type}}/{{name}}.md

例外：当前 cwd 存在独立的 .remi/memory.md（模块层已拆出），
则模块相关的实现细节、局部约定写入该模块文件，项目根只保留跨模块内容。

## 写入模式说明
- ## Procedures 章节：使用 overwrite 模式（始终是最新版本）
- 其他章节：使用 append 模式（累积历史）

## 当前记忆结构
{memory_structure}

## 对话上下文
工作目录：{cwd}
对话摘要：{summary}
最近对话：
{recent_turns}

## 请决定
对每条值得记忆的信息输出 JSON 行：
  - action: create_entity | update_entity | append_observation | patch_project_memory | append_global
  - target: 目标路径或实体名
  - section: 目标章节（patch_project_memory 时必填）
  - mode: append | overwrite（patch_project_memory 时必填）
  - content: 要写入的内容
  - source: agent-inferred

无值得记忆的内容则输出 SKIP。
`;

export interface MaintenanceAction {
  action: string;
  target: string;
  content: string;
  section: string;
  mode: string;
  source: string;
  entityType: string;
}

export function buildMaintenancePrompt(
  cwd: string | null,
  summary: string,
  recentTurns: string,
  memoryStructure: string,
): string {
  return MAINTENANCE_PROMPT_TEMPLATE.replace("{cwd}", cwd ?? "(unknown)")
    .replace("{summary}", summary || "(none)")
    .replace("{recent_turns}", recentTurns)
    .replace("{memory_structure}", memoryStructure);
}

export function parseMaintenanceResponse(responseText: string): MaintenanceAction[] {
  if (responseText.trim().toUpperCase() === "SKIP") {
    return [];
  }

  const actions: MaintenanceAction[] = [];
  for (const line of responseText.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase() === "SKIP") continue;

    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Try to extract JSON from the line
      const match = trimmed.match(/\{.*\}/);
      if (match) {
        try {
          data = JSON.parse(match[0]);
        } catch {
          console.warn("Failed to parse maintenance action:", trimmed);
          continue;
        }
      }
    }

    if (data) {
      actions.push({
        action: (data.action as string) ?? "",
        target: (data.target as string) ?? "",
        content: (data.content as string) ?? "",
        section: (data.section as string) ?? "",
        mode: (data.mode as string) ?? "append",
        source: (data.source as string) ?? "agent-inferred",
        entityType: (data.type as string) ?? "",
      });
    }
  }
  return actions;
}

export function executeMaintenanceActions(
  store: MemoryStore,
  actions: MaintenanceAction[],
): number {
  let executed = 0;
  for (const action of actions) {
    try {
      switch (action.action) {
        case "create_entity":
          store.createEntity(action.target, action.entityType, action.content, "agent-inferred");
          executed++;
          break;
        case "update_entity":
          store.updateEntity(action.target, action.content);
          executed++;
          break;
        case "append_observation":
          store.appendObservation(action.target, action.content);
          executed++;
          break;
        case "patch_project_memory":
          store.patchProjectMemory(
            action.target,
            action.section,
            action.content,
            action.mode as "append" | "overwrite",
          );
          executed++;
          break;
        case "append_global":
          store.appendMemory(action.content);
          executed++;
          break;
        default:
          console.warn(`Unknown maintenance action: ${action.action}`);
      }
    } catch (e) {
      console.error(
        `Failed to execute action ${action.action} on ${action.target}:`,
        e,
      );
    }
  }
  return executed;
}
