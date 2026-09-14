# Daemon 与 ACP / Agent SDK 配套升级

Remi 发布版本通过 [runtime-versions.ts](../packages/acp/src/runtime-versions.ts) 提供经过验证的依赖基线；daemon 还会定期检查并自动更新到上游最新稳定版。当前基线：

| Provider | ACP bridge | SDK / npm runtime | 实际执行文件 |
| --- | --- | --- | --- |
| Claude | `@agentclientprotocol/claude-agent-acp@0.76.0` | `@anthropic-ai/claude-agent-sdk@0.3.270` | Claude Code `2.1.270` |
| Codex | `@agentclientprotocol/codex-acp@1.11.0` | `@openai/codex@0.154.0` | Codex `0.154.0` |

更新对象是 daemon 实际使用的 ACP 与 Agent 执行依赖，全局 `claude`、`codex` 命令和用户登录配置保持原状。Codex ACP 使用 `@openai/codex` 执行文件；此链路没有另一个需要安装的 `@openai/codex-sdk`。显式指定自定义 ACP/Agent 执行路径的 provider 不参与自动更新。

## 定期自动更新

默认启用，每 24 小时检查一次公共 npm registry 的 `latest` 稳定标签；首次检查在 daemon 就绪至少 60 秒后触发。每台机器的 Claude/Codex lane 共用一个更新器，不重复下载。检查时间和结果写入 `${REMI_HOME:-~/.remi}/acp/update-status.json`，重启后仍遵守间隔。

检测和 npm 安装、ACP 预检运行在独立子进程中，期间正常接单与心跳。依赖全部验证通过、有版本变化后才暂停新任务领取；已有任务自然结束，包含正在返回的 claim 和结果收尾，不设 15 分钟失败上限，也不取消 Wiki 等长任务。全部 lane 空闲后原子提交 `active-runtimes.json`，通过现有 supervisor 重启路径切换。任务若一直未结束，状态保持 `waiting_for_tasks`。

下载、版本校验、Codex usage 补丁、Claude wrapper 或 ACP 初始化失败时保留旧版本，不暂停接单，一小时后重试。仅接受完整的稳定 SemVer，拒绝预发布和降级的 dist-tag。Claude SDK 与独立 CC 的发布若尚未对齐，实际执行版本校验会阻止切换，待上游发布齐全后重试。关闭自动更新可解除尚未切换的等待。

当前选择独立于 Remi 发版 pin 持久化；重启不会把已验证的更新版本降回旧 pin。升级 Remi 后，其新基线和现有选择都会重新做安装预检。此策略自动跟进依赖，不自动发布或升级 Remi 自身。

```bash
remi runtime updates status
remi runtime updates check                              # 只查上游版本
remi runtime updates configure --enabled true --interval-hours 24
remi runtime updates configure --enabled false
remi runtime prepare --latest --provider claude --provider codex  # 手动预检，不切换
```

设置在运行中的 daemon 上最迟 10 秒后重新读取。自动更新需要持续运行的 supervisor；`--once` 不启用。

## 升级路径

平台的 CLI 升级请求沿用现有排空/暂停接单流程。安装脚本解压新发布包后，由新包的 `remi runtime prepare` 安装当前选择（不低于新包基线）并验证。验证成功后才替换 `remi` 与配套 Claude wrapper，随后 daemon 重启、重新注册。依赖准备失败时安装命令返回失败，已有 daemon 二进制保持不变。

每个 provider 安装到 `${REMI_HOME:-~/.remi}/acp/bundles/<provider>-<bridge>-<sdk>-<executable>/`，先在同级临时目录安装。预检直接运行新 bundle，不切换旧 daemon 使用的 Codex 启动链接；新 daemon 启动时才启用。旧的 `~/.remi/acp/node_modules` 和全局安装保留为兼容入口。修复同一 bundle 时旧目录保留为 `.previous-<timestamp>-<pid>`，可人工回收。

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
