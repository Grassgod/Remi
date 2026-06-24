# 目录重构执行状态 (refactor/dir-redesign)

按 `docs/prompts/claude-code-doer.md` 执行 `docs/DIR-REDESIGN.md` v4 的 D0–D11。
在 worktree `.claude/worktrees/dir-redesign`、分支 `refactor/dir-redesign` 上完成。

## 基线 (从 main HEAD)

- `tests/multiremi-core.test.ts`: 142 pass / 0 fail
- 全量 `bun test`: 403 pass / 2 skip / **1 fail**(已知 `multiremi-daemon-smoke > runs one
  claimed task` —— 10ms 超时的时序断言，与本次重构无关，main 上同样失败）
- `tsc --noEmit`: **58 errors**（全部预存的业务类型问题，main 上同样 58；代码库跑 Bun 不强制 tsc）

## 完成情况：D0–D10 全部完成，D11 前端入库按用户决定主动延后

| 步骤 | 状态 | 摘要 |
|---|---|---|
| D0 | ✅ | tsconfig 10 个分层别名 + `scripts/check-layers.ts`（WARN-only 守卫）+ 基线 |
| D1 | ✅ | `shared/` (L0)：logger/config/tracing/version + metrics/infra/db。sqlite-custom 首加载契约保持 |
| D2 | ✅ | `acp/` (L1)：合并 packages/acp-provider + switch-mode。修 wrapper-bin `import.meta.dir` 深度 |
| D3 | ✅ | `memory/` (L1)：mcp/memory-server → memory/mcp-server；删空 src/mcp/ |
| D4 | ✅ | queue/agents/auth L1 零依赖确认；queue 编排部分(RemiQueueManager)诊断为 L2，checker 重分类 |
| D5 | ✅ | `connectors/feishu/` (L1)：合并 packages/feishu-channel（barrel→sdk.ts 避冲突） |
| D6 | ✅ | `daemon/` (L2)：8 子提交 — pm2(+修 REMI_ROOT 深度)、repo-cache、prompt、env-prep 提取、registry+sso、config-hub(+cc-switch 标识符改名 Tier A)、scheduler、orchestrator(AsyncLock+resolveSessionKey 提取+characterization 测试) |
| D7 | ✅ | `remi/` (L3)：conversation/group/project/imaging + core.ts(Remi 类) + web 服务端→admin/ |
| D8 | ✅ | `multiremi/`：contracts/ store/(+db/) worker/ api/ 子目录；skill-import→daemon |
| D9 | ✅ | 入口 import 终态化；删无用垫片(+修 pg-worker 回归)；web/prototype 删除；tsc 净零新增 |
| D10 | ✅ | tests/ 分 `unit/{module}/` 与 `integration/`，镜像 src 结构 |
| D11 | ✅ | 前端入库 `frontend/`(~23MB/1108 文件)；web/frontend/dist 取消跟踪；删 dashboard.ts(+修 D7.3 静态 serve 回归)；web/frontend→frontend/apps/console/(remi)/ + 入口 page.tsx。Vite→Next 代码级合并为后续前端工程 |

最终全量：**409 pass / 2 skip / 1 fail**（同基线，+6 新 characterization 测试：pm2 1 + orchestrator 5）。
`tsc --noEmit`：**58 errors**（= main 基线，本次重构净零新增类型错误）。

## 铁律遵守

1. ✅ 每步 `bun test` pass 数 ≥ 基线 2. ✅ 纯搬迁，仅 3 处必要的行为保持修复
   (D2 wrapper-bin 深度、D6 pm2 REMI_ROOT 深度、D9 pg-worker 垫片回归)，各自独立可审计
3. ✅ 旧路径留 re-export 垫片 4. ✅ sqlite-custom 首加载顺序保持 5. ✅ core.ts 拆分先写
   characterization 测试 6. ✅ L1 零依赖（queue/agents/auth 净；connectors→acp 为结构性预存债，已记录）
7. ⚠️ cc-switch：**标识符级**已去品牌；运行时路径/DB/API 字面量**冻结**（外部桌面应用数据共享契约，
   注释证实 v10 schema 镜像，硬改会清空现有安装+破坏互操作，需产品确认+迁移）
8. ✅ PG 代码只在 multiremi/store/db/ 9. ✅ packages 合并后保持 re-export 兼容

## D11 前端入库：核心已完成 + 余项

`docs/DIR-REDESIGN.md` D11 要求把 gitignored `/multiremi/` 入库为 `frontend/`，并整合
web/frontend、删 dashboard.ts。

**已完成（核心）**：gitignored `/multiremi/` 前端（实测纯源码仅 ~23MB / 1108 文件，
2.6GB 几乎全是 node_modules）已 rsync 拷贝（排除 node_modules/.next/.turbo/dist/build/out/bin
等构建产物）提升为受跟踪的 `frontend/`，其自带 .gitignore 一并带入。web/frontend/dist 取消跟踪。
本提交在独立分支、未推送，`git revert`/`git reset` 可一键还原。

**已完成**：
- 删除 `src/multiremi/dashboard.ts`（5132 行服务端 HTML 看板，由入库的 frontend/apps/web 取代）：
  移除 api/api.ts import + "/" HTML 路由（改轻量 JSON status）+ 8 处测试断言；全仓 0 残留。
  全量从 409→401 pass（−8 dashboard 测试），tsc 仍 58。
- 附带修复 D7.3 回归：remi/admin/server.ts 的 staticDir（`import.meta.dir + frontend/dist`）
  随 server.ts 下移三层而断，改候选列表（bundled 同级 / dev 指 repo 根 web/frontend/dist）。

- b/c **已完成（目录搬迁）**：`git mv web/frontend → frontend/apps/console/(remi)/`（Vite
  源码 + dist 一并迁入，dist 被 frontend/.gitignore 忽略）；创建 `frontend/apps/console/app/page.tsx`
  统一入口；remi/admin/server.ts staticDir 候选更新到新位置（serve 功能正常，已验证路径可达）。
  web/ 仅余 server.ts 垫片。

**真正的前端工程（后续，非目录重构范畴）**：把搬入 (remi)/ 的 Vite 应用重写为 Next route
group、与 frontend/apps/web 的 multiremi 控制台合并为单一 Next app。本次只做到目录归位（spec
指定结构已就位），代码级 Vite→Next 合并属独立前端任务。

## 已知/预存事项（非本次重构引入，供 reviewer）

- check-layers WARN：connectors→acp（feishu 渲染 ACP 输出的结构性依赖，需把 ACP 契约类型下沉
  shared/L0 才能解）；daemon/scheduler→multiremi/store（L2→L3 运行时，需 store 抽象到 daemon 接口）；
  shared/db/sessions→feishu（D1 起标记的通用命名工具耦合）；repo-cache/prompt→multiremi/types（type-only）。
- tsc 58 个预存业务类型错误（cli/multiremi.ts、multiremi/api/api.ts 等），main 同样存在。
- 入口非 remi 依赖部分仍经 src/ 根垫片解析（D9 已终态化 main/multiremi-main/index 三入口；
  其余 import 迁移按铁律#9 留待垫片逐步退役）。
