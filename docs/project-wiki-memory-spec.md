---
title: Project Memory 与 Wiki
status: active
summary: 当前知识存储、按需读取、任务 Wiki 工作副本、发布权限和 OpenViking 切换的实现入口。
---

# Project Memory 与 Wiki

本页描述当前实现。模块总览见[架构](ARCHITECTURE.md)；字段、参数和权限以链接的源码及测试为准。

## 内容与读写边界

| 对象 | 当前用途与实现 |
|---|---|
| Project Memory | 项目范围的可复用知识，`kind=memory`，创建要求非空 title 和 body，默认 pinned。与 Wiki 共用文档元数据和 revision。见[知识服务](../packages/server/src/project-knowledge/service.ts)、[项目仓储](../packages/server/src/store/repos/projects-repo.ts)。 |
| Project Wiki | 项目内的 Markdown 页面，包含 slug、path、来源 refs 和版本，保存项目层面及跨仓库的整理结果。 |
| Repository Wiki | 按仓库共享代码知识，同一个仓库被多个项目引用时复用。见[仓库 Wiki 仓储](../packages/server/src/store/repos/repository-wiki-repo.ts)、[任务仓库范围](../packages/server/src/repository-wiki/task-scope.ts)。 |
| Submission / compilation run | 原始提交和知识加工记录，与正式文档分开存储，记录来源、状态、输出版本及哈希。见[知识仓储](../packages/server/src/store/repos/knowledge-repo.ts)、[发布路由](../packages/server/src/api/routers/knowledge.ts)。 |

项目文档普通读写端点在[projects.ts](../packages/server/src/api/routers/projects.ts)：`/api/projects/:id/docs`、单篇读取/版本/反链及 `/knowledge/recall`；工作区检索使用 `/api/project-docs`。服务层选择正文和搜索后端，调用方不能直接把 SQL body 当作当前正文。

[写入身份判断](../packages/server/src/api/helpers/knowledge.ts)区分工作区成员、普通 task agent 和具有发布能力的 agent。普通 agent 的 create/update/delete 返回 **202 和 submission**，不表示正式知识已改变。正式写入关联 compilation run；批量发布要求发布能力及任务作用域匹配。

发布权来自[平台能力配置](../packages/server/src/knowledge/capability.ts)：角色至少为 maintainer，且绑定并启用了允许的 `code-to-wiki` 插件。显示名称不授予权限；代码中的 Atlas 发布流程也受此检查。任务 token 绑定的 issue/project/repository 范围必须匹配目标。

## Agent 实际读取流程

[任务提示词](../packages/daemon/src/agent-runtime/prompts/ephemeral.ts)的 `appendProjectKnowledgeSections` 给出按需读取入口：

1. Memory 不直接嵌入提示词。先 `remi memory search "<query>"`，再 `remi memory get <slug-or-id>` 读取有关条目。当前协议要求使用 CLI，不使用 Memory MCP。
2. Wiki 由[工作区物化器](../packages/daemon/src/agent-runtime/workspace/wiki.ts)放入 `./wiki`；仓库知识位于 `./wiki/repositories/<repository>/`。`.multiremi/wiki-base` 是只读三方合并基线。
3. 编辑后用 `remi wiki status`、`remi wiki diff` 检查，再 `remi wiki push`；冲突在工作副本解决后重试。普通 agent 的提交仍经过正式发布边界。

提示词要求非空 Wiki 维护根 `index.md` 阅读地图和追加式 `log.md`。这是内容维护约定，不能据此声称所有内容规则已有服务端校验。链接解析及发布检查见[共享解析器](../packages/contracts/src/wiki-links.ts)、[仓库发布链接检查](../packages/server/src/repository-wiki/links.ts)及[发布路由](../packages/server/src/api/routers/knowledge.ts)。移动或归并页面时需要同步修正入链。

## CLI 与验证入口

完整命令、参数、鉴权声明来自[CommandRegistry 的知识模块](../apps/remi/cli/commands/knowledge.ts)。常用 canonical 命令：

```bash
remi memory search "<query>" --project <project>
remi memory get <slug-or-id> --project <project>
remi memory create --project <project> --title "<title>" --content-file <file> --ref issue:<id>
remi memory update <slug-or-id> --project <project> --content-file <file> --expected-version <n>
remi wiki list --project <project>
remi wiki get <slug-or-id> --project <project>
remi wiki revisions <slug-or-id> --project <project>
remi wiki backlinks <slug-or-id> --project <project>
remi knowledge submit --help
remi wiki publish --help
```

