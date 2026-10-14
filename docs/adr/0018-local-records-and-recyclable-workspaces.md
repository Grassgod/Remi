# ADR 0018: 记录留在 daemon，工作区可回收可恢复，Issue 与 Chat 统一留存模型

- 状态：已确认（贺华杰，2026-10-13）：历史 Issue/Chat 的 daemon 侧状态允许作废；一次开发、一次部署。
- 取代 [ADR 0006](0006-conversation-log-and-daemon-owned-traces.md) 决策 5–9（trace 归档、Session Archive v2、回填、下线前归档）；决策 1–4（对话日志、轮卡片）不变。
- 继承 [ADR 0016](0016-unified-message-inbox-and-turn.md)：对话日志、轮、尝试、lane 的模型不变；本 ADR 决定尝试产生的记录和工作区在 daemon 上如何留存，以及自动化运行的主体形态。
- 参考：Claude Code 与 Codex app 的会话/worktree 模型（分支是身份、worktree 是缓存、记录只在本机、按数量和时间回收、删前快照、定时任务开新 chat）。

## 背景

2026-10-12 生产数据（两台 daemon，n37-066-008 与 n37-206-133）：

- 工作区根目录各约 190 GB。可重建内容超过 95%：代码目录（含 `node_modules` 与构建产物）约 99 GB，provider home 里的缓存与日志约 60 GB，共享 bare 仓库 22 GB。不可重建的记录每台约 5 GB，trace 不到 0.3 GB。
- 两台机器的定期清理都被 `MULTIREMI_GC_ENABLED=false` 关掉，原因是归档上传触发了 Bun 的文件句柄泄漏。关掉之前也清不掉：85% 的 Issue 代码目录因文件数超过 1 万（`node_modules` 计入）被判为"脏"而永久保留。
- 服务端归档 6 GB，11,337 个 trace 指针指向 ZIP（其中 11,047 个来自历史回填）；ZIP 里的原生会话历史从未被读取。
- "一次性任务"（4,000 余次）全部是自动化 `run_only` 运行，每次运行一套独立目录。

## 目标

1. daemon 磁盘可回收：结束的 Issue 和 Chat 不再无限占用代码目录和运行环境。
2. 去掉服务端归档：不再上传、重试、回填，下线和硬删除不再依赖归档。
3. Issue 与 Chat 用同一套生命周期和回收规则。
4. 自动化是触发器，`run_only` 每次运行开一个 Chat；"一次性任务"消失。
5. 回收可逆：工作区删除前保存快照，重开时恢复；记录永不删除（主体硬删除除外）。
6. 代码里没有旧布局、没有归档、没有过渡期分支。

## 非目标

- 不改对话日志、轮、尝试、lane 的模型和 Issue 状态机。
- 不做通用"Chat 升级为 Issue"功能；话题工作区迁移照旧，只改目标路径。
- 不删服务端已有的归档 ZIP 和 `multiremi_task_messages`，也不在本 ADR 内恢复它们。
- 不改 `.repos` 共享仓库的淘汰策略，不合并 Codex 的插件缓存。
- 不迁移历史 daemon 状态：升级时作废（§10）。

## 1. 概念模型

```text
团队
├── Issue      工作项：有状态、层级、负责人；一个持久工作区；N 段对话
├── Chat       一段对话；可选一个工作区；可置顶、归档
└── 自动化      触发器：
    ├── run_only              每次运行新开一个 Chat；session_policy=reuse_latest 时在上一次运行的 Chat 里继续
    └── create_issue / trigger_issue   新建 Issue / 在 Issue 里继续（不变）
```

- 主体只有 Issue 和 Chat；一个执行同时带有 Chat 与 Issue（话题转发、项目绑定的 Chat）时按 Chat 归属。两者形状相同：对话 × N、工作区 × 0..1、记录。既无 Issue 也无 Chat 的执行按内部兜底主体 `tsk_*` 处理，规则同 Chat。
- 对话是一条消息日志：Issue 的会话 `ises_*`（主会话与讨论会话）、Chat 的 `chat_*`、自动化的 `auto_*`（只记触发与指向运行 Chat 的链接）。
- 会话线 = agent × 执行范围（`main` 或委派 id）× 代。代是该会话线上原生 Claude/Codex 会话的版本号；会话无法续接或工作区被回收后 +1，从对话日志重建上下文。

