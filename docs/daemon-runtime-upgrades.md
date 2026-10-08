# Daemon 与 ACP / Agent SDK 配套升级

每次发版准备时查询最新稳定依赖，验证后将版本写入 [runtime-versions.json](../packages/acp/src/runtime-versions.json)，随 daemon 一起发布。机器升级 daemon 时安装该发行版的固定依赖，不运行每日检测器，不独立热切换依赖。

## 发版准备

维护者或现有夜间发版任务先执行：

```bash
git fetch origin --tags
bun run release:prepare --version <下一版本>
```

命令从公共 npm registry 的 latest 标签查询两个 ACP bridge、Claude Agent SDK、Claude Code、Codex。只接受完整稳定 SemVer，拒绝预发布、废弃版本与低于当前快照的版本。它在隔离 REMI_HOME 中安装并验证候选组合，通过后同时更新 package.json 与 runtime-versions.json；没有新依赖时也记录本次检查及目标发版版本。可加 --dry-run 完成同样验证而不修改文件。

Claude ACP 使用 @anthropic-ai/claude-agent-sdk 内的 CC 执行文件，Codex ACP 使用 @openai/codex；这条链路没有独立的 @openai/codex-sdk。通过 npm overrides 固定实际 SDK，包括桥接包的嵌套依赖。若最新 Claude SDK 携带的 CC 尚未跟上独立 CC 的 latest，真实版本验证会失败，阻止发布不一致的组合。

候选校验包含 ACP 包版本、SDK 包版本、实际执行文件 --version、Codex usage 补丁、Claude wrapper 健康检查及 ACP initialize 协商。任何步骤失败都不改发版文件；此时应处理兼容性问题或等待上游版本对齐，再重新准备。准备命令不创建提交、tag 或 Release，也不重启机器上的 daemon，不创建 Task、不向模型发 prompt。

依赖与版本号同批提交，完整 Release build check 通过后才打 tag。CI 对版本号变更检查对应依赖快照，并在 Linux/macOS 安装固定组合、验证初始化。tag 工作流在发布 CLI 前检查版本一致性、快照和同一 main 提交的完整 CI 成功记录。构建时不再解析 latest，所以检查后上游继续发新版本也不会改变本次发行内容。

依赖升级不新增发版定时器；夜间发版任务使用同一准备入口。上线机器的依赖更新频率跟随 daemon 发版和升级频率。

## Codex 升级检查项

每次升级 Codex（`runtime-versions.json` 的 `codex.sdk` / `codex.executable`）后，逐条确认下列事实。开关仍存在但路径或默认值改变时，先修 `mergeCodexSessionConfig` 再发版：

- `[features] default_mode_request_user_input = true` 仍能打开 Default 模式下的同步 `request_user_input`。该开关在 Codex 里标记为 "under development"、默认关闭，Remi 在 `packages/daemon/src/agent-runtime/relay-sync.ts` 的 `mergeCodexSessionConfig` 里为每个会话 Home 补齐；`remi runtime prepare` 安装 bundle 后用真实执行文件确认（先只写一个含开关的临时 Home，再读开关状态）：

  ```bash
  # 在仓库根目录执行；bundle 目录名由 runtime-versions.json 的 codex 三段版本组成。
  CODEX_VERSIONS=$(bun -p 'const c=require("./packages/acp/src/runtime-versions.json").codex; `${c.acp}-${c.sdk}-${c.executable}`')
  CODEX_BIN="${REMI_HOME:-$HOME/.remi}/acp/bundles/codex-$CODEX_VERSIONS/node_modules/.bin/codex"
  TMP_CODEX_HOME=$(mktemp -d)
  printf '[features]\ndefault_mode_request_user_input = true\n' > "$TMP_CODEX_HOME/config.toml"
  CODEX_HOME="$TMP_CODEX_HOME" "$CODEX_BIN" features list | grep default_mode_request_user_input
  # 期望：default_mode_request_user_input          under development  true
  ```

  删掉临时 Home 里的 config.toml 后，同一命令输出 `false`，据此确认开关由 Remi 写入，而非 Codex 默认开启。本项在 codex-acp 1.13.1 + Codex 0.157.1 上实测通过（2026-09-27）。
