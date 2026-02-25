/**
 * Memory tools v2 — recall + remember.
 *
 * Two tools exposed to the AI agent for memory access:
 * - recall: search all memory sources (entities, daily logs, project memory)
 * - remember: immediately save an observation about an entity
 */

import type { MemoryStore } from "../memory/store.js";

export function getMemoryTools(
  store: MemoryStore,
): Record<string, (...args: unknown[]) => string> {
  function recall(
    query: string,
    type?: string | null,
    tags?: string[] | null,
    cwd?: string | null,
  ): string {
    const result = store.recall(query, { type, tags, cwd });
    return result || "(无匹配结果)";
  }
  // Attach description for tool registration
  (recall as { __doc__?: string }).__doc__ =
    "搜索记忆。可搜索联系人、项目记忆、历史日志等所有记忆源。" +
    "精确匹配实体名或别名返回全文，模糊匹配返回摘要列表。";

  function remember(
    entity: string,
    type: string,
    observation: string,
    scope: string = "personal",
    cwd?: string | null,
  ): string {
    return store.remember(
      entity,
      type,
      observation,
      scope as "personal" | "project",
      cwd,
    );
  }
  (remember as { __doc__?: string }).__doc__ =
    "即时记住重要信息。当用户告知生日、偏好、决策等值得长期保存的内容时调用。" +
    "实体不存在则自动创建，已存在则追加为新观察。";

  return {
    recall: recall as (...args: unknown[]) => string,
    remember: remember as (...args: unknown[]) => string,
  };
}
