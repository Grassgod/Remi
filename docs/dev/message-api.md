---
title: Message、Inbox 与 Turn HTTP 接口
status: active
summary: S5 页面可使用的统一消息、收件箱、轮控制和 message_id 卡片接口。
---

# Message、Inbox 与 Turn HTTP 接口

MUL-508 的分支接口，由 [unified router](../../packages/server/src/api/routers/unified.ts) 调用 [Store](inbox-store.md)。这些接口在集成分支可用，生产是否已切换以部署版本为准。公共模型来自 [unified-model.ts](../../packages/contracts/src/unified-model.ts)。CLI 为 `message`、`inbox`、`turn` 三个域。

## 身份与响应

使用现有 Authorization 和工作区选择机制。人的 sender 从当前活跃成员解析；task token 的 sender 和 source_turn_id 从当前 attempt 解析。请求体不能指定 sender、source_turn_id、visibility 或执行权限。跨工作区资源不可见，Chat 保留创建人边界；task token 只能控制自己的 agent 的轮。轮详情与 trace 还保留 agent 可见性检查。

消息响应为 UnifiedMessage 的字段，加 `attachments` 和 `reactions`；不返回任何 `card_token_*` 字段。附件与反应沿用 Store 的 camelCase 对象，附件下载使用现有 `/api/attachments/:id/file`。`task_id` 是统一轮 ID，执行 trace 使用 attempt ID。失败返回 `{error}`，参数错误 400，权限错误 403，不可见或不存在 404，已消费编辑、重复回答和非法轮状态 409。

## Message

| HTTP | 输入 | 响应 |
|---|---|---|
| `POST /api/sessions/:sessionId/messages` | 下面的发送体 | `{message,wake_applied,wake_reason,turn_id?}` |
| `GET /api/sessions/:sessionId/messages` | `limit=1..500`，默认 100；`cursor` 或 `after_seq`；`message_kind`、`thread`、`unread_by=<agentId>` | `{messages,next_cursor}`，按 seq 升序；cursor 为 seq 的十进制字符串 |
| 同上，范围读取 | `from`、`to`；续页使用原响应 `next_cursor` | `{entries,next_cursor,read_start,read_end,...}`，保留 ADR 0013 原范围协议 |
| `GET /api/messages/:id` | 无 | `{message}`，可读 tombstone |
| `PATCH /api/messages/:id` | `{body_md}` | `{message}`；仅原发送人，已消费或部分消费拒绝 |
| `DELETE /api/messages/:id` | 无 | `{message}`；同样仅原发送人、未消费；重复删除幂等 |
| `POST /api/messages/:id/resolve` | `{resolved:true}`，缺省 true | `{message}`，false 取消解决 |
| `POST /api/messages/:id/reactions` | `{emoji,remove?:boolean}` | `{reactions}`；当前身份，增加及移除幂等 |

发送示例：

```json
{
  "body_md": "请检查这份改动",
  "message_kind": "request",
  "to": {"type": "agent", "ref": "agt_example"},
  "wake_requested": "now",
  "dedupe_key": "review-once"
}
```

`message_kind` 为 request/reply/report/decision/status/final，缺省 request，有 reply_to_id 时缺省 reply。`to` 缺省 `{type:"none"}`；可用 agent/member/role，role 为 leader/parent_owner/delegator/issue_owner/relay。角色可能把消息写入父单或委派来源对话，应以返回的 message.session_id 为准。wake 为 now/next_turn/inbox_only，缺省 now；降级仍返回 200，使用 wake_applied/wake_reason 展示实际结果。六种降级原因见 [CLI 迁移说明](../cli-command-migration.md)。dedupe_key 在最终目标对话内唯一，重发返回同一消息与 delivery turn。

decision 可带 `options:[{label,value}]`。回答使用同一个发送端点，设置 `reply_to_id` 指向 decision，kind 为 reply；选择值放 `metadata.selected_options:[value]`，服务端验证选项并调用 answerMessageDecision。body_md 可为空但必须有选择值。需要结构化提问答复时传 `response:{answers:{...}}` 或 `response:{option_id:...}`，并提供可显示的 body_md；既有 agent 裁决的 reason/overturn 也放 response。答复、原消息解决、恢复等待轮、活动及卡片更新在同一事务内，重放返回 409。

正文或附件至少有一种。上传为 multipart：`message` 是发送体的 JSON 字符串，重复 `file` 字段为 File；文件类型/20MB 上限沿用 Chat 验证。已有附件使用 `attachment_ids`，必须可访问、同工作区且未绑定另一条消息。文件和元数据随发送失败回滚；幂等重发不会留下多余上传文件。decision 回答不接受附件。

附件绑定到最终目标的 Issue 或 Chat；auto_* 对话本身不接受附件，需在关联的 Issue 或 Chat 上传。

