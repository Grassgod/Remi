# Chat、队列与 Task

## 开始或继续会话

```sh
remi chat list --json
remi chat get <chat-id> --json
remi chat message list <chat-id> --json
remi chat create --agent <agent-id> --project <project-id> --json
remi chat message create <chat-id> --content-file <request.md> --json
```

继续已有话题先读取对应 Chat；用户要求新的会话时才 create。项目与 `--runtime-workspace` 是互斥工作位置，选择见 [Runtime](runtimes.md)。create 保存会话，message create 发送工作内容并可能启动执行，记录返回的 Task ID。

`chat issue bind <chat> <issue>` / `unbind` 管理绑定；`chat issue updates get/enable/disable` 管理是否把 Issue 更新送入 Chat，绑定本身不代表自动更新已启用。`pin/unpin` 只改变置顶，`archive` 会停止未完成运行并使 Chat 只读，`restore` 恢复可用状态；不要用 archive 实现“稍后再看”。

## 排队消息和正在运行的任务

```sh
remi chat pending <chat-id> --json
remi chat queue list <chat-id> --json
remi chat queue update <chat-id> <queued-task-id> --content-file <revised-request.md> --json
remi chat queue list <chat-id> --json
remi task get <task-id> --json
remi task inspect <task-id> --json
remi task message list <task-id> --json
remi task steer --help
```

queue update 只编辑未开始的排队消息；remove/clear 移除排队工作；**queue prioritize 会停止当前执行，再让选中消息优先执行**，不是仅重排展示列表。正在执行的补充指令使用 task steer，并读回 steer list；任务取消使用 task cancel。不要为了追问进展再发一次 message create。

Task 的 prompt、消息和 human request 可能包含用户私密内容或模型上下文，汇报只摘取与问题相关的部分。`task inspect` 是诊断元数据，应与最新消息、状态及 Runtime 心跳一起判断，不能单独证明执行健康。

## 独立任务与人类请求

```sh
remi task create --agent <agent-id> --prompt "<requested-work>" --json
remi task get <task-id> --json
remi task request list <task-id> --json
remi task request respond --help
```

独立执行用 task create；有关联的工作保留已确认的 `--issue` 或 `--chat`。不要猜 Task 有直接本地目录参数；需要持久工作位置时从已配置的 Issue / Chat 发起。

遇到人类请求先读取该 request 的类型、选项和状态，再把用户实际答案按当前响应契约提交到 `task request respond <task> <request> --file ...`。不能因任务等待就代替用户批准或编造输入。`task redispatch` 是 task 身份的专用能力，不作为人类操作的通用重试入口。

收尾核对 Task 终态、最终消息或成果；失败保留真实错误和可继续的 ID。响应丢失先查询关联 Chat、Issue runs 或已有 Task，避免重复提交。Runtime 在线、请求 200、成功保存配置都不能代替执行完成。
