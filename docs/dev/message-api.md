---
title: Message、Inbox 与 Turn HTTP 接口
status: active
summary: S5 页面可使用的统一消息、收件箱、轮控制和 message_id 卡片接口。
---

# Message、Inbox 与 Turn HTTP 接口

MUL-508 的分支接口，由 [unified router](../../packages/server/src/api/routers/unified.ts) 调用 [Store](inbox-store.md)。这些接口在集成分支可用，生产是否已切换以部署版本为准。公共模型来自 [unified-model.ts](../../packages/contracts/src/unified-model.ts)。CLI 为 `message`、`inbox`、`turn` 三个域。

## 身份与响应

使用现有 Authorization 和工作区选择机制。人的 sender 从当前活跃成员解析；task token 的 sender 和 source_turn_id 从当前 attempt 解析。请求体不能指定 sender、source_turn_id、visibility 或执行权限。跨工作区资源不可见，Chat 保留创建人边界；精确绑定该 Chat 当前 attempt、agent 和工作区的 task capability 可读写本 Chat，即使令牌的用户是共享 Runtime owner。其他 Chat 和不相关任务仍拒绝。轮详情与 trace 还保留来源任务的可见性检查，Chat 轮只接受自身任务能力。

发送到 agent 时，无论直接收件人还是角色解析后的最终 agent，都执行与旧任务派发一致的访问检查；拒绝会回滚消息、轮和附件。human request 及其答复沿用来源任务/agent 可见性，在 message 单条、列表、范围、inbox 和展示读取中一致过滤；答复被拒绝不会消费 pending 提问或恢复 awaiting_human 轮。共享 agent 的提问仍允许有权的活跃成员答复，不限于原收件人。

没有来源轮的普通成员 decision，其选项和结构化 response 答复按会话权限可见。`metadata.human_response` 本身不代表私有 task 来源；答复关联的原提问有来源任务时仍沿来源鉴权，受保护来源无法解析时仍隐藏。

消息响应为 UnifiedMessage 的字段，加 `attachments` 和 `reactions`；不返回任何 `card_token_*` 字段。附件与反应沿用 Store 的 camelCase 对象，附件下载使用 `/api/attachments/:id/download`，内联内容使用 `/api/attachments/:id/content`。`task_id` 是统一轮 ID，执行 trace 使用 attempt ID。失败返回 `{error}`，参数错误 400，权限错误 403，不可见或不存在 404，已消费编辑、普通 decision 或 human request 的重复回答和非法轮状态 409。

task token 在统一鉴权入口核对绑定的 attempt 是否仍是所属轮的 current_attempt_id，并核对 agent 和工作区；替换 attempt 时在同一事务撤销旧 token，旧 token 的所有入口返回 401。parent_owner 只解析同工作区父单；最终会话或 Issue 不属于发送工作区时拒绝并回滚全部写入。

网页 `/ws` 的 log 冷回放、补洞、entry 与 patch 使用同一来源规则与字段脱除；Chat 会话、WS 订阅和附件都要求创建人仍可访问该 agent。auto_* 和 auto_orphan_inbox_* 的订阅沿用 HTTP 工作区成员边界。每批 WS 投影重新检查会话权限；无权行仅发送序号和版本的隐藏标记，具体协议见[浏览器实时 v2](realtime-v2.md)。

## Message

| HTTP | 输入 | 响应 |
|---|---|---|
| `POST /api/sessions/:sessionId/messages` | 下面的发送体 | `{message,wake_applied,wake_reason,turn_id?}` |
| `GET /api/sessions/:sessionId/messages` | `limit=1..500`，默认 100；`cursor` 或 `after_seq`；`message_kind`、`thread`、`unread_by=<agentId>` | `{messages,next_cursor}`，按 seq 升序；cursor 为 seq 的十进制字符串 |
| 同上，范围读取 | `from`、`to`；续页使用原响应 `next_cursor` | `{entries,next_cursor,read_start,read_end,...}`，保留 [ADR 0016](../adr/0016-unified-message-inbox-and-turn.md) 的范围协议 |
| `GET /api/messages/:id` | 无 | `{message}`，可读 tombstone |
| `PATCH /api/messages/:id` | `{body_md}` | `{message}`；仅原发送人，已消费或部分消费拒绝 |
| `DELETE /api/messages/:id` | 无 | `{message}`；同样仅原发送人、未消费；重复删除幂等 |
| `POST /api/messages/:id/resolve` | `{resolved:true}`，缺省 true | `{message}`，false 取消解决；decision、human request/response 返回 409，必须走答复状态机 |
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