普通列表不推进读游标。范围为 `(from,to]`，不能和普通列表筛选或 limit 混用；服务端保留长正文条内分页、排除 task agent 自己的历史与连续高水位推进，页面必须按 next_cursor 读完，不能自行构造 cursor。

当前 S2 集成有已知的 agent 游标回归：轮完成会把 lane.cursor_seq 推到 projection_to_seq，暖续接和恢复 bootstrap 不能完整保留实际范围读取进度。`session-unread-progress.test.ts` 有 6 个失败，需 S2 修复；上述分页 HTTP 格式已定，人的 inbox 游标不受这处问题影响。页面不要用该 agent 游标推断用户阅读状态。

## Inbox

| HTTP | 输入 | 响应 |
|---|---|---|
| `GET /api/inbox` | `workspace_id`、`limit=1..500`、`cursor` | `{items,unread_count,attention_count,next_cursor}` |
| `POST /api/inbox/read` | `{session_id,to_seq?}` | `{session_id,cursor_seq}` |
| 同上，全部已读 | `{all:true}`，与 session_id/to_seq 互斥 | `{conversations_read}` |

人的收件箱只查当前成员，task token 查当前 agent，不能代查其他身份。items 是所有可见对话中发给自己的未读消息，按 created_at/id 降序，cursor 是服务端返回的 opaque 字符串。计数覆盖所有可见对话，不随分页变化。attention 为 priority<=2 且未解决的未读消息；解决不会自动标读。已读游标只前进，不越过 log head，缺省推进至该对话当前 head。read-all 只改变当前身份的可见对话。agent lane 按 execution_scope 分别读取。

旧 `/api/inbox/*` 的条目、计数、完成、批量清理等业务实现已移除；退役端点返回 410。只有上述 GET `/api/inbox` 与 POST `/api/inbox/read` 重新使用路径，响应已改成新协议，不返回旧 InboxItem 数组。

## Turn

| HTTP | 输入 | 响应 |
|---|---|---|
| `GET /api/turns` | `workspace_id`、`issue=<id或key>`、`chat=<sessionId>` 或 `session_id`、`agent=<id>`、`status`、`limit`、`cursor` | `{turns,next_cursor}`；created_at/id 降序 |
| `GET /api/turns/:id` | `input=true`、`attempts=true`，默认均不展开 | `{turn,input?,attempts?}` |
| `POST /api/turns/:id/cancel` | `{}` | `{turn}`；丢弃本轮已绑定输入并取消，已终态幂等 |
| `POST /api/turns/:id/wrap-up` | `{}` | `{turn}`；仅 running/awaiting_human，设置 wrap_up_requested_at |
| `POST /api/turns/:id/retry` | `{cold?:boolean}` | `{turn}`；原 turn.id，新 current_attempt_id，cold 清续接缓存 |
| `GET /api/turns/:id/trace` | `attempt_id` 缺省 current_attempt_id；`after_seq`、`limit` 沿用 TraceReader 协议 | `{turn_id,attempt_id,...TraceReadResult}` |

input 为 `{from_seq,to_seq,messages,legacy_prompt}`，读取完整绑定范围，不因超过 1000 条而截断。attempts 按 attempt_no 升序。status 为 pending/running/awaiting_human/completed/failed/cancelled。列表 limit 默认100、上限500；cursor 为 opaque 字符串。retry 不新增轮、不改变 Issue、不补造用户消息；不可重试状态返回409。trace attempt 必须属于指定轮，原 TraceReadResult 的可用性、分页及断档字段保留。

`autopilot run-now` 仍使用既有 trigger API/CLI，写入 auto_* 对话的 request，并复用 Store 创建执行轮；Issue 执行模式在实际 Issue 会话执行，auto_* request 带关联 turn/session，供历史展示。

## 飞书宿主

按钮只携带 `{t,message_id}`，不使用 task_id/issue_id 路由。宿主专用 daemon token 调用 `GET /api/daemon/messages/:id`、`POST /api/daemon/messages/:id/card`、`POST /api/daemon/messages/:id/answer`。GET 返回 `{message,request,decision}`；card 接受 `{recipient_open_id}`，用于轮内提问；Issue 裁决卡由话题 outbox 投递。answer 接受 `{token,operator_open_id,answer}` 或 `{token,operator_open_id,response}`。token 绑定实际收件人，答复必须映射为活跃工作区成员；answerMessageDecision 原子消费 token 并发送一条 reply。页面用普通 message 发送端点回答，无须也不能领取 daemon 卡片凭据。

实现验证入口为 [unified-api.test.ts](../../tests/unit/multiremi/unified-api.test.ts)、[卡片 token 回归](../../tests/unit/multiremi/multiremi-question-card-token.test.ts) 和 [CLI 用例](../../tests/unit/remi/cli-unified.test.ts)。
