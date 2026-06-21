# Remi × Multiremi 融合目标

本文件是后续开发的目标说明和验收口径。当前目标不是继续维护一个旁挂的 Multica copy，而是在 Remi 项目内实现一个原生 Bun/TypeScript 版的 Multiremi，并让它具备对标当前 Go 版 Multica server 的能力。

## 0. 已确认决策

- 产品、包名、CLI、Release 名称统一叫 `multiremi`。
- Remi 内部 canonical 目录是 `src/multiremi/`。
- 完成态不再同时存在根目录 `multiremi/` 和 `src/multica/` 两套实现。
- Go 版 Multica server 是能力 parity 的主要参考，不是最终运行时。
- Bun/TypeScript 是最终实现语言；不接受 Go 代码作为运行时依赖。
- Provider 只需要支持 `claude` 和 `codex`，但这两个 provider 不应有“理论不支持”的能力缺口。
- Provider 层继续使用 Remi 内已有的 `packages/acp-provider` 和 `src/providers/acp` 作为 canonical，实现参考 Go 版 Multica provider 经验，但协议实现以最新 ACP 方向为准。
- 需要通过 parity matrix、测试和本地 smoke 验证证明 Bun 版可以替代 Go 版。

## 1. 当前状态

- `src/multiremi/` 已作为 Remi 内部 Bun/SQLite 实现的目标目录。
- `src/multica/` 已清理；后续只能作为历史名称出现在迁移/参考说明里。
- 根目录 `multiremi/` upstream monorepo copy 已从工作树删除；Go server、Next console、server-bun 只能作为外部参考，不再作为 Remi 的一等源码目录存在。
- 旧的 `multica_*` SQLite 表需要有一次性迁移到 `multiremi_*`，避免用户本地数据被孤立。

## 2. 完成态定义

### 2.1 目录与品牌

完成态只允许一个核心实现目录：

```text
src/multiremi/
```

必须清理：

```text
src/multica/
multiremi/
```

所有用户可见入口统一：

- CLI: `multiremi`
- Release binary/package: `multiremi`
- API 文案: `Multiremi`
- 环境变量: `MULTIREMI_*`
- HTTP headers: `x-multiremi-*`
- 默认本地数据表: `multiremi_*`

可以保留兼容迁移代码里对旧 `multica_*` 名称的识别，但不能把旧名称作为新接口或新文案继续暴露。

### 2.2 能力范围

Bun 版 Multiremi 要对齐 Go 版 Multica server 的关键能力面：

- daemon register/deregister/heartbeat/websocket
- runtime 管理、runtime claim、pending tasks、recover orphan tasks
- task start/progress/messages/session/usage/complete/fail/status/cancel
- daemon 侧 local skills、models、update request/result 流程
- auth、PAT、workspace、members、invitations
- agents、agent templates、skills、skill files
- projects、issues、comments、labels、attachments、reactions、subscribers、inbox
- squads、autopilots、webhooks、scheduler
- chat sessions/messages
- GitHub/Lark 等集成的可用 API 面，至少要明确支持、降级或标记为不在本期
- console API 与前端需要的查询/变更接口

如果某个 Go 版接口在 Bun 版暂时不实现，必须在 parity matrix 里写明原因、替代路径和验收状态；默认立场是补齐，而不是接受长期缺口。

### 2.3 Provider 与 ACP

本期 provider 范围只包含：

- `claude`
- `codex`

实现原则：

- canonical provider package 是 `packages/acp-provider`。
- `src/multiremi` 不应复制一份漂移的 ACP fork。
- Claude/Codex 的任务执行、流式消息、session resume、tool permission、cwd/env/model、usage 回传、取消信号都要走同一套 ACP provider 能力。
- Go 版 Multica provider 代码只作为行为参考；最终实现应是 Bun/TS + 最新 ACP。

### 2.4 Release 与安装

最终需要 GitHub Release 上发布 `multiremi` 包或二进制，使“添加电脑/安装 daemon”不再指向 `multimira` 或旧品牌。