decision 可带 `options:[{label,value}]`。回答使用同一个发送端点，设置 `reply_to_id` 指向 decision，kind 为 reply；选择值放 `metadata.selected_options:[value]`，服务端验证选项并调用 answerMessageDecision。body_md 可为空。permission 的单个选择必须匹配 payload.options[].optionId，并规范化为 `response.option_id`；单题 question 的单个选择必须匹配该题选项 label，并规范化为 `response.answers:{问题:答案}`。单题正文答复也转为 answers。多题必须传 `response:{answers:{...}}`，包含每个问题的非空字符串答案；CLI 用 `message send <conversation> --reply-to <message> --response '{"answers":{"问题一":"答案一","问题二":"答案二"}}'`。permission 也可传 `--response '{"option_id":"allow_once"}'`；--response 与 --option 互斥。无效或不完整结构在消费请求前返回 400。既有 agent 裁决的 reason/overturn 也放 response。答复、原消息解决、恢复等待轮、活动及卡片更新在同一事务内；重复答复规则见下文。

有显式 Issue 来源的 decision 保留成员改判行为：已 answered 的决定可由成员通过同一 reply 入口再次答复，每次追加 history、更新 answeredAt，并记录一条新 reply；source owner 收到答复通知，上次答复来自 agent 时 parent owner 另收到 decision_overturn，已有飞书卡片每次改判排一条 patch，并等待上一条发送结束，避免旧答案覆盖新答案。agent 仅可答 pending，withdrawn 返回 409。普通 decision 和 human request 答过后仍返回 409；卡片回调仍是一次性答复，重放不追加 history。

正文或附件至少有一种。上传为 multipart：`message` 是发送体的 JSON 字符串，重复 `file` 字段为 File；文件类型/20MB 上限沿用 Chat 验证。已有附件使用 `attachment_ids`，必须可访问、同工作区且未绑定另一条消息。文件和元数据随发送失败回滚；幂等重发不会留下多余上传文件。decision 回答不接受附件。

附件绑定到最终目标的 Issue 或 Chat；auto_* 对话本身不接受附件，需在关联的 Issue 或 Chat 上传。

普通列表不推进读游标。范围为 `(from,to]`，不能和普通列表筛选或 limit 混用；服务端保留长正文条内分页、排除 task agent 自己的历史与连续高水位推进，页面必须按 next_cursor 读完，不能自行构造 cursor。

SSR 和本地副本继续使用只读展示协议：`GET /api/sessions/:sessionId/log?anchor=&before=&after=` 返回 head、轮卡片、head_seq/log_version、前后分页标记及消息附件/反应 sidecar；`GET .../log/locate?id=` 返回 seq/head_seq；`GET .../log/entry?seq=` 或 `?id=` 展开一条展示记录及 delivered。它们使用新消息/轮的 canonical projection，保留展示 wire，不推进读游标。/log 带 from 或 to 返回 400，提示改用 `remi message list <conversation> --from <seq> --to <seq>`。Issue activity 仍由现有 Issue 详情读取协议提供。CLI 的旧 session log 命令继续本地退役；CLI 的范围读只走 messages GET。三条展示 GET 登记为 pure_ui，旧写入口仍退役。

按 [ADR 0016](../adr/0016-unified-message-inbox-and-turn.md)，lane 的 `cursor_seq/cursor_offset` 是实际读取高水位，`provider_cursor_seq` 是 provider 续接/完成位置。轮完成不推进实际读游标；冷 bootstrap 被接受后实际进度清零，完整 inline 输入与范围读取再推进它。范围读取绑定当前 attempt，拒绝或准备 bootstrap 不清零。人的 inbox 使用自己的 member lane，页面不要用 agent 游标推断用户阅读状态。

