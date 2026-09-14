# Issue、Session 与交付

## 查找、创建和派单

Issue 跟踪目标与状态，Session 组织 Issue 内的参与者、消息和成果，Task 记录一次实际执行。先定位已有工作，避免把“继续这个问题”变成重复创建。

```sh
remi issue list --json
remi issue search "<query>" --json
remi issue get <issue-id> --json
remi issue create --title "<requested-title>" --description-file <brief.md> --project <project-id> --no-project-defaults --json
remi issue assign <issue-id> --to <agent-id> --to-type agent --json
remi issue active-task <issue-id> --json
remi issue runs <issue-id> --json
```

示例创建未分配的项目 Issue；需要自动分配时按用户意图使用项目默认值或显式 assignee。**省略 assignee 会继承项目默认执行者**，`--no-project-defaults` 才表示不继承。创建响应里的派发结果与实际 Task 状态分别检查。

派给人、云友或团队时明确 `member|agent|squad`，不要仅凭同名对象猜类型。`issue assign` 使用 `--to/--to-type`，`issue create/update` 使用 `--assignee/--assignee-type`。创建、分配、状态变化、`rerun` 都可能启动工作；不能将它们当读取探针。

工作位置二选一：项目用 `--project`，Runtime 持久目录用 `--runtime-workspace`，详见 [Runtime](runtimes.md)。已执行的目录绑定不可任意移动。`issue status <issue> <status>` 改业务状态，`issue cancel-task` 取消执行，二者不能互相代替。

## 组织工作与沟通

```sh
remi issue children <issue-id> --json
remi issue child-progress <issue-id> --json
remi issue dependency list <issue-id> --json
remi issue dependency add <issue-id> <dependency-id> --type depends_on --json
remi label list --json
remi issue label list <issue-id> --json
remi comment list <issue-id> --json
remi comment add <issue-id> --content-file <comment.md> --json
```

依赖示例表示当前 Issue 依赖另一个 Issue；写前确认方向，随后 list 核验。子任务创建可用 `issue create --parent`；标签定义用 `label`，Issue 上的绑定用 `issue label`。订阅、反应、自定义字段分别从 `issue subscriber`、`issue reaction`、`issue metadata` 查帮助。

评论、回复、发布成果都是协作写入，沿用用户已有发送授权。`comment resolve` 解决一条评论，不代表 Issue 完成。批量修改先列出精确目标 ID 并读当前值；`issue batch-update` / `batch-delete` 的 JSON 不能从单条更新参数推断。`issue delete` 与 `issue restore` 的当前归档/恢复行为以目标版本帮助和返回为准，不能用批量删除整理无关任务。

## Session、成果和归档

```sh
remi session list <issue-id> --json
remi session get <issue-id> <session-id> --json
remi session task list <issue-id> <session-id> --json
remi session result list <issue-id> --json
remi session result publish <issue-id> --session <session-id> --type report --title "<result-title>" --content-file <result.md> --json
remi session archive status <issue-id> --json
```

Session get 等命令同时需要 Issue ID 和 Session ID；成果 publish 的 Session 则是选项。成果类型为 `mr|report|deploy|decision|doc|other`，发布可复用结论并附实际证据，不把未完成的运行写成成果。参与者、消息、配置从 `session participant/message/config` 按需操作。

`session archive verify/retry` 会执行校验或重试归档，不是单纯读取；先看 status 和 list，针对已有失败记录处理。Issue run-messages 接收的是 **Task ID**，也可直接使用 `task message list` 查询执行消息。

## 附件与分享

```sh
remi issue attachment list <issue-id> --json
remi issue attachment upload <issue-id> --attachment <artifact-path> --json
remi attachment download <attachment-id> --output-dir <destination-directory>
remi share get <issue-id> --json
remi share create <issue-id> --json
```

下载命令的 `--output` 是本地文件路径，不是 Registry 通用输出格式，不能加 `--json`；保存前检查同名文件。上传后用返回 ID 核对归属和下载内容。

分享 create/extend/delete 改变链接的访问能力，只有用户要求分享或撤销时操作；返回链接只交给预期接收者。持有 share 凭据不等于加入工作区，不用它做成员管理。