最低验收：

- Release artifact 名称是 `multiremi`。
- install script 安装的是 `multiremi` CLI。
- UI 中的添加电脑命令展示 `multiremi`。
- `multiremi setup` / `multiremi daemon start` 可完成登录、配置、后台守护进程启动。

## 3. Parity Matrix 验收

后续开发必须维护一份 matrix，至少包含这些列：

| Area | Go source | Bun target | Status | Tests | Notes |
|---|---|---|---|---|---|
| Daemon lifecycle | `server/cmd/server/router.go` + handler | `src/multiremi/*` | missing/partial/done | test file | endpoint-by-endpoint |
| Runtime task claim | Go daemon task routes | `src/multiremi/api.ts` + store | missing/partial/done | test file | includes orphan recovery |
| Task reporting | Go task report APIs | `src/multiremi/client.ts` + API | missing/partial/done | test file | messages/session/usage |
| Provider Claude | Go provider behavior | `packages/acp-provider` | missing/partial/done | test/smoke | ACP streaming |
| Provider Codex | Go provider behavior | `packages/acp-provider` | missing/partial/done | test/smoke | ACP streaming |
| Auth/workspace | Go auth/workspace APIs | `src/multiremi` | missing/partial/done | test file | PAT/JWT/local |
| Console API | upstream console needs | `src/multiremi` | missing/partial/done | test/smoke | frontend contract |
| Release/install | old scripts/release | `multiremi` release | missing/partial/done | smoke | no Multimira branding |

`done` 的定义不是“有类似代码”，而是：

- API contract 可调用。
- Store/model 行为覆盖。
- Tests 覆盖正常路径和至少一个失败路径。
- 本地 smoke 证明 CLI/daemon/server 能串起来。

## 4. 推荐开发顺序

### P0: 命名与目录收敛

- 把 `src/multica/` 改为 `src/multiremi/`。
- 把 `remi multica` 改为 `remi multiremi` 或最终的 standalone `multiremi` CLI。
- 把 `/api/multica/*` 改为 `/api/multiremi/*`。
- 保留旧表迁移逻辑，但新表、新环境变量、新 header、新文案统一为 `multiremi`。

### P1: 建 parity matrix

- 从 Go router/handler/provider 反推接口清单。
- 与当前 `src/multiremi` 对照，标出 missing/partial/done。
- 每个 missing 项绑定一个目标文件和测试文件。

### P2: Daemon/runtime/task parity

- 先补 daemon 生命周期、claim、pending、task reporting、orphan recovery。
- 这是“添加电脑”和“容器准备/任务执行”体验的核心。

### P3: Provider parity

- 只做 Claude/Codex。
- 把 `packages/acp-provider` 打磨成唯一 provider 层。
- 确保 Multiremi daemon 和 Remi 对话/任务共用 ACP 能力。

### P4: Console/API parity

- 对齐 workspace、agents、skills、projects/issues/autopilots 等 console 需要的 API。
- 去掉硬编码 placeholder，或者在 matrix 明确不属于本期的降级接口。

### P5: Release/install

- 新增 `multiremi` CLI/release 构建脚本。
- 更新安装命令、添加电脑 UI、文档。
- 通过本地二进制 smoke。

### P6: 删除历史结构

- 删除根目录 `multiremi/` upstream copy。
- 确认没有 `src/multica/`。
- 确认没有运行时 import 指向 upstream copy。

## 5. 不接受的完成方式

- 不接受只把 upstream `multiremi/server-bun` copy 到仓库里当完成。
- 不接受 Go server 继续作为实际运行时。
- 不接受 `src/multica` 和 `src/multiremi` 长期并存。
- 不接受 UI/文案仍要求安装 `multimira`。
- 不接受 Claude/Codex provider 只有名称映射但缺少真实 ACP 行为。
- 不接受没有 parity matrix 和 smoke 验证就宣称替代 Go 版。
