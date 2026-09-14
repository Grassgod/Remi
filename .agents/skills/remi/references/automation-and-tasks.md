# 自动化与团队

## Squad

```sh
remi squad list --json
remi squad get <squad-id> --json
remi squad member list <squad-id> --json
remi agent list --json
remi squad create --name "Review team" --leader <agent-id> --json
remi squad member add <squad-id> <agent-id> --type agent --role reviewer --json
remi squad member list <squad-id> --json
```

先确认 leader 与成员的真实 Agent ID、可执行 provider 和职责；平台的人类成员与 Agent 成员用不同的 `--type`。建队或加成员不等于已经派单，读取团队定义与成员列表分别核验。

## Autopilot

```sh
remi autopilot list --json
remi autopilot get <autopilot-id> --json
remi autopilot trigger list <autopilot-id> --json
remi autopilot scheduler --json
remi autopilot create --help
remi autopilot trigger create --help
```

先明确执行者、要做的事、时间和时区、是否创建 Issue，以及用户是否要求立即执行。自动化定义和触发器分别配置，不凭自然语言猜 cron 时区或沿用别的平台默认值。

常用定义字段为 `title`、`description`、`assignee_type`、`assignee_id`、`execution_mode`、`status`；其余字段仅按目标版本已公开的契约提供。通过 `remi autopilot create --file <autopilot.json> --json` 创建，记录返回的 ID；修改用 `remi autopilot update <autopilot-id> --file <autopilot-patch.json> --json`。

`assignee_type` 为 `agent` 或 `squad`；`execution_mode` 为 `create_issue`、`run_only` 或 `trigger_issue`；`status` 为 `active`、`paused` 或 `archived`。让已有自动化只运行任务时选择 `run_only`，需要形成新 Issue 时选择 `create_issue`；`trigger_issue` 的触发配置另有约束，不能当作通用定时执行模式。启用定时任务需要自动化 active、触发器 enabled 且调度器正常；只保存了 cron 表达式不等于会执行。

对于现有自动化，增加定时触发器的 JSON 示例：

```json
{
  "kind": "schedule",
  "cron_expression": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "enabled": true
}
```

此例是上海时区每天 09:00，只有它与用户要求一致时才使用。提交后读回触发器、自动化状态和调度器状态：

```sh
remi autopilot trigger create <autopilot-id> --file <schedule.json> --json
remi autopilot trigger list <autopilot-id> --json
remi autopilot get <autopilot-id> --json
remi autopilot run list <autopilot-id> --json
```

`schedule_targets` 的更新替换整个目标选择，`null` 清除；修改其中一个项目或仓库时先保留其余目标。Webhook 的 token / secret 不出现在报告中；重放投递与 `autopilot run` 都会实际执行，只有用户要求时才触发，不拿来当保存成功的探针。

## 运行与 Webhook

```sh
remi autopilot run --help
remi autopilot run list <autopilot-id> --json
remi autopilot trigger update --help
remi autopilot delivery list --help
remi autopilot delivery get --help
remi autopilot delivery replay --help
```

用户要求立即执行时，按 run 帮助触发一次，记录 run ID 与关联 Issue/Task，沿 [Task 查询](chats-and-tasks.md) 检查执行终态。仅要求设置定时任务时，读回定义、trigger 和 scheduler 即可，不额外跑一轮。

Webhook 使用 trigger 配置，密钥维护入口为 trigger rotate-token/set-secret，投递查询与重放使用 delivery 命令。保留 trigger ID 和 delivery ID。投递被接收、通过鉴权与派发成功是不同状态；先查投递及对应 run，再判断是否重放。调整或撤销 Webhook 时保留用户尚需使用的其他触发器。
