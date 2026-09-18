# 测试与验证

命令从仓库根目录运行，使用 [package.json](package.json) 固定的 Bun 版本安装依赖。[bunfig.toml](bunfig.toml) 与各包测试配置决定发现范围。

## 按范围选择

| 范围 | 测试位置 / 入口 | 命令和前提 |
|---|---|---|
| 后端单元、接口、架构 | [tests](tests)：`unit/`、`integration/`、`arch/` 中的 `*.test.ts` | `bun test`；单文件用 `bun test <path>` |
| 前端单元与组件 | 源码旁的 `*.test.ts(x)`，各包 Vitest 配置 | `bun run test:frontend`；单包用 `bun run --filter @multiremi/core test` |
| 类型 | [后端 tsconfig](tsconfig.json)、前端各包配置 | `bunx tsc --noEmit`、`bun run typecheck:frontend` |
| 开发上下文 | [检查器测试](scripts/check-dev-context.test.mjs) | `npm run docs:test`、`npm run docs:check`；Node.js 22+，无需安装依赖 |
| API/CLI 契约 | [路由快照](scripts/snapshot-api-routes.ts)、[CLI 检查](scripts/check-cli-capabilities.ts) | `bun run scripts/snapshot-api-routes.ts --check`、`bun run cli:capabilities:check` |

后端测试集中在 `tests/`；前端测试随所属包运行。没有 `.test` 后缀的手动 harness 不由 `bun test` 自动发现。前端 UI 包是否提供 test 脚本以各自 package.json 为准。

## 后端测试入口

```bash
bun test tests/unit/multiremi/multiremi-api-issues.test.ts
bun test tests/arch/
```

API/store 测试可参考 [issues API 测试](tests/unit/multiremi/multiremi-api-issues.test.ts)的进程内 `app.request()`，共享夹具在 [helpers.ts](tests/unit/multiremi/helpers.ts)。需要真实服务的测试应在自身入口明确配置和隔离方式，不能把本地凭据或生产数据作为普通单测前提。

## 真实服务与手动验证

| 根脚本 | 验证内容 | 运行前准备 |
|---|---|---|
| `bun run e2e:frontend` | [Next ↔ Remi Bun API harness](tests/integration/e2e-frontend-ours.ts) | 已运行的 Web `:3000`、API `:6130`、PostgreSQL 与 `remi` 工作区；当前脚本从 Linux 的 `~/.cache/ms-playwright` 查找 Chromium，地址和工作区写在脚本中 |
| `bun run e2e:multiremi` | [server/daemon/任务链路](tests/integration/e2e-multiremi.ts) | provider CLI、凭据与 Chromium |
| `bun run smoke:multiremi:acp` | [ACP runtime 冒烟](tests/integration/smoke-multiremi-acp.ts) | 真实 ACP agent |
| `bun run tests/integration/smoke-runtime-workspace-acp.ts --provider=codex` | [持久化工作区原生验证](tests/integration/smoke-runtime-workspace-acp.ts)：Chat → 重启 daemon → Issue，核对本地上下文与文件保留 | 已登录的 Codex ACP；也支持 `--provider=claude`，会发送两个真实模型请求 |
| `bun run e2e:acp` / `bun run e2e:acp:full` | [ACP 冒烟](tests/integration/acp-e2e.ts) / [场景套件](tests/integration/acp-e2e-full.ts) | 对应 provider CLI 和凭据 |
| `bun run probe:feishu` | [飞书流式卡片](tests/integration/feishu-streaming-probe.ts) | 专用测试会话与飞书凭据 |
| `bun run replay:coverage` | [ACP fixture 重放检查](tests/integration/replay-coverage.ts) | 仓库内 fixture |
| `bun run smoke:chat` | 独立 Chat 页面、队列、会话管理和附件；隔离 Next ↔ Bun API ↔ 临时 SQLite，模拟 Agent 输出 | 前端依赖与 Chromium；不调用真实 provider |

`frontend/e2e/` 仍有继承的 Playwright 用例和上游登录/数据库假设；[配置](frontend/playwright.config.ts)只指定浏览器与 baseURL，不启动服务。它不能替代根 `e2e:frontend` 对 Remi Bun API 的验证。针对这些用例开发时，先核对 [env.ts](frontend/e2e/env.ts) 和实际 helper。

性能调查复用的 API、Store 和 PG bridge 脚本、采样条件及限制集中在[性能页](docs/dev/performance.md)，不把微基准结果视为用户端延迟。

## CI 覆盖

| 工作流 | 实际检查范围 |
|---|---|
| [dev-context.yml](.github/workflows/dev-context.yml) | PR / main push；Linux、Windows 上的 Node 检查器测试及默认文档阅读链校验 |
| [release-build-check.yml](.github/workflows/release-build-check.yml) | 按路径触发；后端套件、架构、CLI 能力、前端类型/测试、CLI 和容器构建、平台专项检查 |
| [release.yml](.github/workflows/release.yml) / [platform-release.yml](.github/workflows/platform-release.yml) | CLI 发布前校验依赖准备快照、tag 版本与同一 main 提交的全量 CI；平台发版条件遵循 [AGENTS.md](AGENTS.md) |

真实 provider、飞书和浏览器 harness 的成功不能由普通单测或构建绿灯推断。报告验证时写明实际命令、环境、结果和未覆盖项。

## 测试环境隔离与排查

`bun test` 通过 [bunfig.toml](bunfig.toml) 的 preload 在测试模块加载前执行 [hermetic-env.ts](tests/setup/hermetic-env.ts)，清除继承的产品配置和凭据。精确范围以纯模块 [hermetic-env-policy.ts](tests/setup/hermetic-env-policy.ts) 为准：清除 `MULTIREMI_*`、`REMI_*`、`ANTHROPIC_*`、`FEISHU_*` 及列明的独立变量，保留 `MULTIREMI_TEST_*`、`FEISHU_TEST_*` 测试输入。测试需要的环境变量由测试自己设置并还原；显式指定的测试数据库连接失败不能当作未配置而跳过。

`NODE_ENV`、`PATH`、`HOME`、`SHELL`、`USER`、`GIT_*` 和 `SQLITE_LIB_PATH` 等宿主能力仍保留；这不是文件系统或全局 Git 配置隔离。遇到 `core.hooksPath` 等环境差异，先定位实际影响，再在隔离进程中复现，不修改用户全局配置来掩盖失败。

[环境护栏测试](tests/arch/hermetic-test-env.test.ts)检查 preload 挂载、实际执行标记和变量泄漏；测试只导入 policy，不能通过直接导入 preload 自行清理后证明隔离成功。通过 `bun run` 执行的独立 harness 不加载该测试 preload，仍使用真实环境。
