# Chat、消息、收件箱与轮

## Message

```sh
remi chat list --json
remi chat get <chat> --json
remi chat create --agent <agent> --project <project> --json
remi message list <chat> --json
remi message send <chat> --to <agent> --kind request --content-file <request.md> --json
remi message send --attachment <report.html> --content "<summary>" --json
```

继续已有话题先读取对应 Chat。项目与 `--runtime-workspace` 是互斥工作位置，选择见 [Runtime](runtimes.md)。同一对话里同一 agent 接着原会话；不同工作用不同对话。发送响应记录消息 ID、实际叫醒结果和关联 turn ID。未指定收件人是普通发言。

正在跑的轮收到定向的 `now` 消息会插话；有待办轮时合并进该轮。查看未读输入用 `message list <chat> --unread-by <agent>`，未读消息可 `message edit <message> --content-file <file>` 或 `message delete <message> --yes`；按消息顺序读取。`pin/unpin` 管置顶；`archive` 停止未完成运行并使 Chat 只读，`restore` 恢复。

Chat 与 Issue 各有自己的对话。项目资源、目录准备和失效行为见 [Chat 契约](../../../../docs/chat.md)。不要为读取状态再发一次工作请求。

## Inbox

```sh
remi inbox --json
remi inbox read <conversation> --to <seq> --json
remi inbox read-all --json
remi message send <conversation> --reply-to <decision-message> --option "<actual-answer>" --json
```

收件箱是发给当前接收者的消息和每条对话的读游标。读取游标只前进，不代表完成 Issue 或回答决定。读清 decision 消息及选项后提交用户实际答案，不编造批准。

## Turn

```sh
remi turn list --chat <chat> --json
remi turn get <turn> --input --attempts --json
remi turn trace read <turn> --json
remi turn wrap-up <turn> --json
remi turn cancel <turn> --yes --json
remi turn retry <turn> --cold --yes --json
```

轮是执行单位，尝试记录机器、模型、trace 和失败证据；重试只新增尝试。诊断结合输入、当前尝试、trace 和 Runtime 心跳，不能把请求成功当完成。汇报只摘取与问题相关的私密输入；失败保留真实错误和可继续的 ID。