- Default 模式下提问仍能走到 form elicitation：codex agent 调用同步 `request_user_input` 后，客户端应收到 `elicitation/create`（`mode: "form"`）而不是 "unavailable in Default mode" 错误。`packages/acp/src/client.ts` 声明 `elicitation: { form: {} }`；表单字段布局见 `packages/contracts/src/acp-elicitation.ts`。
- 表单布局版本判定仍然成立：codex-acp 1.11 用 `<id>__other` + `_meta.codex.isOtherAnswer`，1.12 起改为 `<id>_note` + `_meta.codex.role = "user_note"`，并把问题正文放在 `title`、短标题放在 `description`。`buildUserInputRequest` / `convertUserInputResponse` 的行号注释需要一起更新。

## 安装与启用

平台的 CLI 升级请求沿用现有排空/暂停接单流程。安装脚本解压发布包后，由新包的 remi runtime prepare 安装并验证该版本的固定依赖。验证成功后才替换 remi 与配套 Claude wrapper，随后 daemon 重启、重新注册。依赖准备失败时安装命令返回失败，已有 daemon 二进制保持不变。

daemon 由 systemd 托管时，重启交给 `systemctl --user restart --no-block <unit>`，由 systemd 重建整个 unit cgroup，只留一个新进程；launchd 托管时使用 `launchctl kickstart -k`。unit 名只从 /proc/self/cgroup 的 `0::` 或 `name=systemd` 行取，cgroup v1 主机上其它控制器行只到 `user@<uid>.service`（见 [apps/remi/cli/multiremi/service.ts](../apps/remi/cli/multiremi/service.ts)）。管理器调用失败或进程不受管理器托管时才退回 spawn 后继进程。修复前的版本在 cgroup v1 主机上总是退回 spawn，旧进程留在 unit 里；这样启动的新进程在接管工作区和接单前自检，以下条件全部满足时请求一次 unit 重启：自己不是 unit 的 MainPID；MainPID 是前台 daemon；从自己往上直到 MainPID 的每一级父进程都是前台 daemon，也就是由 spawn 回退逐代拉起；同一 HOME 下没有其它 daemon 持有工作区 supervisor 租约。任务进程同样在 unit 里并继承 INVOCATION_ID，任务里起的 daemon 与 unit 的 daemon 之间隔着 shell 或 agent 运行时，因此无论它换了 HOME、状态目录还是端口，都只记日志、不重启。租约仍被占用说明有 daemon 可能在跑任务，同样只记日志。

每个 provider 安装到 ${REMI_HOME:-~/.remi}/acp/bundles/<provider>-<bridge>-<sdk>-<executable>/，先在同级临时目录安装。预检直接运行新 bundle，不切换旧 daemon 使用的 Codex 启动链接；新 daemon 启动时才启用。旧的 ~/.remi/acp/node_modules 和全局安装保留为兼容入口。修复同一 bundle 时旧目录保留为 .previous-<timestamp>-<pid>，可人工回收。

全局 claude、codex 命令与用户登录配置不被覆盖。显式配置的自定义执行文件仍由用户管理；发行版校验针对 Remi 托管依赖。启动和 ACP 重装入口使用相同的版本与安装逻辑。仅 bridge 版本正确不代表 SDK 与实际执行文件正确。

原有 daemon 启动健康检查继续执行；安装校验不等同于登录授权、真实模型调用或重启后服务注册成功的端到端验收。旧发布包不含 runtime-bundle.json，安装脚本仍兼容旧版本安装；旧 daemon 需要升级到包含本改动的版本才会使用新依赖。

## Trace 持久化升级边界

本版本 daemon 将规范化过程记录写入 `<workspacesRoot>/.runtime/<session_id>/traces/<task_id>.jsonl`。
保留同一工作区根与 Runtime 身份重启时，恢复文件的 head、closed 和读取归属；已关闭历史按需读取，
未结束任务按 Hub head 续传。这只保证本版本已写入文件的记录，活跃追加未逐条 fsync，不承诺断电尾部保留。

旧版本只有进程内存中的 trace，新进程不能自动找回；原始 provider 日志也不能可靠重建全部 Remi 事件。
旧 daemon 停止前，需通过现有 `trace.read` 分页保存仍需保留的记录，或确认对应 Session Archive 已达到 ready 后再交接。
保存的导出只是人工备份，升级本身不会把它自动恢复到新 daemon 的热指针。
已停止且没有归档/备份的旧内存记录不能逐事件原样恢复，不能把升级后的空或不可达历史解释为本版本恢复成功。

