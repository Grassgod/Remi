# 任务 LLM 进度摘要（MUL-67）

运行中的任务由 daemon 持续生成一句人话进度，写入 `progress_summary / progress_step / progress_total`，
前端 agent-live-card、`remi issue runs` CLI 及任何读取任务 wire 字段的消费端可直接展示。

## 工作方式

- **双触发（借鉴 MoA Task Summary）**：daemon 在 `session.run()` 事件循环里累计新增 task_messages，
  当「自上次摘要起新增 ≥N 条」且「距上次摘要 ≥T 毫秒」同时满足时触发一次摘要；
  run 终止（正常完成 / 失败 / 取消）时强制生成终态摘要（`final: true`，服务端允许写入已终态任务）。
- **生成**：`packages/server/src/worker/progress-summarizer.ts` 对小模型做单次无状态调用。
  输入 = 任务标题 + 原始需求截断 + 自上次摘要以来消息的压缩视图（工具名 + 关键参数 + 文本片段，字符预算内保留最新）+ 上一条摘要；
  输出 = 一句中文进度 + 可选 step/total 估计（JSON，宽松解析）。
- **传输**：默认 `auto` 在 OpenAI 兼容配置可解析时优先调用 `/v1/chat/completions`（默认 Luna）；
  OpenAI HTTP 错误或超时后，本任务切换并记住使用 Anthropic Messages API。部分 workspace Relay 只放行
  真实 Claude Code 客户端，Anthropic API 返回 HTTP 4xx/5xx 后会继续切到 `claude -p`，避免重复撞网关。
  CLI 使用任务 provider env、独立临时 cwd 和同一超时预算。
- **凭证**：Anthropic API/CLI 复用任务自身的 provider 配置（workspace Relay 下发的
  `ANTHROPIC_BASE_URL/AUTH_TOKEN`，或本机 `~/.claude/settings.json` 的 env），否则回退 daemon 进程环境变量；
  OpenAI 兼容通道除专用环境变量覆盖外，从 workspace Relay fragment 读取任务网关地址，
  key 依次读取专用覆盖、`OPENAI_API_KEY` 环境变量、`$HOME/.codex/auth.json`。
  没有任何可用通道凭证时，本任务禁用摘要。
- **隔离性**：摘要调用 fire-and-forget，与主循环并行；失败只打日志，不影响任务执行；
  同一任务同时最多一个在途调用。

## 配置

工作区所有者和管理员可在 **Settings → Model Gateway → 任务进度摘要** 配置传输通道、
OpenAI 兼容模型和 Claude 兜底模型。设置保存在 workspace `settings.progress_summary`，
随 daemon 心跳下发，下一次任务启动时生效；模型输入留空即使用内置默认值。

| 配置项 | workspace settings | daemon 环境变量 | 内置默认 |
| --- | --- | --- | --- |
| 传输通道 | `progress_summary.transport` | `MULTIREMI_PROGRESS_SUMMARY_TRANSPORT` | `auto` |
| Claude 模型 | `progress_summary.model` | `MULTIREMI_PROGRESS_SUMMARY_MODEL` | `claude-haiku-4-5-20251001` |
| OpenAI 兼容模型 | `progress_summary.openai_model` | `MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL` | `gpt-5.6-luna` |

优先级为 **daemon 环境变量 > workspace settings > 内置默认**。workspace settings 只接受上表三个
非敏感字段；API key 不得写入 settings，因为该对象会下发给 workspace 成员和 daemon。网关地址、
凭证及触发阈值仍仅在 daemon 环境配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MULTIREMI_PROGRESS_SUMMARY_DISABLED` | （未设置） | `1`/`true` 关闭本能力 |
| `MULTIREMI_PROGRESS_SUMMARY_MESSAGES` | `20` | N：触发一次摘要所需的新增消息数 |
| `MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS` | `45000` | T：两次摘要之间的最小间隔（防抖） |
| `MULTIREMI_PROGRESS_SUMMARY_MODEL` | `claude-haiku-4-5-20251001` | 摘要模型 id（Relay 场景按网关支持的模型配置） |
| `MULTIREMI_PROGRESS_SUMMARY_TRANSPORT` | `auto` | `auto`：OpenAI → Anthropic API → Claude CLI；`api`：只用 Messages API；`cli`：优先 Claude CLI，二进制缺失时回退 API；`openai`：配置可解析时只用 OpenAI，无法解析时回退 `auto` |
| `MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL` | workspace Relay fragment / `ANTHROPIC_BASE_URL` | OpenAI 兼容网关地址，可带或不带末尾 `/v1`；专用变量优先，其次当前任务的 Relay `base_url`，最后兼容回退到任务及 daemon 的 `ANTHROPIC_BASE_URL` |
| `MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL` | `gpt-5.6-luna` | OpenAI 兼容模型 id；可覆盖为网关支持的其他模型 |
| `MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY` | `OPENAI_API_KEY` / `~/.codex/auth.json` | OpenAI 兼容网关 key；专用变量优先，其次环境变量，最后读取 `$HOME/.codex/auth.json` |
| `MULTIREMI_PROGRESS_SUMMARY_MAX_DIGEST_CHARS` | `12000` | 压缩视图字符预算 |
| `MULTIREMI_PROGRESS_SUMMARY_TIMEOUT_MS` | `30000` | 单次模型调用超时 |

## 消费端

- 前端：Issue 页 agent-live-card 在运行行下方展示一行摘要（`progress_summary`）。
- CLI：`remi issue runs <issue-id> --output table` 的 `PROGRESS` 列（含 `[step/total]` 前缀）。
- API：`/api/issues/:id/task-runs`、daemon 任务 wire 均已携带 `progress_summary/step/total`。

## 测试

- `tests/unit/daemon/progress-summarizer.test.ts`：触发计数 / 防抖 / 摘要压缩 / 凭证解析 / 单飞 / 失败隔离 / 终态 / 零配置 OpenAI 默认链 / OpenAI→API→CLI 降级 / CLI 超时。
- `tests/unit/multiremi/store-tasks-repo.test.ts`：终态任务仅接受 `final` 摘要写入。
