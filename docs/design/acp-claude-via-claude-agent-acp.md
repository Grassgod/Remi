---
title: Claude Code ACP 接入
status: active
summary: 说明 Claude Code 的 Runtime 自定义 Messages 连接、鉴权注入、配置优先级及会话隔离。
---

# Claude Code ACP 接入

Claude Code 由 [daemon worker](../../packages/server/src/worker/daemon.ts) 组装任务，经 [AcpProvider](../../packages/acp/src/provider.ts)、[ClaudeAdapter](../../packages/acp/src/adapters/claude-code/index.ts) 和仓库固定的 `@agentclientprotocol/claude-agent-acp` 启动。桥接器、SDK 和实际执行文件版本以 [runtime-versions.json](../../packages/acp/src/runtime-versions.json) 为准，准备与安装步骤见[配套升级说明](../daemon-runtime-upgrades.md)。

Windows 通过 Node 启动随仓库提供的无扩展名 `remi-claude-agent-acp` 脚本，健康检查与实际 ACP 会话共用[启动解析](../../packages/acp/src/launch.ts)；机器需安装 Node 并将其加入 PATH。

## Runtime 自定义连接

客户端在 initialize 声明 AIR `sessionFailure`，从响应顶层 `InitializeResult._meta.jetbrains.air.capabilities` 读取支持情况；`agentCapabilities._meta` 只作兼容读取。provider 将 error severity 通知抛成任务失败，并保留 RPC `error.data` 中的 `errorKind` 用于分类。错误文本仅追加白名单字符串字段，先脱敏再限长 500 字符，不序列化原始 data。AIR category 比 Remi 的失败原因更粗，不能单独据它区分模型不可用和无效请求。模型不可用/5xx 可使用备用模型，auth 和无效请求不消耗切换次数；具体恢复口径见 [ADR 0010](../adr/0010-turn-failure-from-bridge-typed-session-failure.md)。

原生 `/compact` 失败另走 `tool_call_update(status: "failed", _meta.contextCompaction.error)`，随后可能正常返回 `end_turn`，不保证发 AIR error。provider 独立记录这条失败，以 error 文本作为详情；只有同一轮失败后再次输出 assistant 文本才视为恢复并记 warning。前一轮或失败前的正常输出、压缩横幅、thinking 和普通工具失败不改变这项判断。

RPC、typed 失败对象及其 cause、原生失败压缩工具的文本共用 ACP 脱敏函数 `redactProviderErrorText`；daemon 在失败报告、日志和终结进度写入前用 `redactTaskError` 再调用一次。原始分类 hint 不可枚举，typed failure 保存脱敏副本。脱敏只保证以下三类，范围以 [ADR 0010](../adr/0010-turn-failure-from-bridge-typed-session-failure.md) 第 2 条为准：

- 已配置凭据按值替换：本任务的 relay 和 auth 令牌，以及 provider 环境变量中名字含 `SECRET`、`TOKEN`、`PASSWORD`、`API_KEY`、`ACCESS_KEY`、`PRIVATE_KEY`、`CREDENTIAL` 段的值，trim 后不足 8 字符的跳过。在任意位置替换，覆盖原文、Base64、Base64url 和 URL 编码（含 `+` 与小写十六进制变体）。
- 已知格式：`Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie` 头的值，`Bearer`/`Basic` 后的 token，URL 里的用户名密码，`sk-` 密钥，`ghp_`/`gho_` token，三段式 JWT。
- 敏感键后的值：键名经最多三次 `%XX` 解码、拆驼峰、转小写后以 `api_key`、`key`、`token`、`secret`、`password`、`session_id`、`auth`、`cookie` 等结尾，分隔符为 `:` 或 `=`（允许转义引号）。引号串替换到同一转义层级的闭合引号，未闭合时到行尾；`{}`/`[]` 容器替换到匹配的闭合处，未闭合时到文本末尾；裸值只替换一个词，遇到空白、引号、反引号、`,;&{}[]` 或转义引号结束。唯一例外：值前一个字符是空格、且这个词整体是 4xx/5xx 状态码（可带一个 `.` 或 `:`）时保留，供失败分类使用。