## Inbox

| HTTP | 输入 | 响应 |
|---|---|---|
| `GET /api/inbox` | `workspace_id`、`limit=1..500`、`cursor` | `{items,unread_count,attention_count,next_cursor}` |
| `POST /api/inbox/read` | `{session_id,to_seq?}` | `{session_id,cursor_seq}` |
| 同上，全部已读 | `{all:true}`，与 session_id/to_seq 互斥 | `{conversations_read}` |

人的收件箱只查当前成员，task token 查当前 agent，不能代查其他身份。items 是所有可见对话中发给自己的未读消息，按 created_at/id 降序，cursor 是服务端返回的 opaque 字符串。计数覆盖所有可见消息，不随分页变化，使用与 items 相同的逐行来源及 decision 工作区关系规则。attention 为非 inbox_only 且未解决的 decision、成员 request、失败/取消状态或失败/阻塞/取消结果；解决不会自动标读。已读游标只前进，不越过 log head；to_seq 和缺省已读只推进到上界内发给当前身份的最后一条可见消息。read-all 对只有隐藏行的会话不计数、不推进游标。agent lane 按 execution_scope 分别读取。

统一消息提交后发射工作区级 `inbox:new`；单对话已读发射 `inbox:read`，全部已读发射 `inbox:batch-read`，人的入口和 agent 入口均覆盖。新增索引事件只带 `payload:{index_only:true}`，不包含私有正文、会话标识或客户端计数。S5 应据事件重新查询新 inbox 缓存；无需订阅某一会话 log，也不要从事件猜计数。它们经 Store 的最外层 after-commit 和现有 realtime fanout/peer 通道发送，同工作区其他标签页可收到；回滚与幂等发送不发新增消息事件。旧通知生产者的既有 `inbox:new` payload 仍然存在。

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

input 为 `{from_seq,to_seq,messages,legacy_prompt}`，读取完整绑定范围，不因超过 1000 条而截断。attempts 按 attempt_no 升序。status 为 pending/running/awaiting_human/completed/failed/cancelled。列表 limit 默认100、上限500；cursor 为 opaque 字符串。retry 要求带 organizer:supervisor scope 的当前 supervisor task 凭证，旁支会话不能重试；不满足返回 403。retry 不新增轮、不改变 Issue、不补造用户消息；不可重试状态返回409。trace attempt 必须属于指定轮，原 TraceReadResult 的可用性、分页及断档字段保留。

AgentTask 的 `id` 仍为 attempt ID；既有 `/api/agent-task-snapshot` 和 `/api/agents/:id/tasks`（含 native 对应端点）同批返回 `turn_id`。该字段直接来自 execution read projection 的 canonical turn 映射，不额外逐条查询。全局任务日志使用 `/api/turns/:turn_id/trace?attempt_id=:id`，历史 attempt 也保留所属 turn_id，不可把两类 ID 互换。

`autopilot run-now` 仍使用既有 trigger API/CLI，写入 auto_* 对话的 request，并复用 Store 创建执行轮；Issue 执行模式在实际 Issue 会话执行，auto_* request 带关联 turn/session，供历史展示。

## 飞书宿主

按钮只携带 `{t,message_id}`，不使用 task_id/issue_id 路由。宿主专用 daemon token 调用 `GET /api/daemon/messages/:id`、`POST /api/daemon/messages/:id/card`、`POST /api/daemon/messages/:id/answer`。GET 返回 `{message,request,decision}`；card 接受 `{recipient_open_id}`，用于轮内提问；Issue 裁决卡由话题 outbox 投递。answer 接受 `{token,operator_open_id,answer}` 或 `{token,operator_open_id,response}`。token 绑定实际收件人，答复必须映射为活跃工作区成员；answerMessageDecision 原子消费 token 并发送一条 reply。页面用普通 message 发送端点回答，无须也不能领取 daemon 卡片凭据。

实现验证入口为 [unified-api.test.ts](../../tests/unit/multiremi/unified-api.test.ts)、[卡片 token 回归](../../tests/unit/multiremi/multiremi-question-card-token.test.ts) 和 [CLI 用例](../../tests/unit/remi/cli-unified.test.ts)。