daemon 上的四类东西：

| 类 | 内容 | 能否重建 | 回收 |
|---|---|---|---|
| 工作区 | 仓库 worktree、wiki 工作副本、任务信息 | 能（分支 + 快照） | 主体结束后回收，删前快照 |
| 运行环境 | provider home 里除历史以外的部分、讨论会话工作集、插件运行目录、执行私有临时目录 | 能 | 主体结束或该代被取代后回收；临时目录执行结束即删 |
| 记录 | trace；原生会话历史（Claude `projects/`、Codex `sessions/`、`session_index.jsonl`） | 不能 | 永久保留，随主体硬删除 |
| 共享缓存 | bare 仓库、只读代码视图 | 能 | 本 ADR 不改淘汰策略 |

服务端另有一份权威记录：对话日志与轮卡片（摘要、最终回复、用量、统计）。daemon 上的记录是明细，可能不可达。

## 2. 工作区：分支是身份，worktree 是缓存

- 工作区是主体的工作集：`<repo>/` × n、`wiki/`、`.multiremi/wiki-base/`。执行时 `MULTIREMI_WORKSPACE_ROOT` 指向它，`remi wiki` 在这里读写 wiki。
- Chat 只有一条会话线、执行串行，当前目录就是工作区，`task.json` 与 skills 也放在这里。Issue 的持有者执行可以并发（同一 Issue 的多个委派共享生命周期锁），因此当前目录是每条会话线私有的 `work/`（在运行环境里），只放 `task.json`、skills 和附件；仓库与 wiki 用工作区里的绝对路径访问。同一主体的 wiki 物化由 daemon 的主体级排他锁串行化。
- Issue 绑定分支 `agent/<issue key>`，Chat 绑定 `chat/<chat id>`。daemon 不自动推送分支。
- 讨论会话（非持有者）使用一次性工作集：只读 detached worktree、wiki 副本、`task.json`，放在运行环境里，随运行环境回收。
- 用户注册的本地目录（Runtime 工作区）永不回收，也不写入 `.multiremi`。
- **快照**：回收前检查树里的每个 git 仓库（规则见 §4）。linked worktree（共同 git 目录是共享 bare 仓库）有未保存的工作（未提交的改动含未跟踪文件、或未推送的提交）则用临时 index 把工作树写成一次在 HEAD 之上的提交，保存为该 bare 仓库里的 ref `refs/remi/snapshots/<主体>/<序号>`；未推送的提交作为祖先一并保留。独立克隆（`.git` 是目录，或 worktree、子模块的共同目录不在共享缓存里）连同它的 ref 一起被删，没有地方能保存，所以有未保存工作时保留整个主体。每个仓库单独判断，嵌套在里面的仓库不进上级的快照。wiki 相对合并基线改动过的文件原样复制到 `registry/<主体>.snapshot/wiki/`。快照只在本机。daemon 自己不给检出加忽略规则：agent 写的 `CLAUDE.md`、`AGENTS.md`、`.claude/` 等不论在根目录还是更深处都按普通文件对待，没被仓库或用户的 gitignore 忽略就出现在 `status`、进快照。仓库和 wiki 以外放在工作区里的文件（Chat 里生成的报告、下载、脚本）不进快照，随工作区一起删除；需要保留的内容要放进仓库或 wiki。未恢复的 wiki 快照在再次回收时并入新快照，不会丢。
- **恢复**：主体在同一台 daemon 上重开时，检出分支后若当前 HEAD 是快照 HEAD 的祖先，则快进到快照 HEAD 并把快照工作树还原为未提交改动；分叉时不动，记录日志并保留 ref 供人工处理。快照条目总是记 `dir`，恢复只按它找 worktree：条目只应用到恰好站在这个路径、且属于持有该 ref 的共享仓库的 worktree，路径沿途出现符号链接一律拒绝（`work/<主体>` 本身是符号链接则整个拒绝），其余条目留在登记里等待并报告。条目记了分支的，worktree 还要站在这个分支上（或 detached 在记录的 HEAD），否则也等待：agent 在回收前切到别的分支上做的工作不会把 Issue 分支快进过去。agent 自建的兄弟 worktree（如 `repo-experiment`）因此只回到自己的位置，不会落进 Issue 的检出、移动 Issue 分支。会话线私有 `work/` 里 worktree 的条目（`dir` 在 `env/` 下）新的一代里无处可恢复，只作参考：回收时上报一次，不让登记一直等着。wiki 在重新物化后覆盖快照文件。恢复失败不阻塞执行。
- 快照做不到（超出 `snapshot_max_bytes`、独立克隆或子模块里有未保存工作、git 检查失败）则保留工作区并在存储报告中给出原因。

