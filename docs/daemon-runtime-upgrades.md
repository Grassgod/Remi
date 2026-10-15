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

候选校验包含 ACP 包版本、SDK 包版本、实际执行文件 --version、Codex usage 补丁与其依赖的 app-server 协议（见下方 Codex 升级检查项）、Claude wrapper 健康检查及 ACP initialize 协商。任何步骤失败都不改发版文件；此时应处理兼容性问题或等待上游版本对齐，再重新准备。准备命令不创建提交、tag 或 Release，也不重启机器上的 daemon，不创建 Task、不向模型发 prompt。

依赖与版本号同批提交，完整 Release build check 通过后才打 tag。CI 对版本号变更检查对应依赖快照，并在 Linux/macOS 安装固定组合、验证初始化。tag 工作流在发布 CLI 前检查版本一致性、快照和同一 main 提交的完整 CI 成功记录。构建时不再解析 latest，所以检查后上游继续发新版本也不会改变本次发行内容。

依赖升级不新增发版定时器；夜间发版任务使用同一准备入口。上线机器的依赖更新频率跟随 daemon 发版和升级频率。

## Antigravity 固定与升级检查项

Antigravity 不是 npm 包，`release:prepare` 只原样沿用 `antigravity` 块，`release:check` 在每个提交上校验它的结构（稳定版本号、`dl.google.com` 的 https 地址、64 位十六进制 sha256、正数字节数、已知平台）。升级时由维护者手动执行：

```bash
bun run release:pin-antigravity --version <server 版本> --dry-run   # 只计算，不写文件
bun run release:pin-antigravity --version <server 版本>
```

