# Runtime、模型连接与本地目录

## 查清执行机器

```sh
remi runtime list --json
remi runtime get <runtime-id> --json
remi runtime model list <runtime-id> --json
remi runtime task-activity <runtime-id> --json
```

Runtime 是某台 daemon 提供的执行能力，Agent 是工作区里的云友定义。修改云友模型与配置模型提供商连接是不同操作。核对 provider、归属机器、心跳新鲜度和活动任务；仅 `status: online` 或 SSH 可达不能证明目录扫描或执行已经恢复。

## Codex / Claude 自定义连接

连接属于 Runtime，由人类配置；任务凭据不能管理它。先查询现值与帮助：

```sh
remi runtime codex-profile get <runtime-id> --json
remi runtime codex-profile set --help
remi runtime claude-profile get <runtime-id> --json
remi runtime claude-profile set --help
```

只对匹配 provider 的 Runtime 执行相应命令。Codex 需要 Responses 兼容接口；Claude Code 需要 Anthropic Messages 兼容接口，不把任意 OpenAI chat/completions 接口当作二者通用入口。先让用户确认服务商协议、基础地址和模型 ID。

保存 API key 的 Codex 请求文件：

```json
{
  "profile": {
    "name": "custom-codex",
    "base_url": "https://gateway.example/v1",
    "model": "provider-model-id",
    "auth_mode": "api_key",
    "env_key": ""
  },
  "api_key": "<user-supplied-api-key>"
}
```

```sh
remi runtime codex-profile set <runtime-id> --file <private-codex-profile.json> --json
remi runtime codex-profile get <runtime-id> --json
```

Claude 请求的连接字段相同，另外指定 `auth_header`：

```json
{
  "profile": {
    "name": "custom-claude",
    "base_url": "https://anthropic-compatible.example",
    "model": "provider-model-id",
    "auth_mode": "api_key",
    "env_key": "",
    "auth_header": "x-api-key"
  },
  "api_key": "<user-supplied-api-key>"
}
```

```sh
remi runtime claude-profile set <runtime-id> --file <private-claude-profile.json> --json
remi runtime claude-profile get <runtime-id> --json
```

`auth_header` 可为 `bearer` 或 `x-api-key`，按服务商要求选择；缺省是 bearer。不要把凭据塞进 `profile` 内、URL 用户信息或 query。`name` 只用字母、数字、下划线、连字符；`base_url` 是 HTTP(S) 基础地址，无 query 或 fragment。

已有密钥时省略顶层 `api_key` 表示保留；首次使用 `api_key` 模式需提供密钥。读回不返回明文；`credential_id` 是服务端管理的版本引用，不是用户生成的 API key。

若密钥已配置在 Runtime 的 **daemon 进程环境**，使用 `auth_mode: "env"`，省略 `api_key`。Codex 的 `env_key` 必须为 `REMI_CODEX_*`，Claude 必须为 `REMI_CLAUDE_*`。例如 Codex 的完整 `profile` 可用：

```json
{
  "profile": {
    "name": "runtime-env",
    "base_url": "https://gateway.example/v1",
    "model": "provider-model-id",
    "auth_mode": "env",
    "env_key": "REMI_CODEX_PROVIDER_KEY"
  }
}
```

不要只在运行配置 CLI 的机器上设置该变量，或假设交互终端的变量会自动进入后台 daemon。若需要改变 daemon 启动环境，先确认实际服务管理方式和重启影响；本 Skill 不擅自安装另一套后台服务。

清除自定义连接的请求体为 `{"profile": null}`，通过相应的 `*-profile set --file` 提交，恢复工作区网关。清除与删除 Runtime 无关。

保存后读回 profile，等待该 Runtime 后续心跳应用，再检查模型目录。任务保存自己的连接快照，已有任务不随配置变更自动切换。只有用户要求验证执行时才创建最小测试任务或 Chat，并检查终态；模型出现在目录里仅证明配置或发现成功，不证明接口调用成功。

## 本地工作目录

`remi workspace` 是团队租户；`remi runtime workspace` 是 daemon 所属机器上的持久执行目录。目录不要求是 Git 仓库。

```sh
remi runtime workspace list --runtime <runtime-id> --json
remi runtime workspace create <runtime-id> --name "Local workbench" --root <absolute-remote-directory> --cwd . --json
remi runtime workspace get <runtime-workspace-id> --json
remi runtime workspace rename <runtime-workspace-id> --name "Research" --json
```

根目录必须已经存在于该机器；`cwd`、`--context-path`、`--env-file` 相对根目录。注册不创建目录、不 clone 仓库、不切分支。目录配置创建后固定，改变路径需新建记录；重命名不移动文件。

需要浏览时，提交 `{"root":"~","mode":"browse"}` 的扫描 JSON，然后轮询返回的 request ID：

```sh
remi runtime directory scan <runtime-id> --file <directory-scan.json> --json
remi runtime directory status <runtime-id> <request-id> --json
```

目录扫描会创建异步请求，但不创建目录；这是用户要求浏览或排查目录时的适当验证。等到完成后使用返回的绝对路径，不复用失败扫描的旧结果。

项目与本地目录是 Issue / Chat 工作位置的两个互斥选项，按本次任务选择，不写成 Agent 永久默认。同时传 `--project` 和 `--runtime-workspace` 会被拒绝。已有任务的执行绑定不能随意更换；Chat 换目录时创建新的 Chat。

## 磁盘占用与回收

daemon 上的代码目录和运行环境是缓存：Issue 或 Chat 结束后超过保留期被回收，回收前为未保存的工作打快照，重开时恢复；trace 与原生会话历史不回收。保留策略是工作区设置（见 [工作区与项目](workspaces-and-projects.md)），本节命令查看和触发回收。

```sh
remi runtime storage <runtime-id>
remi runtime gc <runtime-id> --dry-run --wait
remi runtime gc-status <runtime-id> <request-id>   # 读取未带 --wait 创建的回收请求
```

`runtime storage` 读该 Runtime 所在 daemon 最近一份存储报告：占用（daemon 后台每小时测一次，行尾标出测量时间）、主体数、保留原因、上一轮释放量；daemon 从未上报时没有报告。`runtime gc --dry-run --wait` 只生成计划，列出每个主体将被回收还是保留及原因。`runtime gc`（含 `--dry-run`）都会创建回收请求，需要人类 owner/admin 凭据，任务凭据会被拒绝，任务内只能读 `runtime storage`。不带 `--dry-run` 的 `runtime gc <runtime-id> --yes --wait` 真正回收一轮，只在用户要求释放磁盘并看过预演清单后由人类执行。出现 `snapshot_failed` 等保留原因说明有需要人工处理的未保存工作，不要强行清理目录；`legacy_retained` 是升级清扫留在 `legacy-<日期>/retained/` 的旧 worktree 个数，由运维核对后手工删除，daemon 不会自动清。

## 离线排查边界

Runtime 在线只证明近期登记状态；目录请求和 provider 执行仍需独立检查。daemon 本机生命周期、后台服务环境、SSH 临时恢复与平台升级见 [运行维护](maintenance.md)，不要从某个 Runtime 离线直接推断整个平台需要重启。
