# SCM、消息与飞书集成

## SCM 连接与仓库

```sh
remi scm capabilities --json
remi scm connection list --json
remi scm connection get <connection-id> --json
remi scm connection create --help
remi scm connection verify <connection-id> --json
remi scm repository bind <connection-id> <repo-id> --json
remi repo get <repo-id> --json
remi scm change-request list --help
remi scm change-request link <issue-id> <change-request-id> --json
```

先查当前 SCM provider 能力，再按其凭据契约创建/更新连接。verify 会联系外部服务并更新验证状态；绑定仓库前核对同一工作区的真实 repo ID 与连接范围。Git clone 可用不代表平台 SCM token 有权限，平台仓库记录也不等于 SCM 已连接。

change-request link 关联已有变更请求与 Issue，不会创建或合并 PR。事件从 scm event list/get 查；删除连接会影响绑定仓库，先阅读 CLI 给出的影响。GitHub/GitLab 的发布、合并或发送动作仍按用户请求的实际范围执行。

## 通用消息接入

Connection 保存 provider 接入，Source 选择采集哪些会话，message/outcome 记录采集内容与处理结果。新接入优先使用通用 messaging 域；先查询支持的 provider，不猜 Slack、邮件或 webhook 一定已实现。

```sh
remi messaging provider list --json
remi messaging connection list --json
remi messaging connection add --help
remi messaging connection authorization start --help
remi messaging connection authorization get --help
remi messaging source list --json
remi messaging source get <source-id> --json
remi messaging source update <source-id> --conversation <conversation-a> --conversation <conversation-b> --json
remi messaging source status <source-id> --json
```

新增 connection 按已查询 provider 选择 `--provider` 与必要的 `--channel`。授权启动可能返回登录链接或交互步骤，等待用户完成真实授权后再查结果；不替用户伪造成功状态。

`--conversation` 可重复，但本次列表会**替换整个白名单**；增加一个会话时先保留原会话。空白名单表示不采集，`--clear-allowlist` 清空。status 核验同步健康、延迟和未处理积压；connection check 成功不等于 source 已同步到新消息。删除 source 连同消息、处理结果和游标一起删除，不用于暂时停用；停用应按字段契约设置 enabled。

## 处理消息与提案

```sh
remi messaging message list --help
remi messaging message get <connection-id> <message-id> --json
remi messaging message draft-reply <connection-id> <message-id> --draft-text "<requested-draft>" --json
remi messaging proposal list --json
remi messaging proposal approve --help
```

message ID 只在 connection 内唯一，必须保留二者。draft-reply 创建 Inbox 回复草稿，不等于已对外发送；notify 创建通知，propose-issue 创建待审核提案。批准/拒绝提案和直接 create-issue 需要人类身份；普通任务使用提案链路，不用 generic resolve 伪造专用处理结果。发送回复、产生通知或批准派单都继承用户对此动作的授权，不能仅为测试接入而执行。

## 飞书路由和 Lark 安装

```sh
remi feishu route list --json
remi feishu chat list --json
remi feishu route set chat --chat <feishu-chat-id> --agent <agent-id> --json
remi feishu route list --json
remi lark installation list --json
remi lark install begin --help
remi lark install status --help
remi lark daemon status --help
```

feishu route 管理 concierge 路由到哪个云友，messaging source 管理采集范围，workspace feishu-bot 管理工作区 bot 配置，三者不是同一层。旧 feishu source/messages 命令仍有独立 ID 空间，不能将 ID 与 messaging 任意互换；已有来源先读取原命令的记录。

Lark 安装、binding redeem 与 daemon install 是不同阶段；按返回的安装会话和绑定信息继续，不凭 installation 记录存在就声称消息已接通。已有 bot 的配置参考 [工作区](workspaces-and-projects.md)，最终以实际路由与用户请求的消息流程核验。
