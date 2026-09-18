# Memory、Wiki 与知识加工

## 找到正确范围

Memory 保存项目可复用事实；Project Wiki 保存项目和跨仓库知识；Repository Wiki 保存多个项目共享的仓库知识。先检索，再读有关正文，避免把整库注入上下文。

```sh
remi memory search "<query>" --project <project-id> --json
remi memory get <document-id-or-slug> --project <project-id> --json
remi wiki list --project <project-id> --json
remi wiki get <document-id-or-slug> --project <project-id> --json
remi wiki repository list <repo-id> --json
remi wiki repository get <repo-id> <document-id-or-path> --json
```

list/search 可按工作区检索，单篇项目文档操作需明确项目。仓库 Wiki 使用独立的 repository 命令树，不能给项目 Wiki 随意追加一个 `--repo` 参数。

## 写入与发布不是同一状态

```sh
remi memory create --project <project-id> --title "<fact-title>" --content-file <memory.md> --ref issue:<issue-id> --json
remi memory update <document-id> --project <project-id> --content-file <revised.md> --expected-version <version> --json
remi wiki revisions <document-id> --project <project-id> --json
remi wiki backlinks <document-id> --project <project-id> --json
```

先修订已有条目，保留来源 refs，并用读取到的 expected-version 检测并发修改。发生冲突要重新合并内容，不移除版本条件强行覆盖。知识 body 是 Markdown 正文，不能把 JSON 转义字符串当文档。

普通 task Agent 的 create/update/delete 可能返回 **202 和 submission**，表示提出变更，正式 Memory/Wiki 尚未改变。工作区人类成员和有发布能力的任务走不同权限路径；读取响应中的 submission / compilation run，再查询实际文档版本确认结果。

## 提交素材与追踪加工

```sh
remi knowledge submit --project <project-id> --scope memory --content-file <source.md> --json
remi knowledge submissions --project <project-id> --json
remi knowledge inspect <submission-id> --json
remi knowledge runs --project <project-id> --json
remi knowledge run show <compilation-run-id> --json
remi wiki publish --help
remi memory publish --help
```

scope 为 `memory|project_wiki|repository_wiki`，目标选择与项目/仓库一致。记录素材提交 ID、加工运行状态和输出文档；提交成功不代表 Atlas 已加工完成。

publish 是具有知识发布能力的 task 专用流程：当前要求角色至少 maintainer，并绑定启用了允许的 `code-to-wiki` 插件，且任务范围匹配目标。把云友改名为 Atlas、使用人类 token 或普通 Agent 均不会自动获得发布权。具有该能力时按帮助提供 submission、稳定 dedupe-key、action 和内容；授权不满足时提交素材，不能绕过审核直改存储。

## 任务 Wiki 工作副本

```sh
remi wiki status --project <project-id> --json
remi wiki diff --project <project-id> --json
remi wiki push --project <project-id> --json
```

在 Remi 已物化的任务目录中操作 `./wiki`，`.multiremi/wiki-base` 是只读合并基线。先检查已有本地改动；需要拉取时用 wiki pull，在冲突解决前不盲目推送。移动、归并文档同步修复入链，并维护 `index.md` 阅读地图与 `log.md`。push 对普通 Agent 仍受提交/发布边界约束。

## 批量构建与迁移

`wiki repository build` 启动仓库 Wiki 构建，`wiki merge` 归并页面，均有实质副作用。用户要求迁移时先查 `memory migration status`，再用 `memory migration backfill --dry-run` 查看计划。真实 backfill 需要相应存储模式和备份条件；`knowledge migrate-legacy` 迁移旧知识为原始素材，与 Memory 存储迁移不是一回事。状态、backfill、verify、retry 各按当前帮助执行，不能用一次返回成功宣称全库完成。