命令读取公共 ACP registry（`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，只列最新版本、不带校验和），下载四个支持平台的压缩包计算 sha256 与大小（不保存压缩包），只改写 `antigravity` 块，拒绝降级。1.4.0 的四个值已于 2026-10-15 用 `--dry-run` 对真实 registry 复核一致。

每次升级 server 版本，用新版本实际运行（假上游或真实网关）逐条确认以下行为仍然成立，再提交 pin。这些是对专有 server 可观察行为的记录，不引用、不复制其源码：

- 环境开关仍是 `AGY_ACP_ENABLE_GATEWAY_AUTH=1`，`antigravity-acp/settings.json` 的 `auth.type = "gateway"` 仍选中网关认证（`runtime prepare` 的契约检查覆盖）；
- 网关 URL 规则不变：server 自己在 `AGY_LLM_GATEWAY_URL` 后追加 `/v1beta/...`，base URL 不带 `/v1beta`；listing 仍同时带 Bearer 与占位 `x-goog-api-key`，由垫片剥掉；
- 网关模式仍不提供 `thought_level` 选项，`session/set_config_option` 仍能严格切换模型；
- server 自报的 `usage_update.used` 仍等于 total + cached，因此 native `used` 继续不能计费（实测对账见 [Antigravity Runtime](antigravity.md#validation)）；
- `ask_user` 仍以 `interaction_<hex>` 工具调用加 `session/request_permission` 发出，工作区信任提示的选项 id 仍是 `{trust, deny}`；
- 网关错误仍以 `Agent execution error:` 或 `Agent connection was lost and could not be re-established:` 开头的整段文本流出；
- rawInput 的键名与 `trace-vendor.ts` 的别名表一致（用手动探测重新导出 fixture 对照）；
- `remi runtime prepare --provider antigravity --accept-antigravity-terms` 的完整校验（含真实垫片前的契约检查）在 Linux x64 与 macOS 上通过，并跑一次[手动探测](antigravity.md#validation)。

CI 不在 runner 上代为同意 Google 条款，所以按 `antigravity` 块变化触发的 Linux/macOS 校验作业没有加入（PR 4 后续：需要先确定由谁、以什么身份同意条款）；在此之前由维护者在两类机器上手动执行上面最后一项。

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
- 逐请求用量仍被采集（升级 Codex 或 codex-acp 都要确认）。补丁锚点能匹配只说明补丁已安装，不说明钩子会被调用：`codex-usage-v6` 在 codex-acp 2.1.1、2.2.2 上锚点全部匹配，但两版 bridge 的 `thread/start` 都没有声明 `experimentalRawEvents`，Codex 0.161.0、0.162.1 的 app-server 因而从不发送 `rawResponse/completed`。结果是 Codex 任务只留下无 token 的 `context_snapshot` 单位，报表全部计入 `unknown_task_count`。`codex-usage-v7` 依赖下面三点：
  - `thread/start` 声明 `experimentalRawEvents: true` 后，该线程及其原生子线程才会收到 `rawResponse/completed`；
  - `thread/resume` 与 `thread/fork` 没有该参数，这类线程的请求只能从原生 rollout 的 `token_usage_record` 读取（[codex-rollout-usage.ts](../packages/acp/src/codex-rollout-usage.ts)）；
  - initialize 的 `optOutNotificationMethods` 仍可退订随开关出现的 `rawResponseItem/completed`。

  `release:prepare` 与 `remi runtime prepare` 会用候选 Codex 执行文件生成 app-server schema（`app-server generate-json-schema --experimental`），上述字段或 `rawResponse/completed` 的 thread/turn/response 身份缺失时失败（`verifyCodexRequestUsageProtocol`）。这一步不调用模型，不能证明事件真的会发出，也不检查 rollout 格式。因此依赖准备之后，还要在固定 bundle 上运行真实检查（调用两次模型）：

  ```bash
  # CODEX_VERSIONS 的取法同上一项。
  bun run tests/integration/verify-codex-bridge.ts --prompt \
    --package-dir="${REMI_HOME:-$HOME/.remi}/acp/bundles/codex-$CODEX_VERSIONS/node_modules/@agentclientprotocol/codex-acp"
  # 期望 status 为 passed，requestUsage.newThread.streamed > 0，requestUsage.resumedThread.rollout > 0
  ```

  新会话的流式请求必须在 rollout 中找到身份与计数相同的记录，否则检查器失败；恢复会话在新 bridge 进程中运行，`resumedThread.streamed` 为 0 是 app-server 的现状。`token_usage_record` 字段改名时，需要同时修改 [normalizeCodexRequestUsage](../packages/acp/src/codex-request-usage.ts) 与 rollout 读取。本项在 codex-acp 2.2.2 + Codex 0.162.1 上实测通过（2026-10-15）：新会话 1 条流式请求、1 条 rollout 记录，恢复会话 1 条 rollout 记录。
- Default 模式下提问仍能走到 form elicitation：codex agent 调用同步 `request_user_input` 后，客户端应收到 `elicitation/create`（`mode: "form"`）而不是 "unavailable in Default mode" 错误。`packages/acp/src/client.ts` 声明 `elicitation: { form: {} }`；表单字段布局见 `packages/contracts/src/acp-elicitation.ts`。
- 表单布局版本判定仍然成立：codex-acp 1.11 用 `<id>__other` + `_meta.codex.isOtherAnswer`，1.12 起改为 `<id>_note` + `_meta.codex.role = "user_note"`，并把问题正文放在 `title`、短标题放在 `description`。`buildUserInputRequest` / `convertUserInputResponse` 的行号注释需要一起更新。

## 安装与启用

平台的 CLI 升级请求沿用现有排空/暂停接单流程。安装脚本解压发布包后，由新包的 remi runtime prepare 安装并验证该版本的固定依赖。验证成功后才替换 remi 与配套 Claude wrapper，随后 daemon 重启、重新注册。依赖准备失败时安装命令返回失败，已有 daemon 二进制保持不变。

daemon 由 systemd 托管时，重启交给 `systemctl --user restart --no-block <unit>`，由 systemd 重建整个 unit cgroup，只留一个新进程；launchd 托管时使用 `launchctl kickstart -k`。unit 名只从 /proc/self/cgroup 的 `0::` 或 `name=systemd` 行取，cgroup v1 主机上其它控制器行只到 `user@<uid>.service`（见 [apps/remi/cli/multiremi/service.ts](../apps/remi/cli/multiremi/service.ts)）。管理器调用失败或进程不受管理器托管时才退回 spawn 后继进程。修复前的版本在 cgroup v1 主机上总是退回 spawn，旧进程留在 unit 里；这样启动的新进程在接管工作区和接单前自检，以下条件全部满足时请求一次 unit 重启：自己不是 unit 的 MainPID；MainPID 是前台 daemon；从自己往上直到 MainPID 的每一级父进程都是前台 daemon，也就是由 spawn 回退逐代拉起；同一 HOME 下没有其它 daemon 持有工作区 supervisor 租约。任务进程同样在 unit 里并继承 INVOCATION_ID，任务里起的 daemon 与 unit 的 daemon 之间隔着 shell 或 agent 运行时，因此无论它换了 HOME、状态目录还是端口，都只记日志、不重启。租约仍被占用说明有 daemon 可能在跑任务，同样只记日志。

每个 provider 安装到 ${REMI_HOME:-~/.remi}/acp/bundles/<provider>-<bridge>-<sdk>-<executable>/，先在同级临时目录安装。预检直接运行新 bundle，不切换旧 daemon 使用的 Codex 启动链接；新 daemon 启动时才启用。旧的 ~/.remi/acp/node_modules 和全局安装保留为兼容入口。修复同一 bundle 时旧目录保留为 .previous-<timestamp>-<pid>，可人工回收。

全局 claude、codex 命令与用户登录配置不被覆盖。显式配置的自定义执行文件仍由用户管理；发行版校验针对 Remi 托管依赖。启动和 ACP 重装入口使用相同的版本与安装逻辑。仅 bridge 版本正确不代表 SDK 与实际执行文件正确。

原有 daemon 启动健康检查继续执行；安装校验不等同于登录授权、真实模型调用或重启后服务注册成功的端到端验收。旧发布包不含 runtime-bundle.json，安装脚本仍兼容旧版本安装；旧 daemon 需要升级到包含本改动的版本才会使用新依赖。

## Trace 持久化升级边界

本版本 daemon 将规范化过程记录写入 `<workspacesRoot>/traces/<主体>/<task_id>.jsonl`。
保留同一工作区根与 Runtime 身份重启时，恢复文件的 head、closed 和读取归属；已关闭历史按需读取，
未结束任务按 Hub head 续传。这只保证本版本已写入文件的记录，活跃追加未逐条 fsync，不承诺断电尾部保留。

旧版本只有进程内存中的 trace，新进程不能自动找回；原始 provider 日志也不能可靠重建全部 Remi 事件。
旧 daemon 停止前，需通过现有 `trace.read` 分页保存仍需保留的记录后再交接。
保存的导出只是人工备份：本 PR 不提供导入命令，也不保证把它自动恢复到新 daemon 的热指针。
已停止且没有备份的旧内存记录不可恢复，不能把升级后的空或不可达历史解释为本版本恢复成功。

新文件头保存 `runtime_id`；缺少该字段的旧文件不猜测热读权限，文件保留在磁盘上。
服务端不再保存 trace 副本，Runtime 下线或删除后指向它的指针标 `lost`。

## 存储布局升级边界

本版本改变 daemon 根目录布局（见[存储与保留](dev/storage-retention.md)）。升级后首次启动、领取任务之前，daemon 执行一次旧布局清扫：
有未保存工作的旧 worktree 先打快照 ref，`.repos` 与 `.snapshots` 改名为 `shared/repos` 与 `shared/code-views`，其余旧条目整体移入
`legacy-<日期>/`，保留 `MULTIREMI_LEGACY_KEEP_DAYS`（默认 7）天后由回收轮次删除，期间不删除任何用户数据。
历史 Issue 与 Chat 在 daemon 上的原生会话和 trace 作废，不迁移；服务端迁移同时把所有会话线置为新一代，
重开历史主体时从分支新建工作区、从对话日志重建上下文。旧 daemon 在升级窗口内调用已删除的 RPC 得到 404，按既有逻辑跳过清理。
此前用 systemd 覆盖文件设置 `MULTIREMI_GC_ENABLED=false` 的 daemon，在预演清单核对无误后删除该覆盖文件并重启，周期回收才会开启。
清扫会把 v0.2.89 的 `.runtime/`（含 Codex 原生 rollout）一并移入 `legacy-<日期>/` 并按期删除；需要补录 `codex-usage-v6` 期间的 Codex 用量时，先在该 daemon 上导出，或在期限内从 `legacy-<日期>/` 导出，步骤见 [Codex 原生用量补录](usage-accounting.md#codex-原生用量补录)。
实现及读页上限见 [daemon 协议 v2](daemon-protocol-v2.md)。

## 本地准备与验证

```bash
remi runtime prepare                         # 已安装/配置的 provider
remi runtime prepare --provider claude
remi runtime prepare --provider claude --provider codex
remi runtime prepare --provider antigravity --accept-antigravity-terms
```

不带 `--provider` 时（安装脚本即如此调用），准备配置或检测到的 provider 中带 ACP bundle 的 claude、codex；antigravity 只在本机已有任一版本安装时才准备，这样新 CLI 替换前就能预取新 pin，但绝不会成为一台机器的首次下载。全部跳过时输出空的 `runtimes` 并成功退出，不阻塞 CLI 升级。显式 `--provider` 接受 claude、codex、antigravity，传入其它值直接报错；任何准备失败都按失败退出。

Antigravity 的 ACP server 是 Google 的专有软件，不随 Remi 发布包分发：每台机器自己从 `dl.google.com` 下载 `runtime-versions.json` 里固定的压缩包（macOS 约 110 MB、解压约 400 MB；Linux 约 330 MB、解压约 1.1 GB），流式校验大小与 sha256，在同级 stage 目录解压后原子改名到 `${REMI_HOME:-~/.remi}/acp/antigravity/<版本>-<平台>/`，保留一份旧副本。首次下载必须显式同意 Google 条款（`--accept-antigravity-terms` 或 `REMI_ACCEPT_ANTIGRAVITY_TERMS=1`），同意时间写入 `install.json`，之后的 pin 升级沿用。准备后运行完整校验：只做 `initialize`（版本与 `loadSession`），再对假上游做无凭据的网关契约检查（`session/new` 必须列出上游的唯一模型并带 Bearer 认证），不发 prompt。不支持 Windows。详见 [Antigravity Runtime](antigravity.md)。

命令无服务端鉴权要求，只操作当前用户的本地 Remi 依赖。隔离验证时给 REMI_HOME 指定新临时目录；源码运行可通过 REMI_CLAUDE_AGENT_ACP_EXECUTABLE 显式选择仓库内 bin/remi-claude-agent-acp。
