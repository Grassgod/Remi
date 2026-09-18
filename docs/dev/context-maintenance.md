---
title: 开发上下文维护
status: active
summary: 用当前源码修正文档，在同一归属替换旧内容，并检查默认阅读链。
---

# 开发上下文维护

上下文的交付标准是：能找到当前实现、理解约束并执行验证。只补索引或历史提示不能修复与源码冲突的说明。

## 内容归属

| 内容 | 唯一维护位置 | 引用方式 |
|---|---|---|
| 仓库级规则 | [AGENTS.md](../../AGENTS.md) | 其他 Agent 入口只链接 |
| 前端专属规则 | [frontend/AGENTS.md](../../frontend/AGENTS.md) | 放在适用目录 |
| 运行命令 | [CLAUDE.md](../../CLAUDE.md) | 命令以 [package.json](../../package.json) 和实际入口为准 |
| 模块与数据流 | [ARCHITECTURE.md](../ARCHITECTURE.md)、[前端地图](frontend.md) | 保留源码入口，避免复制字段表 |
| 产品契约 | [开发索引](README.md)中对应专题 | 先核对路由、类型、调用方与测试，再改原文 |
| 验证方法 | [TESTING.md](../../TESTING.md)、[性能调查](performance.md) | 区分可运行的方法与实际执行结果 |
| 临时调查与过程 | 当前任务或 PR | 收敛后把有复用价值的结论写回对应主题 |

现有代码能证明行为，不能证明当时的决策动机。只有有记录的取舍才作为历史决策引用。

## 对齐流程

1. 沿 [README](README.md) 选择任务主题，读取相关源码、约束、测试与脚本。
2. 比对文档中的入口、默认值、能力、命令和完成状态。冲突处直接改成已核实的现状；未测结果标明未测。
3. 同一主题只保留一份当前说明。旧方案有仍需使用的配置或升级步骤时，先整理为带适用条件的当前操作手册；被替代的正文从工作树移除，追溯使用 Git 历史。
4. 同批修复导航、文档入链和源码注释中的旧引用。计划不因已有一部分代码就变成当前契约；默认入口只指向当前说明。
5. 运行文档检查及本次行为变更所需的验证，交付实际结果与未覆盖范围。

`docs/dev/` 内使用下面的元信息。摘要帮助按需选择正文，不代替源码核对。

```yaml
---
title: 当前主题
status: active
summary: 本文回答的问题与可采取的行动。
---
```

默认上下文不保留 `draft`、`historical`、`deprecated` 状态页面或归档目录链接。待讨论的方案留在任务或 PR，确定并实现后更新当前主题。需要支持旧版本数据的迁移手册是当前操作文档：写明适用条件，不把旧系统描述成现状。

## 自动检查

Node.js 22+，不需要安装依赖：

```bash
npm run docs:test
npm run docs:check
```

[检查器](../../scripts/check-dev-context.mjs)从根与前端入口、`docs/dev/**/*.md` 出发，递归检查可达的本地 Markdown：目标必须存在、不得越出仓库、不得回链到归档目录或明确退役/非当前状态文档，`docs/dev` 元信息须完整且为 `active`。循环链接只处理一次。
[CI](../../.github/workflows/dev-context.yml)在 Linux/Windows 运行同样的检查。

它跳过代码示例、外链与纯锚点，不检查锚点、外网可达性或正文语义。存在但错误的源码引用、过时数字仍需第 2 步核对；绿灯不代表功能或性能验收通过。

## 与 OpenAI 指导的对应

OpenAI 的 [Codex 最佳实践](https://learn.chatgpt.com/guides/best-practices)强调简短、准确的 `AGENTS.md`，较长内容按任务链接，并提供验证标准；[自定义指南](https://learn.chatgpt.com/docs/customization/overview)建议把反复出现的误解转成修正和可执行检查。
[指令发现机制](https://learn.chatgpt.com/docs/agent-configuration/agents-md)说明根与子目录指令的加载顺序，因此根规则与前端规则分开维护。

这里的具体文件布局、退役处理和 Node 检查器是 Remi 为落实这些原则选择的仓库约定，并非 OpenAI 指定的目录格式。
