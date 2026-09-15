---
title: Claude Code ACP 接入
status: active
summary: 说明 Claude Code 的 Runtime 自定义 Messages 连接、鉴权注入、配置优先级及会话隔离。
---

# Claude Code ACP 接入

Claude Code 由 [daemon worker](../../packages/server/src/worker/daemon.ts) 组装任务，经 [AcpProvider](../../packages/acp/src/provider.ts)、[ClaudeAdapter](../../packages/acp/src/adapters/claude-code/index.ts) 和仓库固定的 `@agentclientprotocol/claude-agent-acp` 启动。桥接版本以 [BRIDGE_PIN](../../packages/acp/src/provision.ts) 为准。

Windows 通过 Node 启动随仓库提供的无扩展名 `remi-claude-agent-acp` 脚本，健康检查与实际 ACP 会话共用[启动解析](../../packages/acp/src/launch.ts)；机器需安装 Node 并将其加入 PATH。

## Runtime 自定义连接

Runtime 详情的「Claude Code 连接」支持一个 Anthropic Messages 兼容接口和一个模型。填写连接名称、API 基础地址、模型 ID，以及 API Key 或本机 `REMI_CLAUDE_*` 环境变量名；请求鉴权可选 Bearer Token 或 `x-api-key`。地址填写服务基础路径，Claude Code 在其后请求 `/v1/messages`，例如网关是 `https://gateway.example/anthropic`，不要填写完整 messages 路径。允许 Runtime 可访问的 HTTP(S) 本机或局域网地址，服务端不主动请求该地址。

请求头对应 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`（Bearer）或 `ANTHROPIC_API_KEY`（x-api-key），每次仅注入选中的一种。具体协议见 [Claude Code 官方网关接入说明](https://code.claude.com/docs/en/llm-gateway-connect)。这不是 OpenAI Chat Completions/Responses 协议转换器。

需要先更新并重启 daemon，使注册元数据带有 `claude_profiles: 1`。在此 Runtime 执行的 Claude 任务优先使用这条连接，未启用时继承原有工作区 Relay / 本机登录行为。云友模型需留空或选择该连接配置的模型；显式选择其他模型时任务报错。模型目录是配置声明，不表示服务可达，也不添加推测的 thinking 能力。

启动时读取配置的首次心跳与后续心跳使用相同的完整响应处理器，确保一并领取的更新、模型刷新等维护请求得到处理。

## 凭据与执行隔离

- [配置契约](../../packages/contracts/src/claude-profile.ts)复用 [公共连接校验](../../packages/contracts/src/runtime-connection.ts)，只接受结构化字段，不接受任意 JSON 设置、命令或内联 URL 凭据。
- API Key 使用现有 [AES-256-GCM 凭据存储](../../packages/server/src/runtime-provider-credentials.ts)，只向绑定 Runtime 机器的 daemon token 下发。服务端需要 `MULTIREMI_PROVIDER_ENCRYPTION_KEY`（base64 编码的 32 字节密钥），或使用部署的 `MULTIREMI_TOKEN` 派生；轮换、旧凭据保留和加密作用域见 [连接凭据契约](acp-codex-via-codex-acp.md#runtime-自定义连接)。GET/PUT 响应不回显密钥，省略 `api_key` 保留已保存的密钥。
- [Claude 注入器](../../packages/daemon/src/agent-runtime/claude-profile.ts)将模型、基础地址和模型别名写入隔离的 `CLAUDE_CONFIG_DIR/settings.json`，密钥仅存在子进程环境。清空另一种鉴权、旧 OAuth token 和额外鉴权头，并关闭继承的 Bedrock/Vertex/Foundry 路由开关。模型别名及子 Agent 模型统一指向配置模型，避免辅助请求跑到其他模型。
- 非秘密路由通过桥接器支持的 `claudeCode.options.settings` 再传入 SDK，覆盖项目/local 设置中的冲突地址、模型和云路由，其余项目设置继续加载。凭据不放入该元数据，也不写入基础 Home 或隔离配置文件。
- Claude Code 会用项目设置中的凭据覆盖进程环境。启用 Runtime 连接时，执行前检查工作目录及父目录的 `.claude/settings.json` / `settings.local.json`；若包含鉴权环境变量、`CLAUDE_CONFIG_DIR` 或 `apiKeyHelper`，任务明确报错并要求将凭据移至 Runtime 配置，不修改项目文件，也不把密钥写入 SDK settings/命令行来覆盖它们。
- 任务 claim 时冻结配置和凭据版本，并纳入执行指纹。Claude 自定义连接按执行指纹隔离 Home；连接未变时延续原生会话，变更后从产品记录重新启动。运行中任务使用冻结连接；自动重试在原 Runtime 仍兼容当前 Agent 时保留连接快照和 Runtime 归属，否则清除旧快照并重新调度。旧 daemon 不可领取带 Claude profile 的任务。
- 可选的 Chat Completions 进度摘要不复用此连接密钥；需要单独配置 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` 与 `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY`。正常任务消息不受影响。

## API 与 CLI

`GET/PUT /api/runtimes/:id/claude-profile` 沿用 Runtime 可见性和 owner/admin 编辑权限，task token 对配置路径为 hard deny。凭据由 `GET /api/daemon/runtimes/:id/claude-profile-key?credential_id=...` 下发，只接受绑定机器身份的 daemon token，返回 `Cache-Control: no-store`；同机器其他 Runtime 的引用也不能读取。

```bash
remi runtime claude-profile get <runtime>
remi runtime claude-profile set <runtime> --file profile.json
```

`profile.json` 示例：

```json
{"profile":{"name":"private","base_url":"https://gateway.example/anthropic","model":"custom-model","auth_mode":"api_key","auth_header":"bearer","env_key":""},"api_key":"REPLACE_WITH_API_KEY"}
```

环境变量模式使用 `"auth_mode":"env","env_key":"REMI_CLAUDE_API_KEY"` 并省略 `api_key`。`auth_header` 仍决定请求头。`{"profile":null}` 恢复继承；更新本机变量后需重启 Runtime。

## 验证入口

- [配置、权限、加密版本和任务亲和性](../../tests/unit/multiremi/runtime-claude-profile.test.ts)
- [注入、旧配置覆盖和密钥不落盘](../../tests/unit/daemon/claude-profile.test.ts)
- [真实 API → daemon，两种鉴权及隔离 Home](../../tests/integration/runtime-claude-profile.test.ts)
- [Claude 页面及鉴权选择](../../frontend/packages/views/runtimes/components/runtime-claude-profile-tab.test.tsx)
- [CLI 文件输入与恢复继承](../../tests/unit/remi/cli-operations.test.ts)

这些文件是验证入口，不代表所有外部服务兼容。真实模型服务还需满足 Claude Code 的工具调用、流式事件和模型能力要求。
