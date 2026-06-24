# Prompt: Claude Code — 目录重构执行者

你是一个代码重构执行者。你的任务是按照 `docs/DIR-REDESIGN.md` 的设计,把当前仓库的目录结构重排成分层积木架构。

## 你要做什么

按 `docs/DIR-REDESIGN.md` §7 的 D0→D11 序列,逐步执行纯目录/层级重构。**行为零变更**——只搬家、改 import 路径、留 re-export 垫片。

## 执行前必读

1. 完整阅读 `docs/DIR-REDESIGN.md`（v4 最终版）——这是你的唯一规范。
2. 运行 `bun test tests/multiremi-core.test.ts` 记录基线（应为 142 pass / 0 fail）。
3. 运行 `bun test` 记录全量基线。

## 每一步的执行模式

对每个步骤 D0–D11:

```
1. 声明目标: "D{n}: 做什么,成功标准是什么"
2. 执行:
   - git mv 文件到新位置
   - 更新所有 import 路径（用 grep 找、sed 改,或手动）
   - 旧路径创建 re-export 垫片: export * from '新路径'
   - 对于 packages/ 合并: 把文件搬进 src/,原 package 保留垫片
3. 验证:
   - bun test — pass 数不低于基线
   - tsc --noEmit — 类型检查通过（如适用）
   - grep 确认没有悬空 import
4. 提交: 每步一个 commit,message 格式 "refactor(dir): D{n} — 具体做了什么"
5. 如果验证失败: 停下,诊断,修复,重新验证。不要跳过。
```

## 步骤详解

### D0: 基础设施准备
- 在 tsconfig.json 添加路径别名: `@shared/*`, `@acp/*`, `@memory/*`, `@queue/*`, `@agents/*`, `@connectors/*`, `@auth/*`, `@daemon/*`, `@remi/*`, `@multiremi/*`
- 创建 `scripts/check-layers.ts`: 扫描 src/ 的 import 图,按 DIR-REDESIGN.md §3 的分层规则报告违规。本步只输出 WARN,不阻断。
- 记录测试基线。

### D1: shared/ (L0)
- 搬: `src/logger.ts`, `src/config.ts`, `src/tracing.ts`, `src/version.ts` → `src/shared/`
- 搬: `src/metrics/`, `src/infra/` → `src/shared/`
- 搬: `src/db/`（不含 multiremi 的 sql-database.ts/pg-worker.ts）→ `src/shared/db/`
- ⚠️ **关键**: `shared/db/sqlite-custom.ts` 必须保持是 `main.ts` 和 `multiremi-main.ts` 的首行 import。搬完后用 grep 验证。
- 旧路径全部留垫片。

### D2: acp/ (L1)
- 把 `packages/acp-provider/src/` 的所有文件搬到 `src/acp/`
- 把 `src/providers/base.ts` 搬到 `src/acp/provider.ts`（或合并）
- 把 `src/providers/acp/` 的 adapters 搬到 `src/acp/adapters/`
- 把 `src/switch-mode.ts` 搬到 `src/acp/switch-mode.ts`
- `packages/acp-provider/src/index.ts` 改为 re-export from `../../src/acp/index.js`
- `src/providers/` 旧路径留垫片
- 验证: 所有 `from '@remi/acp-provider'` 和 `from './providers'` 的 import 仍然 work

### D3: memory/ (L1)
- 搬: `src/memory/*` → `src/memory/`（原位提升为 L1,确认不再被 remi 独占）
- 搬: `src/mcp/memory-server.ts` → `src/memory/mcp-server.ts`
- 旧路径留垫片

### D4: queue/ agents/ auth/ (L1)
- `src/queue/` — 已在位,确认它不 import 任何 L1 同级块（如果有,需要解耦）
- `src/agents/` — 已在位,同上
- `src/auth/` — 已在位,同上
- 运行 check-layers.ts 确认 L1 之间零依赖;如果有违规,修复。

### D5: connectors/ (L1)
- 把 `packages/feishu-channel/src/` 搬入 `src/connectors/feishu/`（合并现有）
- `packages/feishu-channel/src/index.ts` 改为 re-export
- 旧路径留垫片