## 3. 记录：留在 daemon，服务端只持指针

- trace 由 daemon 实时写入 `traces/<主体>/<tsk>.jsonl`，格式 `multiremi.trace.v1` 不变。
- 原生会话历史由 provider 写在 home 里（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 指向该会话线的 home）。回收时就地清理 home，只保留 `projects/`、`sessions/`、`session_index.jsonl`，路径不变。
- `multiremi_task_traces.location` 只剩 `daemon | none | lost`；读取路径不变：`GET /api/turns/:id/trace` → `trace.read` RPC → daemon。daemon 离线返回 `unreachable`；daemon 下线或 Runtime 删除时指针标 `lost`。
- daemon 启动只登记 trace 文件路径，首次读取时建索引，常驻索引按 LRU 限量。

## 4. 生命周期与回收

```text
活跃 ──结束──▶ 已结束 ──超过保留期或超出数量上限──▶ 已回收（分支 + 快照 + 记录）
  ▲                                                       │
  └──────────── 重开：恢复工作区，新一代会话重建上下文 ◀─────────┘
                                                          │ 主体被硬删除（服务端 404）
                                                          ▼
                                                     已遗忘（快照 ref 保留，其余删除）
```

| 项 | 规则 |
|---|---|
| 什么算结束 | Issue：done / completed / closed / cancelled，或服务端应答 `moved`（已迁到别的工作区，只告诉执行过它的 daemon）。Chat：被归档；不活跃超过 `chat_idle_days`（默认 14 天）自动归档；归档的 Chat 收到新消息自动恢复活跃。自动化开的 Chat：运行结束且被标记为安静时自动归档 |
| 什么时候回收 | 结束后超过 `ttl_ms`（默认 72 小时；自动化开的 Chat 用 `automation_ttl_ms`，默认 24 小时）；或已结束且仍占用工作区的主体超过 `max_retained`（默认 50）时淘汰最久未用的 |
| 不回收 | 有正在跑的执行；Chat 被置顶；Issue 未结束；用户注册的本地目录（只清运行环境） |
| 旧一代运行环境 | 同一会话线下低于最高代的目录，修改时间超过 `ttl_ms` 后按回收规则清理，不等主体结束；这一代里（私有 `work/`、provider home、插件运行目录）有无法保存的未保存工作时保留这一代 |
| 执行私有临时目录 | 执行结束立即删；每轮删除不在运行的执行留下的残留 |
| 硬删除 | 服务端 404 且最后使用超过 `orphan_ttl_ms`（默认 72 小时）：linked worktree 有未保存工作先打快照 ref，再删工作区、运行环境、trace 和登记；独立克隆里有未保存工作则保留（规则见下） |
| 已迁走的 Issue | 按已结束处理：超过 `ttl_ms`（从最后使用算起）后先快照再回收工作区与运行环境；永不遗忘，trace、原生会话历史和登记都留下 |
| 失败 | 任一步失败则保留并上报原因，下一轮重试；所有权丢失中止整轮 |

回收一个主体：确认状态与锁 → 仓库快照 → wiki 快照 → 删 worktree 与工作区目录 → 运行环境清到白名单 → 登记改为 `reclaimed` → RPC `gc.subject_reclaimed`。服务端收到后：Issue 工作区记录标 `cleaned` 并保存快照信息；该主体在这台 daemon 上的会话线清空原生会话 id 并代 +1；Chat 清空原生会话字段。下一次执行因此直接用新一代 home，不做一次必然失败的续接。

Git 检查一律用异步 `git` 子进程并设超时；不设文件数上限，不看共享仓库 pack 大小；有未保存工作不再是永久保留的理由，而是先快照再删。

