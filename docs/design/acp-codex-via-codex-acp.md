---
title: Codex ACP 接入
status: active
summary: 说明任务到 Codex ACP 的当前执行链、配置来源、会话隔离与验证入口。
---

# Codex ACP 接入

当前执行链是服务端分配的 task/agent → [daemon worker](../../packages/server/src/worker/daemon.ts) → [AgentRuntime](../../packages/daemon/src/agent-runtime/runtime.ts) → [AcpProvider](../../packages/acp/src/provider.ts) → `codex-acp`，经 ACP stdio 通信。模型、执行参数和 MCP 来自任务携带的 Agent 配置及运行时装配；工作目录来自任务工作区解析。

## 配置与运行

- 在工作区 Agent 上设置 `provider: codex`，由符合路由条件的 Codex runtime 领取任务。[CLI Registry](../../apps/remi/cli/commands/agent-extensions.ts)提供 `remi agent create`、`remi agent update` 的 `--provider`、`--model` 和 `--thinking-level` 参数；先用对应命令的 `--help` 核对当前参数与身份要求。
- [daemon 启动入口](../../apps/remi/cli/multiremi.ts)调用 [ensureAcpBridges](../../packages/acp/src/provision.ts)，使用源码固定的 `@agentclientprotocol/codex-acp` 版本及 Remi usage 补丁。版本以 [runtime-versions.json](../../packages/acp/src/runtime-versions.json) 为准；它同时固定 bridge、配套 Codex SDK 和实际执行文件版本。发版准备与安装校验见[配套升级说明](../daemon-runtime-upgrades.md)。系统或 Homebrew 的 Codex 升级不会替换 Remi 托管依赖。
- ACP 执行文件按显式 `executable`、`REMI_CODEX_AGENT_ACP_EXECUTABLE`、Remi 管理目录与 PATH 解析，具体顺序见 `resolveAcpExecutableForAgent`。Windows 的扩展名解析也在该函数所在文件中。
- 当前 Codex 健康检查只确认执行文件可解析，不启动模型进程。检查通过不等于登录、网络、模型或真实任务已可用。

## 协议与隔离

[CodexAdapter](../../packages/acp/src/adapters/codex/index.ts)已经实现工具名、输入、结果预览及权限模式映射。[AcpProvider](../../packages/acp/src/provider.ts)根据 ACP 返回的能力协商 model/effort/mode；不能用未被桥接器读取的会话 `_meta` 代替协商。适配器对不支持的 `allowedTools` 和会话 `systemPrompt` 发出警告，不保证这些字段生效。

[Session Home](../../packages/daemon/src/agent-runtime/workspace/session-home.ts)负责会话目录与凭据路由，[Codex Home](../../packages/daemon/src/agent-runtime/agent-plugins/codex-home.ts)负责配置/插件物化及认证文件连接。[能力装配](../../packages/daemon/src/agent-runtime/capabilities/agent-plugins.ts)将隔离目录传为 `CODEX_HOME`；插件集合及执行指纹参与会话复用判定，不能让不同执行身份共用插件配置。

这类隔离针对配置、插件与原生会话记录，不意味着每个 Home 都拥有独立付费账号。原生 OAuth 可以连接基础 Home 的认证文件，Relay 凭据使用另一条注入路径；更改认证或切换 Relay 时需要同时检查目录与凭据状态。

## Runtime 自定义连接

Runtime 详情的「Codex 连接」页支持一个自定义 Responses provider：Profile 名称、API 基础地址、模型 ID，以及直接填写 API Key 或引用 Runtime 本机 `REMI_CODEX_*` 环境变量。需先更新并重启 daemon，使注册元数据包含 `codex_profiles: 1`。未启用时沿用工作区 Relay / 原生登录路径；启用后优先于工作区 Relay。接口地址由 Runtime 连接，允许 HTTP(S) 的 loopback / LAN 地址；服务端不会对它做模型发现请求，也不放宽工作区 Relay 的 URL 校验。