### D6: daemon/ (L2) — 最复杂的一步
- **先写 characterization 测试**: 对 `src/core.ts` 的关键行为写测试,锁住现有行为。
- 创建 `src/daemon/` 目录结构（见 DIR-REDESIGN.md §1）
- 搬编排逻辑: `src/core.ts` 中的消息路由、lane queue、provider 选择、session 管理 → `src/daemon/orchestrator.ts`
- 搬 agent-runtime:
  - `src/multiremi/daemon.ts` 中 `writeAgentSkillContext` + 相关环境准备 → `daemon/agent-runtime/skills/ephemeral.ts` 等
  - `src/multiremi/repo-cache.ts` → `daemon/agent-runtime/repo/`
  - `src/multiremi/prompt.ts`（通用部分）→ `daemon/agent-runtime/prompts/ephemeral.ts`
  - `src/plugins/config-hub/` 各模块 → `daemon/agent-runtime/` 各能力目录的 persistent
- 搬 plugins: `src/plugins/registry.ts` + `src/plugins/sso/` → `daemon/agent-runtime/plugins/`
- 搬: `src/pm2.ts` → `daemon/pm2.ts`; `src/multiremi/scheduler.ts` → `daemon/scheduler.ts`
- **注意**: core.ts 拆分后,remi 特有的逻辑（memory 注入、daily journal）留给 D7 搬进 remi/。
- 不再使用 cc-switch 命名: 改路径 `~/.cc-switch/` → `~/.remi/`, 改 DB 名, 改 API 前缀。

### D7: remi/ (L3)
- 搬: `src/conversation/`, `src/group/`, `src/project/`, `src/imaging/` → `src/remi/`
- 搬: `src/core.ts` 中 remi 特有逻辑 → `src/remi/`
- 搬: `web/server.ts` + `web/handlers/` + `web/auth.ts` + `web/remi-data.ts` → `src/remi/admin/`
- 删除 `src/mission/` 相关残留（如果有）
- 旧路径留垫片

### D8: multiremi/ (L3)
- `src/multiremi/store.ts` → `src/multiremi/store/store.ts`（仅移目录）
- `src/multiremi/api.ts` → `src/multiremi/api/api.ts`（仅移目录）
- `src/multiremi/types.ts` → `src/multiremi/contracts/types.ts`
- `src/multiremi/daemon.ts`（执行逻辑）+ `client.ts` + `task-failure.ts` → `src/multiremi/worker/`
- `src/multiremi/sql-database.ts` + `pg-worker.ts` → `src/multiremi/store/db/`
- `src/multiremi/builtin-skills.ts` → `src/multiremi/` setup
- `src/multiremi/skill-import.ts` → `src/daemon/agent-runtime/skills/`
- `src/multiremi/agent-templates.ts` → `src/multiremi/api/`

### D9: 清理
- 更新 `src/main.ts`, `src/multiremi-main.ts`, `src/index.ts` 的 import 路径
- 删除不再需要的垫片（只删确认无外部使用的）
- `dist/`, `log/` 加入 .gitignore,从 git 移除
- `web/prototype/` 删除
- 运行 `tsc --noEmit` 确认类型通过

### D10: tests/
- 创建 `tests/unit/` 和 `tests/integration/` 目录
- 把现有测试按模块归入 `tests/unit/{shared,acp,memory,queue,agents,daemon,remi,multiremi}/`
- 跨模块测试和 e2e 归入 `tests/integration/`
- 确保每个单元测试文件可独立运行

### D11: frontend/（独立,可最后做）
- 把 gitignored `multiremi/` 目录提升为 `frontend/`（入库）
- 把 `web/frontend/` 整合进 `frontend/apps/console/(remi)/`
- 创建入口页 `frontend/apps/console/app/page.tsx`
- 删除 `src/multiremi/dashboard.ts`（先迁 8 处测试断言）
- 删除 `web/frontend/dist/`（不跟踪构建产物）

## 铁律

1. **每步 `bun test`**: pass 数不低于基线。失败就停,修复,不跳过。
2. **纯搬迁**: `git diff` 每行是机械移动/re-export。不"改善"、不"重构"逻辑。
3. **re-export 垫片**: 每个搬走的旧路径留 `export * from '新路径'`。
4. **sqlite-custom**: 搬到 `shared/db/` 后验证首加载顺序。
5. **L1 零依赖**: 如果发现 L1 块之间有 import,先解耦再搬。
6. **core.ts 拆分**: D6 前先写 characterization 测试。这是风险最高的一步。
7. **不出现 cc-switch**: 所有路径/命名/DB 改成 remi 品牌。
8. **PG 只在 multiremi**: `shared/db/` 不含 PG 代码。
9. **每步一个 commit**: message 注明 "refactor(dir): D{n}"。
