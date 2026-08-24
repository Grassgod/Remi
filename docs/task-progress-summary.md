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
- **传输**：默认 `auto` 先调用 Anthropic Messages API。部分 workspace Relay 只放行真实 Claude Code 客户端，
  API 返回 HTTP 4xx/5xx 后会在当前任务内切换并记住使用 `claude -p`，避免每次摘要重复撞网关；
  CLI 使用任务 provider env、独立临时 cwd 和同一超时预算。机器没有 `claude` 二进制时保留原 API 行为。
- **凭证**：复用任务自身的 provider 配置（workspace Relay 下发的 `ANTHROPIC_BASE_URL/AUTH_TOKEN`，
  或本机 `~/.claude/settings.json` 的 env），否则回退 daemon 进程环境变量；都没有则本任务禁用摘要。
- **隔离性**：摘要调用 fire-and-forget，与主循环并行；失败只打日志，不影响任务执行；
  同一任务同时最多一个在途调用。

## 配置（daemon 环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MULTIREMI_PROGRESS_SUMMARY_DISABLED` | （未设置） | `1`/`true` 关闭本能力 |
| `MULTIREMI_PROGRESS_SUMMARY_MESSAGES` | `20` | N：触发一次摘要所需的新增消息数 |
| `MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS` | `45000` | T：两次摘要之间的最小间隔（防抖） |
| `MULTIREMI_PROGRESS_SUMMARY_MODEL` | `claude-haiku-4-5-20251001` | 摘要模型 id（Relay 场景按网关支持的模型配置） |
| `MULTIREMI_PROGRESS_SUMMARY_TRANSPORT` | `auto` | `auto`：API 遇 HTTP 错误后切 CLI；`api`：只用 Messages API；`cli`：优先 Claude CLI，二进制缺失时回退 API |
| `MULTIREMI_PROGRESS_SUMMARY_MAX_DIGEST_CHARS` | `12000` | 压缩视图字符预算 |
| `MULTIREMI_PROGRESS_SUMMARY_TIMEOUT_MS` | `30000` | 单次模型调用超时 |

## 消费端

- 前端：Issue 页 agent-live-card 在运行行下方展示一行摘要（`progress_summary`）。
- CLI：`remi issue runs <issue-id> --output table` 的 `PROGRESS` 列（含 `[step/total]` 前缀）。
- API：`/api/issues/:id/task-runs`、daemon 任务 wire 均已携带 `progress_summary/step/total`。

## 测试

- `tests/unit/daemon/progress-summarizer.test.ts`：触发计数 / 防抖 / 摘要压缩 / 凭证解析 / 单飞 / 失败隔离 / 终态 / API→CLI 降级 / CLI 超时。
- `tests/unit/multiremi/store-tasks-repo.test.ts`：终态任务仅接受 `final` 摘要写入。