- [配置契约](../../packages/contracts/src/codex-profile.ts)只接受结构化路由字段，不接受任意 TOML、命令、URL 内联凭据或查询参数。每个 Runtime 配置一个默认模型；云友可选择此连接的其他模型，不指定时使用默认模型。
- [注入器](../../packages/daemon/src/agent-runtime/codex-profile.ts)将配置展开为隔离 `CODEX_HOME/config.toml` 的 `model`、`model_provider` 和 `model_providers.remi_custom`；密钥只进入进程环境 `OPENAI_API_KEY`，不写入 config/auth 文件。本机基础 Home 不变。ACP 的 `MODEL_PROVIDER`、`CODEX_CONFIG`、`DEFAULT_AUTH_REQUEST` 环境覆盖也会被明确设置，避免旧机器配置改变路由。
- 这里的 Profile 是 Remi 的命名连接，不是直接复制本机 `--profile` 配置。Remi 展开有效配置，不依赖本机 profile 文件的布局。
- [任务快照](../../packages/server/src/store/repos/tasks-repo.ts)在 claim 时冻结连接、所选模型和凭据版本，并把连接纳入执行指纹。修改配置只影响新任务；运行中任务和普通自动重试保留冻结快照及独立记录的来源 Runtime。Agent 后来修改模型不会改变旧重试的执行模型。原 Runtime 退役、来源不明、旧凭据缺失或原连接的 thinking 能力无法确认时，任务明确等待，不自动更换上游或凭据；可恢复原连接，或取消后新建任务。凭据轮换仍使用保留的旧版本，远端撤销则由执行报告认证失败。Agent 切换 provider 或路由所有权变化仍按既有规则使快照失效；显式 Chat 工作区迁移和 Runtime 身份合并有各自迁移契约。连接或所选模型变化后从产品会话记录重新启动原生会话，不把旧 provider 会话 ID 传给新接口。详见[冻结任务路由](../frozen-task-routing.md)。
- [模型发现](../../packages/server/src/worker/runtime-profile-models.ts)由所属 daemon 使用连接凭据请求基础地址下的 `/models`（遵循 [Models API](https://platform.openai.com/docs/api-reference/models/list)），例如 `/v2` 对应 `/v2/models`。成功后保存完整目录，并保留配置默认模型；失败保留上次目录，首次失败仍可使用配置模型。目录不证明模型推理成功；thinking 能力仅按准确模型 ID 合并 ACP 实测结果。未在 Codex 内置目录中的模型可由启动配置使用；兼容性取决于实际 Responses 服务。
- 若自定义 `/models` 还提供 Codex 格式的完整 `models` 元数据，daemon 在任务启动前用同一 ACP bridge 对应的 Codex 执行离线 `debug models` 校验，通过后原子写入隔离 Home，并通过 `model_catalog_json` 交给 Codex，保留供应商声明的上下文窗口、工具及推理能力。只有普通 `data` 模型列表时不推断这些能力；元数据加载失败会记录诊断并保留 Codex 原有行为。此修复只需更新 daemon。
- 供应商目录不可用但 ACP 探测成功时，保留已有目录（首次使用配置默认模型）并更新已知模型的能力，日志明确记录目录探测失败；不会把 ACP 的官方模型列表当作 custom 供应商目录。
- 模型上报携带本次探测的 `model_profile`，服务端只接受与当前连接匹配的目录；旧 daemon 的无标识上报不能覆盖 custom 目录。部署此能力需同时更新平台和 daemon。
- 可选的 LLM 进度摘要使用 Chat Completions 协议，因此不自动复用自定义 Responses 连接的密钥；需单独配置 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` 与 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY` 才启用该摘要。任务状态与执行消息照常上报。

直接填写的 API Key 使用 [AES-256-GCM 存储](../../packages/server/src/runtime-provider-credentials.ts)，认证数据绑定工作区、Runtime 和不可变凭据版本。服务端需配置 `MULTIREMI_PROVIDER_ENCRYPTION_KEY`（base64 编码的 32 字节密钥），也可使用部署的 `MULTIREMI_TOKEN` 派生密钥；没有加密密钥时保存失败，不回退明文。轮换时用逗号分隔的 `MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS` 保留旧密钥；更换 master token 前需保留旧派生密钥或迁移数据。历史凭据随 Runtime 保留以支持冻结任务重试，删除 Runtime 时清理；合并 Runtime 身份时重绑定加密认证数据。

浏览器 GET/PUT `/api/runtimes/:id/codex-profile` 只返回配置与不透明凭据引用，PUT 仅 Runtime owner / 工作区 admin 可用。`api_key` 省略表示保留现有密钥，`profile: null` 恢复继承。密钥只经 daemon 专用 `/api/daemon/runtimes/:id/codex-profile-key` 下发，必须使用绑定该 Runtime 机器身份的 daemon token；human/task token 和其他机器均不能读取。daemon 只在内存缓存不可变凭据版本。环境变量模式不经过服务端存储密钥，配置变量后需重启 Runtime。

CLI 对应命令：

```bash
remi runtime codex-profile get <runtime>
remi runtime codex-profile set <runtime> --file profile.json
remi runtime model refresh <runtime> --json
remi runtime model status <runtime> <request-id> --json
remi runtime model list <runtime> --json
```

`profile.json` 示例（文件内不要提交真实密钥到 Git；可省略 `api_key` 保留已保存的密钥）：

```json
{"profile":{"name":"private","base_url":"https://example.com/v1","model":"custom-model","auth_mode":"api_key","env_key":""},"api_key":"REPLACE_WITH_API_KEY"}
```

环境变量模式使用 `"auth_mode":"env","env_key":"REMI_CODEX_API_KEY"`，不传 `api_key`。恢复继承使用 `{"profile":null}`。

## 验证入口

| 范围 | 入口 |
|---|---|
| 执行文件、健康检查与显示适配 | [providers.test.ts](../../tests/unit/acp/providers.test.ts) |
| 桥接器版本与 provision | [provision.test.ts](../../tests/unit/acp/provision.test.ts) |
| npm 发布包、配套 Codex、usage 补丁和真实 ACP 协商 | [verify-codex-bridge.ts](../../tests/integration/verify-codex-bridge.ts) |
| 模型/effort/权限协商与隔离 Home | [acp-session-negotiation.test.ts](../../tests/unit/acp/acp-session-negotiation.test.ts)、[session-home.test.ts](../../tests/unit/daemon/session-home.test.ts) |
| 真实 API → daemon → ACP 任务 | [smoke-multiremi-acp.ts](../../tests/integration/smoke-multiremi-acp.ts) |
| 自定义连接、密钥权限/加密与会话快照 | [runtime-codex-profile.test.ts](../../tests/unit/multiremi/runtime-codex-profile.test.ts)、[codex-profile.test.ts](../../tests/unit/daemon/codex-profile.test.ts) |
| API → daemon 的配置与密钥注入（provider fixture） | [runtime-codex-profile.test.ts](../../tests/integration/runtime-codex-profile.test.ts) |
| 自定义 Codex 模型元数据注入 | [runtime-codex-model-catalog.test.ts](../../tests/unit/daemon/runtime-codex-model-catalog.test.ts) |
| 自定义目录发现、缓存及所选模型执行（provider fixture） | [runtime-profile-model-discovery.test.ts](../../tests/integration/runtime-profile-model-discovery.test.ts) |
| Runtime 表单与凭据保留 | [runtime-codex-profile-tab.test.tsx](../../frontend/packages/views/runtimes/components/runtime-codex-profile-tab.test.tsx) |

在根目录执行：

```bash
bun test tests/unit/acp/providers.test.ts tests/unit/acp/provision.test.ts tests/unit/acp/acp-session-negotiation.test.ts
bun run tests/integration/smoke-multiremi-acp.ts --provider=codex --check-only
```

移除 `--check-only` 会运行真实任务并调用模型，需要当前机器上有效的认证与模型访问。保留实际输出中的 `available`、`unavailable`、`passed`、`failed` 差别；这里列的是验证入口，不是本次执行结果。

发版准备会在隔离目录安装并验证快照组合。需要进一步验证真实会话时，可将该固定 bundle 中的 bridge 目录传给检查器：

```bash
bun run tests/integration/verify-codex-bridge.ts --package-dir=<bundle>/node_modules/@agentclientprotocol/codex-acp
```

检查器核对发布包的依赖声明和实际 CLI 版本，应用 usage 补丁并执行发布包中的 token 转换，随后验证 ACP 初始化、会话创建、model/effort/权限协商和关闭。它从当前 `CODEX_HOME`（默认 `~/.codex`）复制 `auth.json` 到临时 Home，真实会话需要有效登录；不复制本机配置。加 `--prompt` 会调用模型并校验回复及实际 usage 事件。不加该参数时不会发送 prompt，也不能视为真实模型调用通过。

检查器应核对发行快照中的配套 Codex 基线；usage 补丁仍用于逐请求累加，不能用只包含最后一次模型请求的 prompt 结算替代。协议回归夹具使用 Node shebang，Windows 可在 WSL 中运行 `acp-session-negotiation.test.ts`；发布包检查器直接通过 Node 启动 bridge，可在原生 Windows 运行。
