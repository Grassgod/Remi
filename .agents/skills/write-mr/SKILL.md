---
name: write-mr
description: 为 Remi 编写、修改或检查 MR/PR 标题与描述。用户要求提 MR、创建 PR、修改 MR message 或检查提交说明时使用；聚焦变更表述与验证证据，不替代代码审查。
---

# 编写 MR

为没有参与开发过程的 reviewer 写清最终变更、动机、验证和剩余边界。GitHub 的 PR 与用户所说的 MR 在此指同一种交付物。

## 范围与依据

先读根目录 [AGENTS.md](../../../AGENTS.md) 和 [贡献指南](../../../CONTRIBUTING.md)，再核对目标 MR 的 base、head、完整 diff、实际测试记录和当前检查状态。只读取本次变更涉及的契约。

这份 skill 提炼 agent-nexus 的 [标题规范](https://github.com/moesin-lab/agent-nexus/blob/1db2013210144e402b8b1f2a7e12c2536c1ee91a/docs/dev/standards/commit-style.md) 与 [描述规范](https://github.com/moesin-lab/agent-nexus/blob/1db2013210144e402b8b1f2a7e12c2536c1ee91a/docs/dev/standards/code-review.md)。日常使用以下本地写法即可；来源用于追溯，不要求每次加载外部规则，也不引入其分支命名、强制委派或合并策略。

## 标题与正文

标题采用 `type(scope): 动词起头的完整变更目的`；scope 可省略，中文或英文均可，英文小写起头，末尾不加句号。常用 type 为 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。

只看标题就应能复述这次改动。不要用 `+`、逗号或“顺便”拼接独立动作，不写方案代号、任务过程或“完善功能”等空泛结论。标点用于同类对象枚举是可以的。若两个变化服务同一目的，用这个目的作标题；若无共同目的，指出范围需要拆分，不靠换标题掩盖，也不擅自重写分支历史。

按 [正文模板](assets/pull-request.md) 填写，保留五个固定标题，各节解释以中文为主；字段名、命令、路径和专有名词可保留英文。

- `Summary`：先写具体问题及改变后的行为，再用少量条目列出最终实现。范围变化后重写全文，移除聊天过程和废弃方案。
- `Why`：解释必要性，回答 `ADR:` 和 `Spec:` 两问。引用确实存在的决策、契约或本仓库当前说明；没有独立 ADR 时写 `N/A` 和具体中文理由，不能杜撰编号或把实现反推成历史决策。
- `Test plan`：用 checkbox 列测试文件、关键断言、实际命令和结果。只有实际通过才用 `[x]`；失败、未跑和等待中的检查用 `[ ]` 并写原因。新增 API 按根规则列出 CLI 对齐证据。影响用户路径时列真实浏览器、CLI 或外部平台验证，单测和类型检查不能代替它们。
- `Review notes`：分别填写 `Independent agent review:` 与 `Deep review:`，说明范围、结论、原始记录及反馈处理。没有执行就明确写未执行；不适用时给中文理由。跨层、鉴权、迁移等变更应标明需要深入复核的边界，不把局部复核写成全量通过。执行审查与委派仍由本次任务授权和根规则决定。
- `Out of scope`：写与本次变更相邻、reviewer 可能误解的能力边界；确实无额外边界时说明理由，不堆砌无关免责话术。

## 证据与禁止事项

- 测试结果注明适用提交或环境；区分本地结果和远端 CI。不要相加有重叠的测试数量，不把旧提交绿灯套到新 head。
- 优先链接仓库文件、CI job 和已有 review 评论。公开正文不用个人机器绝对路径或仅作者可见的临时日志作为可复现证据。
- 原始审查记录不在公开位置时说明留痕范围；不补造审查者、分数、评论链接、通过记录或已经关闭的反馈。
- 不写密码、token、会话正文或无关个人信息。示例使用占位值。
- 填写 MR 不授权合并、部署、强推、改历史或向他人发送通知。沿用会话中已有授权，不额外重复索要已给出的许可。

## 写回与核验

本仓库有 fork 和 upstream。用 `git remote -v` 确认目标；创建、读取、更新 MR 时显式指定仓库。常用 fork 是 `moesin-lab/Remi`，仍以当前 remote 和用户要求为准，不能依赖 `gh` 的默认仓库推断。

使用 GitHub 连接器的结构化参数，或将完整正文以 UTF-8 和真实换行写入临时文件后传给 `gh --body-file`。不要把多行正文拼进 shell 命令。

```powershell
gh pr view <number> --repo <owner/repo> --json title,body,baseRefName,headRefName,headRefOid
gh pr edit <number> --repo <owner/repo> --title '<title>' --body-file <body-file>
gh pr checks <number> --repo <owner/repo>
```

创建时也显式传 `--base` 与 `--head`。写回后重新读取远端标题、正文和 head，确认目标与内容一致；检查异步 CI 的实际状态。正文符合格式不代表代码可合并，pending 或 failed 不得写成全绿。

## 交付与缺失信息

交付 MR 链接、改动摘要和仍未完成的检查；只要求草稿时交付标题与完整正文。若尚未授权发布，先完成可审阅草稿，再按当前会话约束处理发布。

仅在目标仓库、MR 身份或影响表述的关键信息确实无法从当前上下文确定时询问。缺少测试或 review 证据可以先如实标记，继续完成其他内容，不因此停在空白模板。