仍持有 provider 原生 JSONL 时，运维恢复入口
`SessionArchiveService.ingestNativeTraceRecovery` 可接收经过身份核对和转换的标准 trace 归档。
它要求算法版本、源文件哈希/行范围、原生 session/turn、任务身份匹配证据、恢复事件种类和遗漏说明，
并在提交事务中重新锁定、核对 terminal Task 的工作区、Agent、Runtime、provider、两种 Session、时间与原 daemon 指针。
归档仅含已核对的 trace，按现有 ZIP/hash/index 规则验证后，ready 行与指针一起提交；不会重写任务状态、usage、
turn 卡统计或旧 `task_messages` 补录的 progress/digest。恢复后的事件数只表示此次实际恢复条数，不能冒充原始流式事件总数。

该入口沿用低优先级的 `trace_backfill` 指针来源，归档 metadata 明确记录
`recovery_source: native_provider_jsonl`，并非把原生事件序号与旧表序号放在同一轴上比较。
只允许替换已验证缺失的 daemon 指针，任何已有 archive、lost、活动或身份发生变化的任务均拒绝；
完全相同的导入再次执行时复用同一归档且数据库零写入。后续真实 daemon 归档仍拥有更高优先级。
缺失启动确认仅允许一个受限情形：数据库任务已取消、`started_at` 与 `result` 都为 null，但原生日志
有可独立绑定的执行记录。此时必须携带 `nativeExecutionBinding.kind = cancelled_without_start_ack`，
准确匹配任务 prompt 哈希与 provider session，至少两个不同源行的结构化任务 ID 证据（其中一个来自
`remi context`），且该工作区/provider 下仅这一个数据库任务占有该原生 session。提交再次核对
原生起止时间位于数据库创建到取消之间，恢复事件也必须在证明的原生时间段内。
仅此缺确认情形下，`dispatched_at` 可能由延迟的派发/重试更新而晚于原生执行，故不用它缩短已经由
精确 prompt、唯一 session 和直接任务 ID 证据证明的时间段；创建时间仍是不能越过的硬下界。
文件头可记录证明中的原生开始时间；数据库的取消状态、空开始时间、空 result 和统计保持原样。
未满足这些证据的取消任务，以及无启动确认的失败/完成任务，仍拒绝导入。普通任务的快照字段与既有恢复
metadata 哈希规则没有增加字段，以保持已准备和已导入的计划可原样验证、重放。
入口是本地运维辅助方法，不新增 HTTP 或 `remi` 命令；provider JSONL 的任务匹配和转换验证必须先于调用完成。

离线规划器 [prepare-native-task-trace-recovery.ts](../scripts/prepare-native-task-trace-recovery.ts) 只读受限目录里的
`recovery-identities.json`（任务/指针快照）、`task-anchors.json`（原派活与结构化 result）、
`source-snapshots.json`（经哈希验证的原生文件快照清单）和 `recovery-runtimes.json`（已核实的 Runtime→Daemon 对应）。
原生快照与这些含正文的输入必须保持私有，不能提交到仓库。传入新的 `--output-dir` 与明确的
`--claude-mapper` 文件路径；规划器记录映射器及恢复代码的 SHA-256，生成标准 JSONL、ZIP、`plans.json` 和不含正文的对账报告。
只规划 completed 任务：按 provider session、派活时工作目录、精确 prompt、完整 output 及明确 turn/UUID 血缘匹配，
原生中断续接和压缩必须有显式关联。Claude 会保留并行工具的兄弟分支，不能只读最终祖先链；
Codex 使用 canonical completed items，避免再播放 response_item 镜像。未知执行记录、错配或无来源的任务保留为 skipped。
回复与工具内容先按源核验，发布前对可识别的凭证脱敏并记录次数；不得把输入 prompt/context 附件作为执行输出导入。
执行前再次确认原生快照对应前缀 SHA 未变（允许文件仅追加后续轮次）且目标的标准 trace 确实缺失。

`scripts/import-native-task-traces.ts` 接收私有 manifest，默认只读检查固定任务快照、标准 JSONL、归档和事件摘要。
脚本直接装配所需 Repo，不构造会自动迁移/补种数据的 `MultiremiStore`；生产只使用环境变量中的
`MULTIREMI_DATABASE_URL`（Postgres）与 `MULTIREMI_SESSION_ARCHIVE_ROOT`，不会把连接串放进参数或日志。