检查与快照用同一套规则，凡要删除或因过期而挪走的树都先过一遍：`work/<主体>`、Issue 会话线与讨论会话每一代的整个目录（私有 `work/`、provider home、插件运行目录；保留的原生会话历史，和 provider 在 home 里自己维护、由它重建的 `.tmp`、`tmp`、`plugins`、`vendor_imports`、`skills`、`cache`、`.cache`、`memories`、`memories_v2` 除外：Codex 每次启动都会在 `$CODEX_HOME/.tmp/plugins` 克隆一个没有远程的仓库，开启记忆功能时 `memories` 也是本地仓库）、过期的未绑定话题工作区、升级清扫的旧布局。

1. 发现：从树根往下最多 6 层，找所有名为 `.git` 的条目（文件或目录）和所有裸仓库（本身是 git 目录：有 `HEAD`、`objects/`、`refs/`，且 git 认它，不进入 git 自己放在里面的目录（`objects`、`refs`、`worktrees` 等），人放进去的，如 `git worktree add` 加的 worktree，照常找；只是布局像的目录按普通目录搜索，外层仓库跟踪着它的，如作测试夹具提交的裸仓库，是项目内容而不是要判断的仓库），仓库里面的仓库也找；不跟随符号链接，不进入 `.git` 和 `node_modules`。顶层的普通文件和符号链接（intake 的 `manifest.json`、agent 写的 `report.md`）不是仓库，不是保留的理由，随树一起删。无法列出的目录可能藏着仓库，整棵树保留（`git_check_failed`）；超过 6 层的仓库不检查，随树删除。
2. 分类：按 `git rev-parse --git-common-dir` 的 realpath。共同目录是共享缓存里的仓库（默认 `shared/repos/<workspace>/<名>.git`，从缓存根到它之间没有别的 git 目录）的是 shared-linked，其余是 standalone；树里的裸仓库总是 standalone。
3. 检查：每个仓库只对自己的内容负责，嵌套在里面的仓库不算它的内容；树根本身是仓库时，`wiki/`、`.multiremi/`（daemon 自己的目录，wiki 另有快照）也不算。shared-linked 的未保存工作是未提交或未跟踪的文件，或 HEAD 上没有任何远端分支包含的提交（detached HEAD 停在某个分支上则不算，讨论会话的只读工作集随时可重建；tag 不算，缓存同步会裁剪远端没有的 tag）。standalone 的未保存工作是未提交或未跟踪的文件，或任何 ref 上没有任何远端分支包含的提交，没有远端且有提交的仓库一定算；裸仓库没有工作树，只按提交判断。远程是要一起删掉的目录里的仓库的克隆，这个远程不算数（它随树消失），按没有这个远程处理。所有 git 子进程都不继承 daemon 环境里的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等指向仓库的变量。
4. 处理：shared-linked 有未保存工作则快照；standalone 有未保存工作则保留整棵树（`snapshot_failed`），干净的随树删除。快照的临时 index 里出现 HEAD 没有的 gitlink（超过 6 层、没有被检查的嵌套仓库，`git add` 只会记下一个指针）则拒绝快照，同样保留整个主体：不假装保存了没检查过的仓库。
5. 记录：快照条目总是记 `dir`——`work/<主体>` 里的相对它，会话线私有 `work/` 里的相对工作区根目录（那里没有对应的检出，恢复不会应用它们，ref 留待人工处理）。这类条目只作参考：不让登记一直等着恢复，回收时上报一次。

整棵工作区在话题与 Issue 之间移动时（话题迁入 Issue、结束的话题 Issue 回到 `_topics/`，含回滚），里面的 linked worktree 在挪动后立刻 `git worktree repair`，先于任何 `worktree prune`（话题并入已有工作区的 Issue 是复制：复制出的 worktree 在删除话题目录之前同样 repair，仓库也在话题里的先改 `.git` 指向复制品）；否则共享仓库里登记的旧路径会被 prune 丢掉，worktree 随之损坏。

会话线某一代里有无法保存的未保存工作时，回收和遗忘保留整个主体，旧一代清理只保留这一代。回收轮次不测量单个主体的占用，计划里的大小为空；上轮释放量是回收前后文件系统空闲空间之差，是近似值，不用于对账。