任务环境可提供默认项目；工作区 list/search 可不传项目，单篇操作需要已解析的项目范围。`--expected-version` 检测并发修改，不能在冲突后盲目覆盖。写入前先检索、修订已有条目并保留来源；不把一次性任务细节堆入长期知识。

按变更选择相关测试；这些是验证入口，不表示本次已执行：

```bash
bun test tests/unit/multiremi/multiremi-project-docs.test.ts tests/unit/multiremi/multiremi-project-docs-api.test.ts
bun test tests/unit/multiremi/multiremi-project-docs-cli.test.ts tests/unit/multiremi/multiremi-project-docs-prompt.test.ts
bun test tests/unit/multiremi/multiremi-knowledge.test.ts tests/unit/multiremi/multiremi-knowledge-cli.test.ts
bun test tests/unit/multiremi/project-knowledge-openviking.test.ts
bun test tests/unit/daemon/wiki-workspace.test.ts tests/unit/multiremi/multiremi-wiki-working-copy.test.ts tests/unit/multiremi/repository-wiki-links.test.ts
```

## 存储模式与 OpenViking 切换

仅在配置或升级知识存储时阅读本节。当前[服务构造器](../packages/server/src/project-knowledge/service.ts)支持三种模式，默认 `sql`；仓库内容不能证明某个部署当前用了哪种模式。

| `MULTIREMI_PROJECT_KNOWLEDGE_MODE` | 正文读写与搜索 |
|---|---|
| `sql` | SQL 读写、SQL 搜索，无需 OpenViking。 |
| `shadow` | SQL 仍是读取和写入来源，写入后镜像至 OpenViking；镜像失败记录 `failed`，不会回滚已完成的 SQL 写入。 |
| `openviking` | SQL 保留归属、ID、URI、哈希、版本和同步状态；正文及语义召回来自 OpenViking。新正文不写回 SQL，也不在依赖故障时切回 SQL 写入。 |

非 SQL 模式需要服务端 API key：`MULTIREMI_OPENVIKING_API_KEY`（也接受 `OPENVIKING_API_KEY`）。URL 默认 `http://127.0.0.1:1933`，超时默认 30000 ms，最多重试默认 2，分别由 `MULTIREMI_OPENVIKING_URL`、`MULTIREMI_OPENVIKING_TIMEOUT_MS`、`MULTIREMI_OPENVIKING_MAX_RETRIES` 控制。[客户端](../packages/server/src/project-knowledge/openviking-client.ts)只运行在服务端；[URI](../packages/server/src/project-knowledge/codec.ts)由 workspace/project 生成，客户端不直接持有依赖凭据。

读取失败行为依入口而异：单篇和严格列表返回错误；`searchProjectDocs` 及工作区正文列表以最多 16 个并发读取正文，记录并跳过单篇失败。普通项目列表不使用这个上限。因此宽松列表成功不能代替迁移完整性验证。

迁移使用[服务方法](../packages/server/src/project-knowledge/service.ts)和[迁移 API](../packages/server/src/api/routers/projects.ts)。先备份 SQL 与 OpenViking 数据并记录应用版本，再检查：

```bash
remi memory migration status --workspace <workspace>
remi memory migration backfill --dry-run --workspace <workspace>
```

SQL 模式只支持上述 dry-run，真实 backfill 需要 OpenViking。先在 `shadow` 模式执行和验证：

```bash
remi memory migration backfill --workspace <workspace>
remi memory migration backfill --resume --workspace <workspace>
remi memory migration retry --workspace <workspace>
remi memory migration verify --workspace <workspace>
remi memory migration status --workspace <workspace>
```

`--resume` 重新检查可恢复状态并复用已有版本快照，并非跳过所有 `ready` 行。切换到 `openviking` 前暂停写入，再次 backfill/verify/status，确认服务 ready、没有 pending/failed/deleting、验证无失败，并抽查正文与 revision。切换后验证读写、历史、检索、任务 Wiki 物化和 CLI 按需 Memory 读取。

SQL 正文在 shadow 阶段保留，迁移命令不提供清空旧正文的操作。切换后回滚只可恢复 SQL 备份覆盖的时间点；已经写入 OpenViking 的新内容需要先导出和协调，直接改回 SQL 会丢失这些更新。本页不代表已对任何部署执行迁移或验证。