不在范围内，QA 记为观察项而非缺陷：裸值终止符之后没有标签的文本；不足 8 字符的已配置凭据（只靠格式和键名规则）；空敏感字段后用 tab 或换行隔开的状态码会被替换；`401\"` 这类转义形态在脱敏前就分不出类。

Runtime 详情的「Claude Code 连接」支持一个 Anthropic Messages 兼容接口和一个默认模型。填写连接名称、API 基础地址、模型 ID，以及 API Key 或本机 `REMI_CLAUDE_*` 环境变量名；请求鉴权可选 Bearer Token 或 `x-api-key`。地址填写服务基础路径，Claude Code 在其后请求 `/v1/messages`，例如网关是 `https://gateway.example/anthropic`，不要填写完整 messages 路径。允许 Runtime 可访问的 HTTP(S) 本机或局域网地址，服务端不主动请求该地址。

请求头对应 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`（Bearer）或 `ANTHROPIC_API_KEY`（x-api-key），每次仅注入选中的一种。具体协议见 [Claude Code 官方网关接入说明](https://code.claude.com/docs/en/llm-gateway-connect)。这不是 OpenAI Chat Completions/Responses 协议转换器。

需要先更新并重启 daemon，使注册元数据带有 `claude_profiles: 1`。在此 Runtime 执行的 Claude 任务优先使用这条连接，未启用时继承原有工作区 Relay / 本机登录行为。Agent 可选择此连接的其他模型，留空时使用连接默认模型。

[模型发现](../../packages/server/src/worker/runtime-profile-models.ts)由 daemon 使用所选鉴权头请求 `/v1/models`，基础地址已以 `/v1` 结尾时不重复追加；按 [Claude Models API](https://platform.claude.com/docs/en/api/models/list) 的 `has_more` / `last_id` 翻页。完整目录保留配置默认模型，探测失败保留上次目录；首次失败仍可使用配置模型。thinking 能力仅按准确模型 ID 合并 ACP 实测结果，目录可读取也不代表模型推理成功。供应商目录不可用但 ACP 探测成功时，保留已有目录（首次使用配置默认模型）并更新已知模型的能力，日志明确记录目录探测失败；不会把 ACP 的官方模型列表当作 custom 供应商目录。平台和 daemon 需同时更新：模型上报携带 `model_profile`，过期或旧 daemon 的无标识上报不能覆盖 custom 目录。

启动时读取配置的首次心跳与后续心跳使用相同的完整响应处理器，确保一并领取的更新、模型刷新等维护请求得到处理。

## 凭据与执行隔离

- [配置契约](../../packages/contracts/src/claude-profile.ts)复用 [公共连接校验](../../packages/contracts/src/runtime-connection.ts)，只接受结构化字段，不接受任意 JSON 设置、命令或内联 URL 凭据。
- API Key 使用现有 [AES-256-GCM 凭据存储](../../packages/server/src/runtime-provider-credentials.ts)，只向绑定 Runtime 机器的 daemon token 下发。服务端需要 `MULTIREMI_PROVIDER_ENCRYPTION_KEY`（base64 编码的 32 字节密钥），或使用部署的 `MULTIREMI_TOKEN` 派生；轮换、旧凭据保留和加密作用域见 [连接凭据契约](acp-codex-via-codex-acp.md#runtime-自定义连接)。GET/PUT 响应不回显密钥，省略 `api_key` 保留已保存的密钥。
- [Claude 注入器](../../packages/daemon/src/agent-runtime/claude-profile.ts)将模型、基础地址和模型别名写入隔离的 `CLAUDE_CONFIG_DIR/settings.json`，密钥仅存在子进程环境。清空另一种鉴权、旧 OAuth token 和额外鉴权头，并关闭继承的 Bedrock/Vertex/Foundry 路由开关。模型别名及子 Agent 模型统一指向配置模型，避免辅助请求跑到其他模型。
- 非秘密路由通过桥接器支持的 `claudeCode.options.settings` 再传入 SDK，覆盖项目/local 设置中的冲突地址、模型和云路由，其余项目设置继续加载。凭据不放入该元数据，也不写入基础 Home 或隔离配置文件。
- Claude Code 会用项目设置中的凭据覆盖进程环境。启用 Runtime 连接时，执行前检查工作目录及父目录的 `.claude/settings.json` / `settings.local.json`；若包含鉴权环境变量、`CLAUDE_CONFIG_DIR` 或 `apiKeyHelper`，任务明确报错并要求将凭据移至 Runtime 配置，不修改项目文件，也不把密钥写入 SDK settings/命令行来覆盖它们。
- 任务 claim 时冻结配置、所选模型和凭据版本，并纳入执行指纹。Claude 自定义连接按执行指纹隔离 Home；连接和模型未变时延续原生会话，变更后从产品记录重新启动。运行中任务使用冻结连接和模型；自动重试在原 Runtime 仍兼容当前 Agent 时保留快照和 Runtime 归属，否则清除旧快照并重新调度。旧 daemon 不可领取带 Claude profile 的任务。
- 可选的 Chat Completions 进度摘要不复用此连接密钥；需要单独配置 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` 与 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY`。正常任务消息不受影响。

## 原生子代理与迟到回答

daemon 默认在 initialize 声明 `clientCapabilities.subagents: {}`（Claude 不需要 AIR 能力），claude-agent-acp 0.90 因 Remi 是 AIR 客户端而使用 AIR 形式：在发起子代理的会话上发 `subagent_spawned` / `subagent_state_update`，子代理的帧走子会话，Agent 工具调用被桥吞掉；恢复的子代理以 `<id>:generation:N` 重新宣布，Remi 把它并入原来的条目。规则与取舍见 [ADR 0021](../adr/0021-subagent-sessions-and-autonomous-rounds.md)，`REMI_ACP_NATIVE_SUBAGENTS=0` 恢复只收根会话的帧。

- **桥补丁 `claude-subagents-v1`。** AIR 形式的宣布不带子代理类型和是否在后台。补丁在 `dist/acp-agent.js` 的 `task_started` 处记下 SDK 的 `is_backgrounded` 与 `subagent_type`，给 `subagent_spawned` 加 `_meta.remi = { backgrounded, subagentType }`（未知为 null，恢复的一代为 `backgrounded: true`）。只有 `backgrounded: true` 是定论；`false` 可由推断升级（调用方在子代理运行时继续工作，说明它被移到了后台），反之不降级。子代理的模型取自它第一次请求的 `remiTokenUsage.model`。补丁与 `claude-usage-v4` 同时打、同时校验，锚点不匹配时安装与 `release:prepare` 失败，见[配套升级说明](../daemon-runtime-upgrades.md#claude-升级检查项)。
- **迟到回答（自主轮）。** 后台子代理在根会话的结果之前结束时，桥不保留这一轮，`session/prompt` 照常返回，随后桥自己开一轮 task-notification 后续轮给出真正的回答。[ClaudeAdapter](../../packages/acp/src/adapters/claude-code/index.ts) 声明 `autonomousRounds.resultOrigins`（结果 `usage_update` 的 `_meta["_claude/origin"].kind`）；provider 缓存 prompt 之后的帧，daemon 判定欠一轮时调用 `listenAutonomous` 在同一 attempt 里等：第一帧最多 60 s，之后等到结果标记，最多 10 分钟。仍在运行的后台子代理不需要等，桥会保留这一轮直到它结束。`REMI_ACP_AUTONOMOUS_ROUNDS=0` 关闭捕获与等待。
- **引导。** 等待期间到达的引导结束等待并重新提示；后续轮已经开始时，桥的 prompt 队列把新 prompt 并入它。prompt 运行中，前台子代理不算顶层工具调用，`waitForToolCalls` 不等它（ADR 0020）。
- **用量。** Claude 子代理的请求用量照旧在根会话上、带 `parentToolUseId`；自主轮沿用上一个 prompt 的采集器，轮范围的 `sdk_estimate` 由后续轮累计的 `total_cost_usd` 替换一次，见[统一用量与价格](../usage-accounting.md#子代理与自主轮)。

回归见 [原生子会话](../../tests/unit/acp/native-subagents.test.ts)、[自主轮](../../tests/unit/acp/autonomous-turn.test.ts)、[桥补丁](../../tests/unit/acp/usage-bridge-patches.test.ts) 与 0.90 的重录夹具 `tests/fixtures/acp/claude-090-native-subagent-*.json`。

## 后台任务

daemon 默认在 initialize 的 AIR 能力列表里加 `asyncTasks`（`REMI_ACP_ASYNC_TASKS=0` 不加），claude-agent-acp 0.90 对 AIR 客户端回报它，[AcpClient](../../packages/acp/src/client.ts) 的 `asyncTasksEnabled` 据此为真。规则与取舍见 [ADR 0022](../adr/0022-background-tasks-keep-alive-on-demand.md)。

- **发布什么。** 后台 Bash（`run_in_background`，或运行中被移到后台的前台 Bash，也从 Bash 结果的 `backgroundTaskId` 恢复）为 `shell`，工作流为 `workflow`（名称取 `workflow_name`），MCP 后台任务为 `monitor`，其他原始类型原样透传。Monitor 工具只把输出流给模型，桥不发布；子代理走原生子会话（ADR 0021）。子代理里启动的任务在该子代理的会话上宣布。
- **帧。** `async_task_spawned`（`asyncTaskId`、名称、类型、描述、`canStop`、可选的 `outputFilePath` 与 `toolCallId`；等调用 id，至迟在任务结束或 prompt 结果时放出）、`async_task_progress`（只带变化的字段，可有 `summary`、`lastToolName` 与 `usage`）、`async_task_state_update`（`running` / `paused` / `completed` / `failed` / `stopped`）。漏掉的结束边由电平信号以 `stopped` 补上，之后可被更正一次为完成或失败。Bash 的结果 `tool_call_update` 带 `_meta.jetbrains.air.asyncTasks = { backgrounded: true }`，翻译器据此把这次调用当作已在后台（引导中止不会关掉它）。
- **停止。** `_session/async_task/stop { sessionId, asyncTaskId }` 用**根**会话 id（子代理里的任务也是），答 `{stopped}`；任务从未宣布、已结束或正在停止时答 `false`。成功时桥发一条「Task stopped by user」notice，翻译器把它并进停止结果、不另成条目。停止的 shell 不向模型注入任何东西，所以停止从不响门铃。
- **会自己醒来。** 没有 prompt 时任务结束，SDK 注入 `<task-notification>`，Claude Code 自开一轮，结果的 `_meta["_claude/origin"].kind` 为 `task-notification`；ACP v1 客户端收不到这一轮开始或空闲的信号。所以 adapter 声明 `asyncTasks: { wakesModel: true }`：驻留时 provider 捕获全部帧，daemon 发门铃，接手的 attempt 用 `listenAutonomous` 重放并等它的结果标记。`session/cancel` 不碰后台任务。
- **输出末尾。** 输出只在文件里（`…/tasks/<id>.output`），桥不发文本。daemon 的 [AsyncTaskOutputTailer](../../packages/server/src/worker/async-task-output.ts) 只读路径以 `/tasks/<asyncTaskId>.output` 结尾的普通文件，attempt 中每 5 s、驻留时每 10 s 检查一次，变长时读末尾 4 KiB（从行首开始），每台 daemon 至多同时跟 8 个任务。Linux 私有 `/tmp` 下的路径映射到会话线的私有临时目录；文件存在却读不了时登记表记 `output_unreadable`，界面显示「无法读取输出」。
- **关闭。** `session/close` 走 `teardownSession` → `query.close()`，结束子进程；流结束时桥发布终态。回放历史时仍在运行的任务没有卡片，进程已经没了。驻留进程关闭前 daemon 先显式停止仍在运行的任务。

回归见 [provider 登记表与驻留](../../tests/unit/acp/async-tasks.test.ts)、[翻译器](../../tests/unit/daemon/trace-translator-background-tasks.test.ts) 与 [daemon 集成](../../tests/integration/multiremi-daemon-background-tasks.test.ts)。

## API 与 CLI

`GET/PUT /api/runtimes/:id/claude-profile` 沿用 Runtime 可见性和 owner/admin 编辑权限，task token 对配置路径为 hard deny。凭据由 `GET /api/daemon/runtimes/:id/claude-profile-key?credential_id=...` 下发，只接受绑定机器身份的 daemon token，返回 `Cache-Control: no-store`；同机器其他 Runtime 的引用也不能读取。

```bash
remi runtime claude-profile get <runtime>
remi runtime claude-profile set <runtime> --file profile.json
remi runtime model refresh <runtime> --json
remi runtime model status <runtime> <request-id> --json
remi runtime model list <runtime> --json
```

`profile.json` 示例：

```json
{"profile":{"name":"private","base_url":"https://gateway.example/anthropic","model":"custom-model","auth_mode":"api_key","auth_header":"bearer","env_key":""},"api_key":"REPLACE_WITH_API_KEY"}
```

环境变量模式使用 `"auth_mode":"env","env_key":"REMI_CLAUDE_API_KEY"` 并省略 `api_key`。`auth_header` 仍决定请求头。`{"profile":null}` 恢复继承；更新本机变量后需重启 Runtime。

## 验证入口

`claude-usage-v4` 补丁按原生 SDK session ID 与 assistant request ID 收集输入、输出、cache read/write 快照；ACP 会话 ID 不替代原生 session 身份。Claude 可以先发出内容块对应的 assistant，再通过 `message_delta` 提供最终用量，因此 assistant 不会提前删除正在采集的请求。最终 usage 与终止事件共同确认完整性；缺少最终计数的失败、取消或单独 `message_stop` 保留 partial。非流式 assistant 也需要明确的结束原因和有效计数。相同请求的累计数字更新原单位，旧块及重放不减少计数、不重复相加；父子调用分别保留自己的请求状态和实际模型。

服务端按工作区、provider、连接、原生 session/request 规范化归属；跨任务或 run 的竞争证据单独审计，不重复累加消费，缺少原生 session 的历史请求保持未知归属。context occupancy 与消费分开，流式请求数据在失败或取消前即进入 worker durable outbox；turn settle 只补请求明细未覆盖的未知部分，避免重复计量。SDK result 的 `total_cost_usd` 单独保留为 turn 范围的 `sdk_estimate`，包括显式零金额，不当作网关账单。安装与 release candidate 检查同时要求该补丁。回归见 [最终用量时序](../../tests/unit/acp/claude-final-usage.test.ts)、[桥接事件](../../tests/unit/acp/usage-bridge-patches.test.ts)、[请求归属](../../tests/unit/acp/usage-request-ownership.test.ts) 与 [失败用量](../../tests/unit/acp/usage-failure.test.ts)。

- [配置、权限、加密版本和任务亲和性](../../tests/unit/multiremi/runtime-claude-profile.test.ts)
- [注入、旧配置覆盖和密钥不落盘](../../tests/unit/daemon/claude-profile.test.ts)
- [真实 API → daemon，两种鉴权及隔离 Home](../../tests/integration/runtime-claude-profile.test.ts)
- [自定义目录发现、缓存及所选模型执行（provider fixture）](../../tests/integration/runtime-profile-model-discovery.test.ts)
- [Claude 页面及鉴权选择](../../frontend/packages/views/runtimes/components/runtime-claude-profile-tab.test.tsx)
- [CLI 文件输入与恢复继承](../../tests/unit/remi/cli-operations.test.ts)

这些文件是验证入口，不代表所有外部服务兼容。真实模型服务还需满足 Claude Code 的工具调用、流式事件和模型能力要求。