执行导入必须使用 **API 进程的实际 uid/gid**。API 镜像的 entrypoint 通过 `gosu` 降权，普通
`docker exec` 不会再次运行 entrypoint，可能仍以 root 执行；此时迁移创建的 0700 目录/0600 归档会让
root 的读回检查通过，但 API 进程不能读。先核对 API 进程的 `/proc/<pid>/status` 中 `Uid`/`Gid`，
确认容器 `REMI_RUNTIME_UID/GID` 与实际进程相符，然后用 `docker exec --user <uid>:<gid>` 运行。
`--execute` 和 `--verify` 都会在读取计划、打开数据库、创建 journal 或临时目录之前，将当前进程的有效 uid/gid 与声明值比较，
不一致立即拒绝。声明值默认取 `REMI_RUNTIME_UID/GID`；未配置时须同时传 `--service-uid` 和
`--service-gid`，显式参数也不能覆盖与容器环境不一致的身份。脚本不会自动 chown 或放宽共享归档根权限。
`--verify` 必须以相同的 API 身份运行，不能以 root 的可读性代替实际服务可读性；默认只读预检不强制身份，仍建议用 API 身份。

```bash
bun scripts/import-native-task-traces.ts --plan=/private/recovery/plan.json --staging-root=/private/recovery
# 1001:1001 仅为示例，替换为上一步核对的 API uid/gid；staging/journal 须对该身份可读写。
docker compose exec --user 1001:1001 api bun scripts/import-native-task-traces.ts --plan=/private/recovery/plan.json --staging-root=/private/recovery --task-id=tsk_example --execute --service-uid=1001 --service-gid=1001 --journal=/private/recovery/journal.jsonl
docker compose exec --user 1001:1001 api bun scripts/import-native-task-traces.ts --plan=/private/recovery/plan.json --staging-root=/private/recovery --verify --service-uid=1001 --service-gid=1001 --journal=/private/recovery/journal.jsonl
```

`--task-id` 可重复；所有选中任务先预检，再串行提交，任一步失败即停止。
每个归档使用临时副本交给导入服务，保留 manifest 引用的原 ZIP；成功后经实际 `TraceReader` 分页到 eof
核对准确的事件摘要/数量，同时核对任务、turn 卡和旧补录状态未变。owner-only journal 逐条 fsync；
`--verify` 可用 journal 再核对原状态摘要，且不依赖 provider 原始文件或 staging 文件仍存在。
如把脚本 bundle 后复制进 API 容器，需将 `packages/server/src/store/db/pg-worker.ts` 单独编译为同目录
`pg-worker.ts`；同步 Postgres bridge 的 Worker 使用这个相对文件名。容器只需要 Bun 和这两个文件。

新文件头保存 `runtime_id`；缺少该字段的旧文件不猜测热读权限，可继续走已有归档流程。
一次性任务的后台归档意图也保存在该 Runtime 的 `.runtime` root，上传失败或重启不会授权提前删除源文件；
GC 仍需 ready archive 和删除前物理验证。停止会取消后台上传并最多等待 5 秒，下一进程按持久意图重试；
被取消的 staging 留在排除目录，旧实例不在所有权交接后继续清理。实现及读页上限见 [daemon 协议 v2](daemon-protocol-v2.md)。

## 本地准备与验证

```bash
remi runtime prepare                         # 已安装/配置的 provider
remi runtime prepare --provider claude
remi runtime prepare --provider claude --provider codex
```

不带 `--provider` 时（安装脚本即如此调用），只准备配置或检测到的 provider 中带 ACP bundle 的 claude、codex；antigravity 等没有 bundle 的 provider 直接跳过，全部跳过时输出空的 `runtimes` 并成功退出，不阻塞 CLI 升级。显式 `--provider` 只接受 claude、codex，传入其它值直接报错。

命令无服务端鉴权要求，只操作当前用户的本地 Remi 依赖。隔离验证时给 REMI_HOME 指定新临时目录；源码运行可通过 REMI_CLAUDE_AGENT_ACP_EXECUTABLE 显式选择仓库内 bin/remi-claude-agent-acp。
