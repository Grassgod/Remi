---
title: 迁移本地 Remi Memory
status: active
summary: 仅适用于仍持有本地 Markdown 记忆的升级安装，逐篇审阅后导入当前 Project Memory。
---

# 迁移本地 Remi Memory

仅当已有安装仍保存 `~/.remi/memory/` 的 Markdown 时使用本页。当前运行时通过[Project Memory](../project-wiki-memory-spec.md)读取知识，不自动载入该目录；新安装无需执行此迁移。

这是手动导入，不是启动迁移。先保留源目录备份，再逐篇审阅归属与有效性：

| 原内容 | 当前目标 |
|---|---|
| Persona、持久操作规则、工具约定 | 所选 agent 的 instructions，遵循[Agent 配置规范](../agent-config-spec.md)。 |
| 项目事实、决策、运行说明与归属 | 对应项目的 Memory 或整理后的 Wiki。 |
| 日志及已经失效的观察 | 不直接导入；只提取仍然成立且有来源的知识。 |

先用文件浏览器或只读列举命令清点 Markdown，然后使用当前 [CLI](../../apps/remi/cli/commands/knowledge.ts)查询已有条目，避免重复：

```bash
remi memory search "<distinct phrase>" --project <project>
remi memory create --project <project> --title "<title>" --slug <slug> --content-file <path>
remi memory get <slug> --project <project>
remi memory search "<distinct phrase>" --project <project>
```

已有同主题条目时使用 `remi memory update` 并保留来源。用具备目标工作区权限的成员身份进行手工导入；普通 task agent 的写入会成为 202 submission，需要经过发布后才能验证正式知识。确认内容、归属和检索结果前不要删除源文件。本步骤不迁移旧向量索引，也不对个人本地文件执行自动清理。
