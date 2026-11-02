---
title: Cursor CLI Runtime
status: active
summary: 在模型网关配置 Cursor Key，通过原生 ACP 执行 Remi 任务。
---

# Cursor CLI Runtime

Cursor 是独立的 Agent Runtime。Remi 通过 Cursor CLI 的 `acp` 子命令运行任务，与其他 Runtime 共用调度、消息、权限和提问界面。模型服务请求由 Cursor 发出，使用 Cursor 后端协议。

## 配置与启动

1. 在工作区的「模型网关」选择 Cursor，保存 Cursor API key。配置片段可直接使用 `{}`，由 Cursor 选择默认模型；需要指定 `default_model` 时，使用 Runtime 上报的模型 ID。
2. 在 Runtime 所在机器启动 `remi daemon start --provider cursor`，Remi 会下载并准备固定版本的 Cursor CLI。也可以提前运行 `remi runtime prepare --provider cursor`。安装包来自 Cursor 官方，包含运行所需的 Node；下载不需要 Key。
3. 使用 daemon 的自动发现时，已配置 Cursor Key 的工作区会准备并启动 Cursor Runtime。运行中的 daemon 新增 Cursor 配置后，重启 daemon 以发现它。模型网关的「立即探测」按钮会请求在线 Cursor Runtime 上报原生模型列表。
4. 模型网关展示各模型的原生推理档位和默认值。创建或编辑 Agent Variant 时，选择 Cursor 或对应执行组，再选择模型和该模型支持的 effort。Auto 模型没有独立 effort 选项。任务按现有 Chat、Issue 流程执行。

「查看示例」展示可选字段的完整写法；打开示例不会修改已保存的配置：

```json
{
  "base_url": "https://api2.cursor.sh",
  "default_model": "default"
}
```

`default` 是 Cursor 原生 Auto 模型的 ID。两个字段都可以省略，因此 `{}` 也可直接使用；指定其他模型时，以 Runtime 上报的模型 ID 为准。

Agent 的模型留空时继承网关的 `default_model`，模型目录和 effort 选项使用该模型的原生能力；显式选择 `default` 时使用 Cursor Auto。任务领取时固定实际模型和 effort，后续修改网关默认模型影响下一次领取的任务。配置的默认模型必须存在于目标 Runtime 的原生目录中。

也可以通过 `remi workspace relay update <workspace> cursor --file <配置文件>` 保存网关，文件使用现有接口结构：`fragment` 为 JSON 字符串，`token_op` 为 `set`，`auth_token` 为 Cursor Key。`remi workspace relay probe <workspace> cursor` 请求 Runtime 刷新模型列表。

## 认证和端点

网关凭据在任务启动时注入 `CURSOR_API_KEY`。使用 Key 时设置 `AGENT_CLI_CREDENTIAL_STORE=memory`，凭据交换保留在子进程内存；每个会话有独立的配置和数据目录。清空工作区 Cursor Key 后，CLI 可使用机器上已有的 Cursor 登录状态；Remi 不会自动打开浏览器登录。

Cursor 用户 Key 对应其账号的用量与套餐，具体额度由 Cursor 管理，见 [官方认证文档](https://cursor.com/docs/cli/reference/authentication)和 [SDK 计费说明](https://cursor.com/docs/sdk/typescript)。这里配置的是 Cursor Key，模型厂商的 Key 应按 Cursor 自己的支持范围配置。

片段可选 `base_url`，映射 `CURSOR_API_ENDPOINT`，缺省为 `https://api2.cursor.sh`。该地址必须提供 Cursor 后端协议；填写通用 OpenAI Responses 或 Anthropic Messages 地址不能替代 Cursor 服务。模型发现通过 CLI 的 ACP 会话进行，服务端不会拿 Cursor Key 请求模型网关的 `/v1/models`。

## 会话、指令与能力

- 新会话使用 `session/new`；后续进程通过 `session/load` 恢复原生会话。`CURSOR_DATA_DIR` 指向会话私有目录以保存历史。
- 当前 Cursor ACP 从进程工作目录加载规则和 Skill，从会话的 `cwd` 执行文件和 shell 操作。Remi 将前者设为私有 provider home，后者保留实际执行目录。
- Remi 的 Agent 定义、会话规则和本地项目说明写入私有 `AGENTS.md`；Agent Skill 写入该目录下的 `.cursor/skills`。实际项目的 `AGENTS.md`、`CLAUDE.md` 和本地 Skill 目录由 daemon 读取并带入会话说明。工作区根到当前目录的 `.cursor/rules` 中，`alwaysApply: true` 的规则内联，其他规则保留描述、匹配范围和原文件路径供 Agent 按需读取。执行过程中深入其他子目录时，仍需读取该目录的说明文件。
- 权限请求使用 ACP 权限处理；`cursor/ask_question` 和 `cursor/create_plan` 接到 Remi 的提问界面。支持图片输入、原生子会话、模型与推理参数选择，实际可选项以 CLI 上报为准。
- 当前接入不提供 Cursor Agent Plugin 安装、`allowedTools` 会话配置或后台进程驻留。Cursor CLI 自身的个人 Skill 加载行为由 CLI 管理。用量按收到的事件记录；CLI 未提供的 token 或费用保持未知。

原生提问存在上游限制：Cursor 官方已确认部分 ACP 会话的工具列表缺少 `AskQuestion`，原因在服务端对 ACP 会话的识别，见[问题报告与官方回复](https://forum.cursor.com/t/agent-acp-never-offers-the-askquestion-tool-so-cursor-ask-question-is-never-sent/172976)。2026-10-29 使用固定 CLI 版本和真实账号的验收也未触发该工具。Remi 的提问回调已有模拟协议测试覆盖，原生提问的真实闭环仍待 Cursor 提供工具入口后验证。

Cursor CLI 安装在 Remi 管理的目录中，使用发布快照内固定的版本、下载地址、大小和 SHA-256。版本随 Remi 的运行依赖快照维护；私有配置使用 `channel: "static"` 保持运行版本一致。安装支持 macOS/Linux 的 arm64/x64，下载及解压完成后原子发布安装目录。可用 `REMI_CURSOR_AGENT_EXECUTABLE` 显式指定管理员维护的 CLI。

Remi 的 Runtime 页面提供 Remi CLI 升级入口。当前 Cursor 版本见 [运行依赖快照](../packages/acp/src/runtime-versions.json)；版本更新方式见 [发布准备脚本](../scripts/release-runtime.ts)。

## 实现与验证入口

- [Cursor adapter](../packages/acp/src/adapters/cursor.ts)、[交互转换](../packages/acp/src/cursor-interactions.ts)、[CLI 安装与发现](../packages/acp/src/cursor-install.ts)
- [模型网关片段](../packages/server/src/relay/fragment.ts)、[原生模型目录](../packages/server/src/store/runtime-model-catalog.ts)
- [会话目录与环境](../packages/daemon/src/agent-runtime/workspace/session-home.ts)、[本地上下文](../packages/daemon/src/agent-runtime/workspace/runtime-context.ts)
- [ACP 契约测试](../tests/unit/acp/cursor.test.ts)、[daemon 集成测试](../tests/unit/daemon/cursor-runtime.test.ts)、[网关接口测试](../tests/unit/multiremi/cursor-gateway.test.ts)

上述测试使用隔离目录和模拟 ACP 服务，不证明某个真实账号已具备 Cursor 权限。全量命令及运行前提见 [TESTING.md](../TESTING.md)。