## 5. 自动化

- `run_only` 运行创建真正的 `chat_*`，记录来源 `origin_autopilot_id / origin_run_id`；运行记录保存 `chat_session_id`；`auto_<id>` 对话只保留触发记录。
- 运行中的 agent 若判断本次没有值得报告的内容，执行 `remi automation quiet`；运行完成且为安静时自动归档该 Chat。其余情况 Chat 保持活跃并带未读，作为通知。
- Chat 列表默认只显示用户的对话，可筛选"自动化""全部"；自动化页的运行记录链接到对应 Chat。
- 历史 `auto_*` 轮保持只读，不迁移。

## 6. daemon 目录结构

根目录仍为 `MULTIREMI_WORKSPACES_ROOT`（默认 `~/.remi/multiremi/workspaces`）：

```text
registry/<主体>.json                    主体登记：归属、仓库、分支、状态、快照（取代分散的 gc.json）
registry/<主体>.snapshot/wiki/          wiki 快照
work/<主体>/                            工作区：仓库、wiki；Chat 的当前目录
env/<主体>/<对话>/<agent>/<范围>/<代>/    [executions/<执行身份>/]home/、work/（Issue 会话线的私有当前目录；讨论会话的一次性工作集）、.remi-runtime/
env/<主体>/tmp/<tsk>-XXXXXX/            执行私有临时目录
traces/<主体>/<tsk>.jsonl               记录
shared/repos/                          共享 bare 仓库（原 .repos），快照 ref 在此
shared/code-views/                     只读代码视图（原 .snapshots，intake 使用）
.daemon/                               探测、删除隔离区、待上报队列、disk-usage.json（占用测量缓存）
_topics/<话题>/                         飞书话题工作区，位置不变；立单时迁入 work/<iss_*>/
legacy-<日期>/                          升级时移入的旧布局，保留 7 天；其中 retained/ 与 retained.json 不随过期删除
```

GC 只读 `registry/`，不遍历目录树。磁盘占用（`du`）不在回收轮次里测量：后台异步、每小时至多一次或在立即回收/预演请求时重测，`nice` 低优先级，每个类别 30 分钟超时，结果缓存在 `.daemon/disk-usage.json`；每份存储报告带最近一次完成的测量及其时间，测量进行中、超时或失败都不阻塞也不使一轮失败。回收轮次本身不运行 `du`，计划里单个主体的大小为空。

## 7. 服务端与协议

**删除**：`session-archive/` 全部；归档路由（daemon 上传协议、Issue 列表/verify/retry、`/api/workspaces/:id/session-archive`）；`runtime.archive_sessions` 请求与结果帧；RPC `gc.workspace_cleaned`、`gc.check_autopilot_run`；回填与归档对账脚本；启动降级项 `session_archive_direct_upload`；围绕归档的"存储与清理"页；`remi session archive`、`remi issue archive`、`remi session config`；工作区设置键 `session_archive`。

**修改**：

- Issue 硬删除只要求没有活动任务。daemon 遇到 404 自行遗忘。
- Runtime 下线/删除：去掉"有未归档 trace"阻止项；下线计划给出 `traces_to_lose`；执行后这些指针标 `lost`。
- `gc.check_chat_session` 增加 `pinned`、`origin`、`last_activity_at`。

**新增**：

- RPC `gc.subject_reclaimed`（见 §4）。
- 存储策略：工作区设置 `settings.storage`（`ttl_ms`、`automation_ttl_ms`、`max_retained`、`orphan_ttl_ms`、`snapshot_max_bytes`、`chat_idle_days`），`GET/PUT /api/workspaces/:id/storage`，经现有 `workspace.settings` 下行下发给 daemon。
- 存储报告：best-effort 上行帧 `gc.storage_report`（周期轮次，含 `MULTIREMI_GC_DRY_RUN`），服务端按 daemon 保存最近一份；`GET /api/workspaces/:id/storage/daemons` 汇总。运维请求的预演只经 `runtime.gc_run_result` 回报。两条路径的报告都限制大小（计划 2000 项、错误 100 条）以装进 1 MiB 的帧。
- 立即回收/预演：待处理请求 `runtime.gc_run { mode: dry_run | run }` 与结果帧 `runtime.gc_run_result`，沿用现有 Runtime 请求表模式；`POST /api/runtimes/:id/gc-runs`、`GET /api/runtimes/:id/gc-runs/:requestId`。
- 设置里的"存储"页：按 daemon 展示占用、主体数、保留原因、上轮释放、预演与立即回收及其清单、策略表单。
- `POST /api/turns/:id/automation/quiet` 与 `remi automation quiet`；Chat `origin` 与列表筛选；运行记录 `chat_session_id`。

