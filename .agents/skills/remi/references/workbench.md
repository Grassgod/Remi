# 收件箱、通知、收藏与用量

## 收件箱与提醒

```sh
remi inbox summary --json
remi inbox list --json
remi inbox page --help
remi inbox unread-count --json
remi notification get --json
remi notification channel list --json
remi notification delivery list --json
```

收件箱属于当前工作区和当前接收者，不通过指定另一个 member ID 查看别人的收件箱。read 标为已读，archive 收起通知，不等于完成对应 Issue、回答人类请求或批准提案。用户要求处理工作时沿项目/Task/提案链接完成实际动作。

`inbox mark-all-read`、`archive-all`、`archive-all-read`、`archive-completed` 含批量写入语义，先看列表和汇总确定范围。分页按目标命令返回的 cursor/分页契约继续；只读一页时不能声称“没有其他待办”。

通知偏好用 notification update，出站渠道用 notification channel create/update/delete。消息采集 Source 与通知发送 channel 不是同一对象。`notification delivery retry` 会再次发送投递，先看原投递状态并确认用户要求重试，不能用它探测渠道配置。

## 收藏与工作台

```sh
remi pin list --json
remi pin create --help
remi pin reorder --help
remi dashboard agent-activity --json
remi dashboard agent-runs --json
remi dashboard agent-tasks --json
```

pin 管理收藏资源，Chat 自己的 pin/unpin 管理会话置顶；按用户所指位置选择。重排先取得完整现有列表，按当前 JSON 契约保留其他收藏，不能用缺项列表假装只挪动一个资源。

## 使用量与账务

```sh
remi dashboard usage daily --json
remi dashboard usage by-agent --json
remi dashboard runtime daily --json
remi dashboard agent-runtime --json
remi billing balance --json
remi billing transaction list --json
remi billing topup list --json
remi billing tier list --json
```

汇报用量时注明工作区、时间范围、时区及返回单位。Agent 运行数、Runtime 活跃时长、token 用量、账户交易属于不同统计口径，不能相加或把其中一种冒充付费金额。当前帮助未提供时间筛选时，按返回时间字段筛选并说明可见数据范围，不能杜撰 `--from/--to`。

billing 是人类账户能力；自托管或未启用计费的实例可能不可用，不因错误而推断零余额。checkout create 创建支付会话，checkout get 查询该会话，portal create 创建账务门户；仅在用户要求相应账务流程时操作。获取支付 URL 不代表已支付，也不自动授权完成付款。
