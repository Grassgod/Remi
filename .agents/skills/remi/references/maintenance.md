# Runtime 与平台运行维护

## 从原失败操作定位

```sh
remi context --json
remi platform health --json
remi platform ready --json
remi platform realtime --json
remi runtime list --json
remi daemon list --json
remi daemon get <daemon-id> --json
```

分别检查 API 可达性、服务就绪、实时通道、Runtime 最近心跳和正在执行的任务；记录版本、时间及用户实际失败入口。health 成功不证明登录、WebSocket、目录浏览或模型执行成功；最终重新验证原操作。provider 与目录诊断见 [Runtime](runtimes.md)。

## 本机 daemon 与远端机器

```sh
remi daemon status
remi daemon logs
remi daemon start --help
remi daemon service --help
remi daemon retirement-plan <daemon-id> --json
```

daemon list/get 读服务器记录，status/logs/start/stop/restart/service 操作**命令所在机器**，全局服务器地址不会将本地 start 变成远程启动。先核对 daemon ID、所属机器、配置文件、运行账号与 provider；在远端机器上执行其生命周期命令。

本地生命周期沿旧 dispatcher，Registry 帮助可能只显示命令名，不能假设它接受 `--json`、`--file` 或通用参数。服务安装/卸载的子参数按该版本实现和平台说明确认；不要在已有服务旁再起一个重复 daemon。

Windows 需检查任务计划程序服务账号、实际可执行路径、PATH 与配置；macOS/Linux 需核对 launchd/systemd 或实际采用的服务管理方式。交互终端可运行不代表后台服务拥有相同环境和网络权限。通过 SSH 前台启动仅是临时恢复，断开后和服务接管后的新心跳仍需核验；不能通过伪造心跳将离线状态改成在线。

retirement-plan 是机器退役的影响预览；retire 会处理该机器及关联 Runtime 的退役，不是本地 stop。用户明确要退役时先读计划，再按 retire 帮助执行并检查关联资源。

## 平台更新、重启与回滚

```sh
remi platform status --json
remi platform operation list --json
remi platform release latest <release-metadata-filename> --json
remi platform operation create --help
remi platform operation cancel --help
```

status 需要目标部署的管理权限，可显示当前 release、driver、updater 心跳、服务与 activeOperation。release latest 读取指定文件的发布元数据，需要目标发布实际使用的文件名。`platform release version` 查 CLI 最新发布版本，`remi --version` 查当前本机 CLI，平台 currentRelease 又是另一个版本，三者不能混用。

平台操作 kind 支持 `check_updates|restart|update|rollback`，update/rollback 需要 `targetRef` 或 `targetVersion`。请求用已核对字段的 JSON 文件；例如用户要求重启平台时：

```json
{
  "kind": "restart"
}
```

```sh
remi platform operation create --file <operation.json> --yes --json
remi platform operation list --json
remi platform status --json
```

`--yes` 只满足 CLI 的确认参数，用户已有的重启/更新授权仍是前提，不重复询问已授权动作。202 表示操作排队，需按 operation ID 看终态和运行版本；updater 离线时报告等待原因，不重复建操作。update/rollback 默认等活动任务排空，draining 可能是正常等待；先查任务，不擅自强杀。用户要求取消时用 `platform operation cancel <operation> --yes`，再读状态确认。

平台更新、当前机器 CLI 更新和发布新版本是不同动作。不要用旧顶层 update alias 代替明确的目标操作；新部署、镜像构建和发版需要该部署的真实说明。故障反馈可从 platform feedback 帮助提交，内容保留脱敏的复现和版本，不上传完整配置或凭据。