**一次性迁移**（随版本启动执行，可重入）：

1. `multiremi_session_archives` 改名为 `multiremi_legacy_session_archives`；指向归档的 trace 指针复制到 `multiremi_legacy_trace_pointers`；两张表不再被代码读取，供日后恢复 ZIP。
2. `multiremi_task_traces` 去掉归档列，所有非 `none` 指针改为 `lost`。
3. 删除 `multiremi_session_archive_requests`、`multiremi_trace_backfill_progress`；保留 `multiremi_trace_backfill_tasks`（用量统计关联）与 `multiremi_task_messages`。
4. 所有 agent 会话线清空原生会话 id 并代 +1；所有 Chat 清空原生会话字段。
5. `multiremi_issue_workspaces` 全部标 `cleaned`，归档列换成 `snapshot_json`、`snapshot_at`、`unsaved_work`。
6. 新表：`multiremi_daemon_storage_reports`、`multiremi_runtime_gc_run_requests`；新列：Chat 来源、运行记录的 Chat 与安静标记。

## 8. daemon

- 新模块：目录布局、主体登记、回收引擎、存储策略、旧布局清扫；trace 存储按需索引。
- 删除：归档写入与上传、一次性任务上传队列、`runtime.archive_sessions` 处理、`gc.json`、纯 JS 的 Git 检查。
- 修复：Chat 目录误走 Issue 锁报 "ownership changed"；服务端 404 的主体从"拒绝清理"改为遗忘路径。

## 9. 配置

**策略**（工作区设置 `storage`，由服务端统一管理；同名环境变量只作单机覆盖）

| 键 | 环境变量覆盖 | 默认 |
|---|---|---|
| `ttl_ms` | `MULTIREMI_GC_TTL_MS` | 72 小时 |
| `automation_ttl_ms` | `MULTIREMI_GC_AUTOMATION_TTL_MS` | 24 小时 |
| `max_retained` | `MULTIREMI_GC_MAX_RETAINED` | 50（0 为不限） |
| `orphan_ttl_ms` | `MULTIREMI_GC_ORPHAN_TTL_MS` | 72 小时 |
| `snapshot_max_bytes` | `MULTIREMI_GC_SNAPSHOT_MAX_BYTES` | 256 MB |
| `chat_idle_days` | — | 14（0 为不自动归档） |

**机器参数**（仅环境变量）：`MULTIREMI_GC_ENABLED`（默认 true）、`MULTIREMI_GC_INTERVAL_MS`（15 分钟）、`MULTIREMI_GC_DRY_RUN`（false）、`MULTIREMI_LEGACY_KEEP_DAYS`（7）。归档相关环境变量全部删除。

## 10. 历史数据与升级

历史 Issue/Chat 在 daemon 上的状态（工作区、原生会话、trace）作废，不迁移。服务端的 Issue、Chat、对话日志、轮卡片不动；重开历史主体时从分支新建工作区、从对话日志重建上下文。

daemon 升级后首次启动、领取任务之前执行一次清扫：

