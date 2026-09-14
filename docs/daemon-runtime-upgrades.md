# Daemon 与 ACP / Agent SDK 配套升级

Remi 发布版本通过 [runtime-versions.ts](../packages/acp/src/runtime-versions.ts) 固定一组经过验证的依赖：

| Provider | ACP bridge | SDK / npm runtime | 实际执行文件 |
| --- | --- | --- | --- |
| Claude | `@agentclientprotocol/claude-agent-acp@0.66.0` | `@anthropic-ai/claude-agent-sdk@0.3.259` | Claude Code `2.1.259` |
| Codex | `@agentclientprotocol/codex-acp@1.11.0` | `@openai/codex@0.153.4` | Codex `0.153.4` |

这里只固定 ACP 与 Agent 执行依赖，不修改全局 `claude`、`codex` 命令或用户登录配置。Codex ACP 使用 `@openai/codex` 执行文件；此链路没有另一个需要安装的 `@openai/codex-sdk`。环境变量指定的自定义执行文件仍然保留；与当前版本不兼容时健康检查会报错。

## 升级路径

平台的 CLI 升级请求沿用现有排空/暂停接单流程。安装脚本解压新发布包后，由新包的 `remi runtime prepare` 安装其自身声明的版本并验证。验证成功后才替换 `remi` 与配套 Claude wrapper，随后 daemon 重启、重新注册。依赖准备失败时安装命令返回失败，已有 daemon 二进制保持不变。

每个 provider 安装到 `${REMI_HOME:-~/.remi}/acp/bundles/<provider>-<bridge>-<sdk>/`，先在同级临时目录安装。预检直接运行新 bundle，不切换旧 daemon 使用的 Codex 启动链接；新 daemon 启动时才启用。旧的 `~/.remi/acp/node_modules` 和全局安装保留为兼容入口。修复同一 bundle 时旧目录保留为 `.previous-<timestamp>-<pid>`，可人工回收。

启动和 ACP 重装入口复用同一套版本与安装逻辑。检查从 bridge 的目录解析真实 SDK，包括嵌套依赖；仅 bridge 版本正确不代表就绪。SDK 通过 npm overrides 固定，避免上游旧 pin 或版本范围造成实际运行版本漂移。

安装校验包含：bridge 版本、SDK 包版本、执行文件 `--version`、Codex usage 补丁、Claude wrapper 健康检查及真实 ACP `initialize` 协商。协商不创建 Task、不发送模型 prompt。原有 daemon 启动健康检查继续执行；安装校验不等同于登录授权、真实模型调用或重启后服务注册成功的端到端验收。

旧发布包不含 `runtime-bundle.json`，安装脚本继续兼容旧版本安装。已经发布的旧 daemon 不会凭空得到新的依赖 pin，需要安装包含本改动的新 Remi 发布版本。

## 本地准备与验证

```bash
remi runtime prepare                         # 已安装/配置的 provider
remi runtime prepare --provider claude
remi runtime prepare --provider claude --provider codex
```

命令无服务端鉴权要求，只操作当前用户的本地 Remi 依赖。隔离验证时给 `REMI_HOME` 指定新临时目录；源码运行可通过 `REMI_CLAUDE_AGENT_ACP_EXECUTABLE` 显式选择仓库内 `bin/remi-claude-agent-acp`。

维护者更新 pin 后应运行 `bun test tests/unit/acp tests/integration/multiremi-release.test.ts`、后端 typecheck、CLI capabilities 检查，并在隔离目录执行真实 `runtime prepare`。与 Codex bridge 升级 PR #172 使用相同的 `1.11.0` 版本。
