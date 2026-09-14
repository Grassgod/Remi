# 工作区、项目与仓库

## 工作区设置

```sh
remi workspace list --json
remi workspace get <workspace-id> --json
remi workspace update --help
remi workspace prompt get <workspace-id> --json
remi workspace prompt update --help
```

工作区命令里的位置参数是被操作的工作区；全局 `--workspace` 是请求上下文，保持二者一致。设置的影响范围大于单个云友，更新时保留没有要求改变的字段。

公共提示词有 bootstrap 和 delta 两部分。先 get 得到当前内容及版本，修改对应部分；`workspace prompt update` 支持 `--bootstrap-prompt`、`--delta-prompt`、`--expected-revision` 和 JSON 文件。发生版本冲突时重读并合并，不去掉版本条件覆盖别人刚写的内容。Agent 的个性化 instructions 不应全塞进工作区公共提示词。

按需检查其他配置入口：

| 配置 | 帮助入口 | 核验 |
|---|---|---|
| 共享环境变量 | `remi workspace env update --help` | `workspace env get`；结果可能含密钥，私下处理 |
| 工作区 Claude / Codex 网关 | `remi workspace relay update --help` | `workspace relay get`；另查目标 Runtime 是否有覆盖 profile |
| Runtime 预配置 | `remi workspace runtime-provision create --help` | 对应 provision 的 `get` 和 `states` |
| 飞书工作区 bot | `remi workspace feishu-bot set --help` | 配置读回、测试及 deploy/status 是不同阶段 |
| 消息来源白名单 | `remi feishu source update --help` | `source get/status`；空白名单不代表接收所有来源 |

环境变量 update 是映射替换，保留其他键后再写。`workspace relay reveal` 会取出敏感内容，不把它当作例行只读探测。只配置一个 Runtime 的模型时，使用它的 profile；不要顺手改整个工作区网关。

## 项目和仓库资源

```sh
remi project list --json
remi project get <project-id> --json
remi repo list --json
remi repo get <repo-id> --json
remi project resource list <project-id> --json
```

项目保存协作目标、指令和资源关联；导入的仓库是独立的工作区资源。先查是否已有对应 URL / 项目，再创建，避免一次重试产生多个同名对象。

```sh
remi repo inspect --help
remi repo create --help
remi project create --title "Documentation" --repo <repo-id> --json
remi project get <project-id> --json
remi project resource create --help
remi project update --help
```

`repo inspect` 的参数契约与 Git 可达性以当前帮助为准；不要仅靠 URL 拼写就认定已导入成功。`project create --repo` 关联已经导入的仓库。操作现有项目的资源使用 `project resource create/update`，保留其他关联。

`repo list/get` 查询平台记录，`repo checkout` 会访问 Git 并修改本地检出。只有任务确实需要仓库文件时才检出；不要用 checkout 验证导入记录。默认分支以仓库配置为准，不硬编码 `main`；指定 `--ref` 时失败不能偷偷换分支。

用户要求处理某台机器的已有目录时，转到 [Runtime 工作目录](runtimes.md)，无需先创建项目或导入仓库。选择项目也不意味着每个云友永久绑定同一个工作位置。