1. 对旧布局里每个 git 仓库（含嵌套的、独立克隆、裸仓库）按 §4 的规则检查：linked worktree 有未保存工作的打快照 ref；能从旧的 `gc.json` 认出主体的，写一条 `reclaimed` 登记，条目的 `dir` 是它在旧工作区目录下的路径，重开时可恢复；旧讨论会话工作区里 linked worktree 的未保存工作同样打快照 ref，放在 `refs/remi/snapshots/legacy/<目录名>/<序号>`，不写登记。旧 `.runtime` 里某一代目录下的 `home`、`task-tmp`、`.remi-runtime` 不遍历，其他位置同名的目录（如 agent 在 `work/` 里克隆的 `home`）照常检查。快照不了的（超限、git 检查失败、独立克隆或裸仓库里有未保存工作、无法列出的目录），其未保存工作只此一份：按原相对路径移到 `legacy-<日期>/retained/`，并记入 `legacy-<日期>/retained.json`（新旧路径、原因）；其中 linked worktree 靠着的旧缓存仓库若不能并入新缓存（新缓存里已有同名仓库），则连同它们一起保留到 `legacy-<日期>/retained/.repos/`。
2. `.repos` 移到 `shared/repos`，`.snapshots` 移到 `shared/code-views`，各仓库 `git worktree prune` 与 `repair`。
3. 其余旧条目整体移入 `legacy-<日期>/`，`MULTIREMI_LEGACY_KEEP_DAYS` 天后删除，但 `retained/` 与 `retained.json` 不删：存储报告以保留原因 `legacy_retained` 计其仍在磁盘上的条目数，由运维核对后手工删除；`_topics/` 保持原位。

## 11. 一次部署

代码按依赖分组合入 main，部署一次。CI 作业 `session-archive-platform` 随之更名为 `runtime-platform`（仍跑 ACP runtime 检查，ubuntu 与 macOS 两个矩阵项）；若分支保护直接列出了旧名，需由仓库管理员改为新名。部署当天：部署 API（跑迁移）→ 升级一台 daemon（清扫 → 存储页"预演一轮" → 人工核对清单 → "立即回收"）→ 升级其余 daemon，删除两台机器上关闭 GC 的 systemd 覆盖文件。老 daemon 在窗口内调用已删除的路由得到 404，按现有逻辑跳过清理，不需要过渡代码。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 快照遗漏数据 | 含未跟踪文件；被忽略的视为可重建；超限或失败则保留并上报，不删 |
| 升级清扫与第一轮回收量大 | 清扫只改名不删；先预演；单机先行；旧根目录保留 7 天 |
| 所有活跃会话升级后重置一次 | 迁移直接代 +1，上下文由对话日志重建 |
| 约 95% 历史尝试的执行过程不可看 | ZIP、旧表改名保留、`task_messages` 保留，需要时另写恢复脚本 |
| 自动化 Chat 淹没列表 | 安静运行自动归档；列表默认隐藏；24 小时保留 |
| 快照只在本机 | 重开落到其他 daemon 时只从分支恢复，快照 ref 仍在原机器 |
| 记录无限增长 | 单台每年约 10 GB 量级；主体硬删除会回收 |
| 升级清扫快照不了的旧仓库 | 移入 `legacy-<日期>/retained/` 并列入 `retained.json`，不随过期删除；报告以 `legacy_retained` 计数，运维手工删 |
| `du` 在生产根目录要跑数分钟 | 不进回收轮次：后台异步、每小时至多一次、`nice`、每类 30 分钟超时，缓存于 `.daemon/disk-usage.json`；报告带最近一次完成的测量 |
| 已迁走的 Issue 被误当作硬删除 | 服务端只对执行过它的 daemon 应答 `moved`；daemon 按已结束回收、永不遗忘；其他 daemon 仍得 404 |
| agent 在工作区顶层或深处放文件、自建仓库 | 顶层文件不影响回收；树里 6 层内的所有仓库（嵌套的、独立克隆、克隆的 worktree、兄弟 worktree）按同一套规则检查，快照或保留；更深的仓库不检查，随工作区删除 |

## 13. 未采用的方案

- **保留归档只读**：要继续维护 ZIP 读取、指针双轨与部署挂载；历史明细可由 ZIP 日后恢复。
- **迁移旧布局而不是作废**：需要旧路径适配；Claude 按工作目录编目会话，改名后仍要重置。
- **把原生会话历史挪到独立目录**：与就地清理所需的白名单相同，只多一次 rename。
- **wiki 放在运行环境里**：wiki 是工作成果，与代码同属工作集。
- **回收时把 wiki 改动自动提交为 submission**：会生成无人要求的待审条目。
- **自动化结果另设收件箱消息类型**：Chat 已有未读与归档，足以表达"有发现"和"安静"。
- **Issue 做成一组 Chat**：状态、层级、依赖、负责人没有落点。
- **有未保存工作就永久保留**（现状）：85% 的保留不是真的未保存工作，真正的未保存工作用快照即可保住。
