---
title: 存储与保留
status: active
summary: daemon 磁盘布局、工作区回收与恢复、保留策略和运维入口。
---

# 存储与保留

daemon 上的东西分四类：工作区（代码目录）、运行环境（provider home 等）、记录（trace 与原生会话历史）、共享缓存（bare 仓库、代码视图）。
前两类是缓存，主体（Issue 或 Chat）结束后按保留期回收，删前保存未保存的工作；记录永久留在 daemon，服务端只保存指向它的指针。
决策与被否决的方案见 [ADR 0018](../adr/0018-local-records-and-recyclable-workspaces.md)（取代 [ADR 0006](../adr/0006-conversation-log-and-daemon-owned-traces.md) 的决策 5–9）。

## 目录布局

根目录是 `MULTIREMI_WORKSPACES_ROOT`（默认 `~/.remi/multiremi/workspaces`）。完整树和各目录含义见 [Runtime 持久化工作区](runtime-workspaces.md#daemon-存储布局)。要点：

- `registry/<主体>.json` 是 GC 的唯一输入，记录归属、仓库、分支、状态（`active` / `reclaimed`）和快照；每次执行开始都会更新。
- `work/<主体>/` 是共享工作区（Chat 的 cwd；Issue 持有者的 cwd 是 `env` 下会话线私有的 `work/`）；`env/<主体>/…` 是运行环境；`traces/<主体>/<tsk>.jsonl` 是记录。
- 路径只由 `packages/daemon/src/agent-runtime/workspace/layout.ts` 构造。
- 同时带 Chat 与 Issue 的执行（话题转发、项目绑定的 Chat）归 Chat；只带 Issue 归 Issue；两者都没有的按兜底主体 `tsk_*` 处理，规则同 Chat。
- 用户注册的本地目录（Runtime 工作区）永不回收；登记里记为 `external_work_dir`，只清理它的运行环境。

## 生命周期

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
| 结束 | Issue：done / completed / closed / cancelled，或服务端应答 `moved`（Issue 已迁到别的工作区）。Chat：被归档；不活跃超过 `chat_idle_days` 自动归档；归档的 Chat 收到新消息自动恢复活跃。自动化开的 Chat：运行完成且被标记为安静时自动归档 |
| 回收 | 结束后超过 `ttl_ms`（自动化 Chat 用 `automation_ttl_ms`）；或已结束且仍占用工作区的主体超过 `max_retained` 时淘汰最久未用的 |
| 不回收 | 有正在跑的执行；Chat 被置顶；Issue 未结束；外部目录（只清运行环境） |
| 旧一代运行环境 | 同一会话线下低于最高代的目录，修改时间超过 `ttl_ms` 后清理，不等主体结束；这一代里（私有 `work/`、provider home、插件运行目录）有无法保存的未保存工作时保留这一代 |
| 私有临时目录 | 执行结束即删；每轮删除 `env/*/tmp` 下不在运行的执行留下的残留（不要求主体有登记） |
| 硬删除 | 服务端 404 且最后使用超过 `orphan_ttl_ms`：linked worktree 有未保存工作先打快照 ref，再删工作区、运行环境、trace 和登记；独立克隆里有未保存工作则保留（`snapshot_failed`） |
| 已迁走的 Issue | `gc.check_issue` 应答 `moved` 只给执行过该 Issue 的 daemon（其他 daemon 仍得 404，避免被枚举）。daemon 视其为已结束：超过 `ttl_ms`（从最后使用算起，应答不带时间戳）后先快照再回收 `work/<iss>` 与运行环境，与已结束的 Issue 完全一致；但**永不遗忘**，trace、原生会话历史和登记都保留。之后若服务端对它应答 404（真被删除），才走硬删除 |
| 失败 | 任一步失败则保留并上报原因，下一轮重试；根目录所有权丢失中止整轮 |

话题工作区（`_topics/`）：未绑定对话且超过 `orphan_ttl_ms` 的，按同一套仓库检查，linked worktree 的未保存工作先打快照 ref（`refs/remi/snapshots/topic/<话题>/<序号>`）再删；无法保存的未保存工作使它保留，并在报告的 `errors` 里记下。

整棵工作区在话题与 Issue 之间移动时（话题迁入 Issue、已结束的话题 Issue 回到 `_topics/<话题>`，含回滚），里面的 linked worktree 要跟着登记：共享仓库记的是 worktree 的绝对路径，树一挪登记就过期，下一次 `git worktree prune` 会丢掉它们，worktree 随之损坏。所以挪动前列出树里的 linked worktree，挪动后立刻在各自所属的仓库里 `git worktree repair <新路径>`，之后才可能有 prune。挪动被打断的，下一轮开头完成迁移（`recoverTopicWorkspace`、`recoverIssueWorkspace`）时再修，同样先于该轮的 prune。修复失败只记日志，不撤销挪动。话题迁入的 Issue 已经有工作区时不是挪动而是复制（话题的条目逐个并入 `work/<iss>`）：复制出来的 worktree 在复制之后、删除话题目录之前同样 `git worktree repair`。只修 Issue 里确实是话题那份的拷贝：`.git` 文件与话题里的相同，或已被一次被打断的合并指向了复制出的仓库，所以重试被打断的合并时上次留下的拷贝也会被修好。worktree 的仓库也在话题里（agent 自己克隆的仓库和它的 worktree）时仓库一并复制，但复制品的 `.git` 仍指着话题里的原仓库，`git worktree repair` 会顺着它去修原仓库（旧版 git 把两边互相链接，原仓库一删复制品就坏了），所以先把 `.git` 改成指向复制出的仓库再 repair。Issue 在同一路径上已有自己的条目（比如 Issue 自己检出过同一个仓库）时没有 worktree 被复制：worktree 逐个文件合并，话题里 Issue 没有的文件并进去，内容不同的放进 `.multiremi/topic-artifacts/<迁移>/`，话题那份的 `.git` 指针文件不放进去（话题目录删掉后它指向的登记会被 prune，留下的只是一个谁也打不开的仓库，对这个 Issue 的每次检查都会失败）；克隆（有 `.git` 目录）和裸仓库不逐个文件合并，内容不同就整个放进 `.multiremi/topic-artifacts/<迁移>/`，原样可用，Issue 的那份不动。

回收一个主体的顺序：确认状态与锁 → 检查要删的树里的所有 git 仓库（见下）→ 仓库快照 → wiki 快照 → 删 worktree 与 `work/<主体>/` → 运行环境清到白名单（只留 `home/projects/`、`home/sessions/`、`home/session_index.jsonl`）→ 登记改为 `reclaimed` → 上报 RPC `gc.subject_reclaimed`。任何一步之前，凡会引起保留的检查都已做完，所以被保留的主体不会每轮多一个快照 ref。

**仓库检查**（[repo-inspection.ts](../../packages/daemon/src/agent-runtime/workspace/repo-inspection.ts)）是回收、遗忘、旧一代运行环境清理、过期话题工作区和升级清扫共用的一套规则，任何要删除或因过期而挪走的树都先过一遍：

- 发现：找树里所有名为 `.git` 的条目（文件或目录）和所有裸仓库（本身就是 git 目录的目录：有 `HEAD`、`objects/`、`refs/`，且通过下面的认定；不进入 git 自己放在里面的目录 `objects`、`refs`、`worktrees` 等，人放进去的照常找，比如在裸仓库里 `git worktree add feature` 加的 worktree），从树根起最多往下 6 层，仓库里面的仓库也找；只进入目录，不跟随符号链接，不进入 `.git` 和 `node_modules`；`wiki/`、`.multiremi/` 里 agent 留下的仓库同样会找到。树顶层的普通文件和符号链接（intake 的 `manifest.json`、agent 写的 `report.md`）不是仓库，不是保留的理由，随树一起删。无法列出的目录可能藏着仓库，整棵树保留并报告 `git_check_failed`。超过 6 层的仓库不检查，随树删除（但上级仓库的快照不会假装保存了它，见“处理”）。
- 裸仓库的认定：布局（`HEAD`、`objects/`、`refs/`）只是候选，还要过两关。一，外层仓库（最近一层含 `.git` 的上级）的索引里跟踪着它的 `HEAD`（`git ls-files`）的是项目内容，不是要判断的仓库：Gitea、libgit2 把裸仓库当测试夹具提交，干净的检出里它们没有任何未保存的东西；它当普通目录搜索，改动由跟踪它的仓库的检查和快照负责。外层仓库没有跟踪它（agent 在检出里自己建的）则照常判断。二，`git --git-dir=<目录> rev-parse --git-dir` 指认的必须正是这个目录（按 realpath 比较）：讲 git 内部结构的文档目录也有这三样，git 回答 `not a git repository` 的当普通目录搜索，里面的仓库照常找。git 给出别的失败（配置损坏、仓库格式版本不支持）的目录可能就是仓库，按无法列出的目录处理，整棵树保留并报告 `git_check_failed`。有 `.git` 的目录是工作树，不当裸仓库。
- 分类：按 `git rev-parse --git-common-dir` 的 realpath 判断。共同 git 目录是共享缓存里的仓库（默认 `shared/repos/<workspace>/<名>.git`；从缓存根到它之间没有别的 git 目录）的是 shared-linked；其余都是 standalone：独立克隆（`.git` 是目录）、独立克隆的 worktree、子模块（`.git` 是文件，但共同目录不在缓存里，或在某个仓库的 worktree 管理目录深处，随 worktree 一起清理，写在里面的 ref 活不过这棵树）、树里的裸仓库（总是 standalone，它在树里，随树删除）。
- 检查：每个仓库单独检查，嵌套在它里面的仓库不算它的内容，它们的路径从上级的 `status` 与快照里排除；树根本身是仓库时，`wiki/`、`.multiremi/`（daemon 自己的目录，wiki 另有快照）同样不算它的内容。shared-linked：有未提交或未跟踪的文件，或 HEAD 上有没有任何远端分支包含的提交（detached HEAD 停在某个分支上时不算，它随时可由分支重建，讨论会话的只读工作集就是这样；停在 tag 上不算数，因为缓存每次同步都会裁剪远端没有的 tag）。standalone：有未提交或未跟踪的文件，或任何 ref（侧分支、stash、tag 都算）上有没有任何远端分支包含的提交；没有远端且至少有一次提交的仓库一定有未保存工作。裸仓库没有工作树，不跑 `status`，只按同一条提交规则判断（`rev-list --all --not --remotes`；`git clone --bare` 不建 remote-tracking ref，这样的裸克隆算有未保存工作，要删掉，或像缓存仓库那样配置 `remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*` 后 `git fetch`）。远程是要被一起删掉的目录里的仓库的克隆（URL 是本机路径或 `file://`，realpath 落在这些目录里；回收和遗忘时是 `work/<主体>` 与 `env/<主体>`，旧一代清理时是那一代，升级清扫时是所有被清扫的旧条目）：这个远程随它一起消失，它的 remote-tracking ref 证明不了提交在别处，按没有这个远程处理；树外还有别的远程的，那些照常算数。
- 处理：shared-linked 有未保存工作则快照，条目记 `dir`。standalone 的仓库连同它的 ref 一起被删，没有地方能保存，所以有未保存工作就保留整个主体并报告 `snapshot_failed`；干净的 standalone 随树删除。子模块是自己的仓库，有改动同样按 standalone 处理。快照不会假装保存了没检查过的仓库：快照的临时 index 里出现 HEAD 里没有的 gitlink（超过搜索深度的嵌套仓库，`git add` 只会把它记成指向某个提交的指针，内容不进快照）就拒绝快照，整个主体保留并报告 `snapshot_failed`。这个检查在任何快照 ref 建立之前做完（先看 `status` 里作为一个未跟踪目录列出的嵌套仓库，临时 index 建好后再按 index 复核），所以被拒绝的主体不会每轮多一个快照 ref。
- 环境：所有 git 子进程都会先去掉从 daemon 继承来的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_NAMESPACE`、`GIT_CEILING_DIRECTORIES`，调用方显式设置的除外（快照自己的临时 index）。从 git hook 或 agent 的 shell 里启动的 daemon 否则会拿另一个仓库的状态判断每一棵树，把有未保存工作的树看成干净的。
- `dir`：快照条目总是记 `dir`。`work/<主体>` 里的仓库记相对它的路径（根目录为 `.`）；Issue 持有者的 cwd 和讨论会话的工作集在 `env/.../<代>/work/` 里，不是主体的检出位置，那里的 worktree 记相对工作区根目录的路径（`env/...`），恢复时不会落到任何检出里，ref 留待人工处理。
- 范围：`work/<主体>`、每个会话线每一代的整个目录：私有 `work/`，也包括 provider home 和插件运行目录（agent 能在这些地方留下仓库；清理要保留的原生会话历史 `projects/`、`sessions/`、`session_index.jsonl` 不检查）。每一代从它自己的各个条目起算 6 层。其中有无法保存的未保存工作时，回收和遗忘保留整个主体，什么都不删；旧一代清理只保留这一代，其余代照常清理，并在报告的 `errors` 里记下原因。dry run 同样检查。
- provider 自己的状态：直接在 `home/` 或 `executions/<指纹>/home/` 下的 `.tmp`、`tmp`、`plugins`、`vendor_imports`、`skills`、`cache`、`.cache`、`memories`、`memories_v2` 与原生会话历史一样不检查，清理照常删。它们由 provider 重建，不是 agent 的工作：Codex 每次启动都在 `$CODEX_HOME/.tmp/plugins` 克隆一个只有一次提交、没有远程的仓库，开启记忆功能时 `memories`、`memories_v2` 也是本地仓库，不跳过的话每个 Codex 主体都会被当成有独立克隆的未保存工作而永远保留。再深一层或在 home 之外的同名目录（比如 `work/` 里的 `plugins/`）照常检查。

服务端收到后：Issue 工作区记录标 `cleaned` 并保存快照信息；该主体在这台 daemon 上的会话线清空原生会话 id 并代 +1；Chat 清空原生会话字段。下一次执行因此直接用新一代 home，不做一次必然失败的续接。
服务端不可达时，上报内容写入 `.daemon/reports/`，下一轮补发。

## 快照与恢复

- 未保存的工作的定义见上“仓库检查”；子模块和嵌套仓库各算各的。
- 快照用临时 index 把整个工作树（含未跟踪文件，不含嵌套仓库）写成一次在 HEAD 之上的提交，保存为共享 bare 仓库里的 `refs/remi/snapshots/<主体>/<序号>`；只有未推送提交时快照就是 HEAD。被忽略的文件视为可重建，不进快照；工作区里仓库和 wiki 以外的文件同样不进快照。daemon 自己不给检出加忽略规则：agent 写的 `CLAUDE.md`、`AGENTS.md`、`.claude/`、`.opencode/` 不论在根目录还是更深处都可能是要提交的工作（仓库常把它们纳入版本管理），和其他文件一样，没被仓库或用户的 gitignore 忽略就出现在 `status`、进快照。
- 快照大小不得超过 `snapshot_max_bytes`；超限、独立克隆里有未保存工作、检查失败时保留工作区，并在存储报告里给出 `snapshot_failed` / `git_check_failed`。
- wiki 相对合并基线改动过的文件原样复制到 `registry/<主体>.snapshot/wiki/`，删除的路径记在 `deleted.json`。
- 恢复发生在同一台 daemon 上重开主体时，只按条目的 `dir` 找 worktree：条目只应用到恰好站在这个路径、且属于持有该 ref 的共享仓库的 worktree，同一仓库的兄弟 worktree（如 agent 自建的 `repo-experiment`）不会被当作目标，Issue 分支也不会因此移动。`dir` 与工作区都取 realpath 比较，路径沿途出现符号链接一律拒绝；`work/<主体>` 本身必须是真正的目录，它是符号链接（或不是目录）就整个拒绝（日志 `snapshot_restore_refused`，登记不动），否则保存的工作会落进链接指向的别的主体的检出里（它上面的 `work/` 可以是运维放到别的盘的链接，这不受影响）。
- 条目记了 `branch` 的，目标 worktree 还必须站在这个分支上（或 detached 在记录的 `head`）：agent 在回收前切到别的分支上做的工作，不会把重开后检出的 Issue 分支快进到从未在这个分支上做过的提交上。不符的条目和没有 worktree 的一样等待。记为 detached 的条目（`branch` 为空）不受此限。目标 worktree 的 HEAD 若是快照 HEAD 的祖先，则快进到快照 HEAD 并把快照工作树还原为未提交改动；分叉时不动，记录 `snapshot_restore_diverged` 与 ref，留待人工处理。wiki 在重新物化后覆盖快照文件。恢复失败只记日志，不阻塞执行。
- 还没有 worktree 站在其 `dir` 上的条目、以及站着的 worktree 不在记录的分支上的条目留在登记里等待，日志里报告 `snapshot_restore_pending`；登记保持 `reclaimed`，直到没有条目在等 worktree，之后的检出仍能恢复。
- `dir` 在 `env/` 下的条目（会话线某一代的私有 `work/`、provider home 里的 worktree 的快照）只是参考：新的一代里没有地方可以恢复它们，ref 留在仓库里待人工处理。它们随回收一起上报一次（`unsaved_work`），不使登记保持 `reclaimed`，也不在每次启动时告警；重开后的第一次恢复把它们从登记里摘掉，已经 `reclaimed` 的登记在下一次回收时也不再带着它们，所以不会重复上报。
- 快照只在本机；重开落到另一台 daemon 时只从分支恢复。

## 策略

策略是工作区设置 `settings.storage`，由服务端统一管理，经现有 `workspace.settings` 下行下发给 daemon。契约、默认值和范围见 [storage.ts](../../packages/contracts/src/storage.ts)。

| 键 | CLI 选项 | 环境变量覆盖（单机） | 默认 |
|---|---|---|---|
| `ttl_ms` | `--ttl-ms` | `MULTIREMI_GC_TTL_MS` | 72 小时 |
| `automation_ttl_ms` | `--automation-ttl-ms` | `MULTIREMI_GC_AUTOMATION_TTL_MS` | 24 小时 |
| `max_retained` | `--max-retained` | `MULTIREMI_GC_MAX_RETAINED` | 50（0 为不限） |
| `orphan_ttl_ms` | `--orphan-ttl-ms` | `MULTIREMI_GC_ORPHAN_TTL_MS` | 72 小时 |
| `snapshot_max_bytes` | `--snapshot-max-bytes` | `MULTIREMI_GC_SNAPSHOT_MAX_BYTES` | 256 MiB |
| `chat_idle_days` | `--chat-idle-days` | — | 14（0 为不自动归档） |

机器参数只读环境变量：`MULTIREMI_GC_ENABLED`（默认 true）、`MULTIREMI_GC_INTERVAL_MS`（15 分钟）、`MULTIREMI_GC_DRY_RUN`（false，只出计划不动手）、`MULTIREMI_LEGACY_KEEP_DAYS`（7）。部署环境变量见 [daemon 环境说明](../deploy/66-8-remi-environment.md)。

读写：`GET/PUT /api/workspaces/:id/storage`（PUT 仅 owner/admin，`null` 把某项重置为默认）；CLI 为 `remi workspace storage get|set <workspace>`，`set` 用 `--reset <选项>` 重置。设置页的「存储」页提供同样的表单。

## 记录

- trace 由 daemon 实时写入 `traces/<主体>/<tsk>.jsonl`，格式 `multiremi.trace.v1` 不变；`GET /api/turns/:id/trace` 经 `trace.read` RPC 读取。
- `multiremi_task_traces.location` 只剩 `daemon | none | lost`。daemon 离线时读取返回 `unreachable`；daemon 下线或 Runtime 删除时指针标 `lost`，下线计划里的 `traces_to_lose` 给出受影响数量。
- 原生会话历史（Claude `projects/`、Codex `sessions/`、`session_index.jsonl`）由 provider 写在 home 里，回收时保留，路径不变。
- 记录随主体硬删除一起删除，除此之外不回收。

## 自动化 Chat

`run_only` 自动化每次运行新开一个 Chat（记录 `origin_autopilot_id` / `origin_run_id`，运行记录保存 `chat_session_id`）。运行中的 agent 若判断没有值得报告的内容，执行 `remi automation quiet`（`POST /api/turns/:id/automation/quiet`）；运行完成且为安静时自动归档该 Chat，其余情况保持活跃并带未读。失败的运行永远不是安静运行。
Chat 列表默认只显示用户的对话，`origin=automation|all` 筛选自动化与全部。

## 运维

查看：

```bash
remi runtime storage <runtime>              # 该 Runtime 所在 daemon 的最近一份存储报告
```

设置页「存储」页展示同一份报告：按 daemon 的占用（work / env / traces / shared / legacy）及测量时间、主体数、保留原因、上轮释放量。计划里每个主体的大小不测量（`bytes` 为空）：回收轮次里不运行 `du`。上轮释放量（`freed_bytes`）是近似值：取回收前后文件系统空闲空间之差（读一次 `statfs`，不遍历目录），期间其他进程写入的数据会抵消一部分，文件系统可能延迟回收空间，压缩或带快照的文件系统上它与文件大小也不对应；空闲空间变小时记 0。只作参考，不要拿它对账。

上报规则：daemon 每个周期回收轮次（包括 `MULTIREMI_GC_DRY_RUN` 下只出计划的轮次）都发 `gc.storage_report`，服务端按 daemon 只保留最近一份；运维用 `runtime.gc_run` 请求的预演（`dry_run`）**只**通过 `runtime.gc_run_result` 回报，不发 `gc.storage_report`，所以预演不会覆盖设置页上的“最近一份周期报告”。两条路径出去的报告都经过同一个大小限制（计划最多 2000 项，先留会改动的项再留最大的保留项；错误最多 100 条、每条 1000 字符），以便装进 1 MiB 的帧。

占用字节不在回收轮次里测量，避免 `du` 拖慢或拖垮一轮：daemon 在后台异步测量，每小时至多一次，或在 `runtime.gc_run` 请求时立即重新测量；每个类别（work / env / traces / shared / legacy）单独 30 分钟超时，`du` 以 `nice -n 19` 运行；一次测量的五个类别都完成才算数，结果写入 `.daemon/disk-usage.json`（含 `measured_at`）。每份报告（`StorageReport.bytes` 与 `bytes_measured_at`）都带最近一次**已完成**的测量，一次测量完成过之后不再为空；正在跑、超时或失败的测量既不阻塞也不使任何一轮失败，上一次的数字继续使用。请求 `runtime.gc_run` 时本次报告里仍是上一次的数字，新的测量完成后体现在下一份周期报告里。

预演与立即回收：

```bash
remi runtime gc <runtime> --dry-run --wait  # 只出计划：每个主体 reclaim / keep、原因、是否有未保存工作
remi runtime gc <runtime> --yes --wait      # 真正回收一轮
remi runtime gc-status <runtime> <request>   # 读取未带 --wait 创建的请求
```

对应 `POST /api/runtimes/:id/gc-runs`（`mode: dry_run | run`）和 `GET /api/runtimes/:id/gc-runs/:requestId`。请求沿用 Runtime 请求表模式，十分钟未完成标为 `timeout`；超时后才到达的结果会替换 `timeout`，计划照常显示。预演的计划包含保留项，周期轮次的报告只含非保留项。

保留原因：`running`（有执行在跑）、`pinned`、`not_ended`、`within_ttl`、`external_dir`、`snapshot_failed`、`git_check_failed`、`server_unreachable`、`legacy_retained`、`error`。出现 `snapshot_failed` 说明有超限或无法快照的未保存工作（独立克隆、独立克隆的 worktree、子模块里的，含 Issue 会话线私有 `work/` 里的），需要人工处理（推送或删除）后才会回收；`errors` 里的消息给出具体路径。`legacy_retained` 不是主体，而是升级清扫留下、仍在磁盘上的旧 worktree 的个数，见下。

升级清扫：daemon 升级后首次启动、领取任务之前执行一次（标记文件 `registry/.layout-v1`）。对旧布局里每个 git 仓库（含嵌套的、独立克隆的、裸仓库）按上面的规则检查：linked worktree 有未保存工作的先打快照 ref（能从旧 `gc.json` 认出主体的，写一条 `reclaimed` 登记，条目的 `dir` 是它在旧工作区目录下的路径，重开时只恢复到新工作区里同一路径上的 worktree）；旧讨论会话工作区里有未保存工作的 linked worktree（只读工作集停在分支上的没有）同样打快照 ref，但放在 `refs/remi/snapshots/legacy/<目录名>/<序号>` 下，不写任何登记：讨论没有可以恢复进去的主体，更不会混进 Issue 的恢复条目；`.repos` 移到 `shared/repos`，`.snapshots` 移到 `shared/code-views`；其余旧条目整体移入 `legacy-<日期>/`，`MULTIREMI_LEGACY_KEEP_DAYS` 天后由 GC 删除。`_topics/` 保持原位。清扫只改名不删。

旧 `.runtime` 里的 provider 状态不遍历：只有一代目录（`.runtime/<会话>/<agent>/[delegations/<id>/]<代>[/executions/<指纹>]/`）下的 `home`、`task-tmp`、`.remi-runtime` 才跳过（`work/` 与它们并列；Chat 的一代没有 `work/`），其他任何位置同名的目录（比如 agent 在 `work/` 里克隆的名为 `home` 的仓库）照常检查；到处都跳过的只有 `node_modules`。

快照不了的旧仓库（超限、git 检查失败、独立克隆、其 worktree 或裸仓库里有未保存工作）里的未保存工作只此一份，不能随 `legacy-<日期>/` 过期：清扫把它们按原相对路径移到 `legacy-<日期>/retained/<原路径>`（它们里面的 linked worktree，只要仓库在缓存里或也在被保留的树里，在搬完后立刻 `git worktree repair`，仍可用；嵌套在被保留仓库里的仓库随它一起移，不单独列出），在 `legacy-<日期>/retained.json` 里记下新旧路径、原因和错误。保留下来的 linked worktree 靠着缓存里的仓库才有分支和提交：旧缓存整个搬到 `shared/repos` 时它们跟着走；新缓存里已经有同名仓库（清扫前就克隆过）、旧的无法合并时，旧仓库连同它们一起保留到 `legacy-<日期>/retained/.repos/<workspace>/<名>.git`（不列入 `retained.json`，也不计入 `legacy_retained`，但同样永不被过期删除；其中的快照 ref 已复制进新缓存），这样提交不会随 `legacy-<日期>` 过期一起消失。运维清理保留的 worktree 后，对应的 `retained/.repos/` 也由运维清理。已知的例外：被保留的 worktree 属于旧目录树里 agent 自建的克隆（或裸仓库），而那个克隆本身没有未保存工作、没有被保留时，克隆随 `legacy-<日期>` 过期删除，worktree 里的文件（含未提交的改动）完整，但它的 `.git` 指着已经移走的仓库；要用它，先取出文件，或把 `.git` 改指另一份克隆再 `git worktree repair`。无法列出的目录同样移入 `retained/`（先放开它的权限才能移）；本用户既读不了也移不动的（比如容器以 root 建的目录）留在原处，只记一条 warn，不让清扫卡住 daemon 启动。`legacy-<日期>` 过期时**除 `retained/` 与 `retained.json` 外**全部删除；daemon 永不删这两项，存储报告把仍在磁盘上的条目数记为保留原因 `legacy_retained`，由运维核对后手工删除（`retained/` 下删空后该计数归零，留下的两个空壳也由运维清理）。

首次上线建议：先在一台 daemon 上升级，等清扫完成后 `--dry-run` 核对清单，再 `--yes` 回收，然后升级其余 daemon。生产 daemon 此前用 systemd 覆盖文件设置了 `MULTIREMI_GC_ENABLED=false`，升级后必须删除该覆盖文件并重启一次，否则周期回收仍然关闭。

## 验证

```bash
bun run test tests/unit/remi tests/unit/shared/storage-settings.test.ts
bun run test tests/arch/
bun run test tests/unit/daemon/reclaim-decision.test.ts tests/unit/daemon/reclaim-engine.test.ts tests/unit/daemon/reclaim-topics.test.ts tests/unit/daemon/disk-usage.test.ts tests/unit/daemon/legacy-sweep.test.ts tests/unit/daemon/repo-inspection.test.ts tests/unit/daemon/git-ops.test.ts tests/unit/daemon/env-cleanup.test.ts tests/unit/daemon/restore.test.ts
```

daemon 侧回收与布局的单测位于 `tests/unit/daemon/`，使用真实 git 和临时根目录。`safe-remove.test.ts` 在 CI（ubuntu-latest）上同时跑 Linux 与 darwin 两种寻址策略，macOS 本机只跑 darwin 一种；它的描述符断言比较“每次尝试打开的个数相同、且全部关闭”，不写死各策略的个数。改动安全删除后，在 Linux 容器（Bun 1.3.14 与 `git`）里补跑 `bun test tests/unit/daemon/safe-remove.test.ts`。仓库检查、回收和升级清扫的用例里有依赖文件权限的（无法列出或移动的目录），root 下自动跳过；在容器里以非 root 用户补跑 `repo-inspection`、`reclaim-engine`、`legacy-sweep`、`git-ops`、`env-cleanup`、`restore`，这些用例才真正执行。
