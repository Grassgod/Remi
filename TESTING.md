# 测试与验证

命令从仓库根目录运行，使用 [package.json](package.json) 固定的 Bun 版本安装依赖。[bunfig.toml](bunfig.toml) 与各包测试配置决定发现范围。

## 按范围选择

| 范围 | 测试位置 / 入口 | 命令和前提 |
|---|---|---|
| 后端单元、接口、架构 | [tests](tests)：`unit/`、`integration/`、`arch/` 中的 `*.test.ts` | `bun run test`；单文件用 `bun run test <path>` |
| 前端单元与组件 | 源码旁的 `*.test.ts(x)`，各包 Vitest 配置 | `bun run test:frontend`；单包用 `bun run --filter @multiremi/core test` |
| 类型 | [后端 tsconfig](tsconfig.json)、前端各包配置 | `bunx tsc --noEmit`、`bun run typecheck:frontend` |
| 开发上下文 | [检查器测试](scripts/check-dev-context.test.mjs) | `npm run docs:test`、`npm run docs:check`；Node.js 22+，无需安装依赖 |
| API/CLI 契约 | [路由快照](scripts/snapshot-api-routes.ts)、[CLI 检查](scripts/check-cli-capabilities.ts) | `bun run scripts/snapshot-api-routes.ts --check`、`bun run cli:capabilities:check` |

后端测试集中在 `tests/`；前端测试随所属包运行。没有 `.test` 后缀的手动 harness 不由 `bun test` 自动发现。前端 UI 包是否提供 test 脚本以各自 package.json 为准。

## 后端测试入口

```bash
bun run test tests/unit/multiremi/multiremi-api-issues.test.ts
bun run test tests/arch/
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
| [release-build-check.yml](.github/workflows/release-build-check.yml) | 按路径触发；后端套件（仅 main push 和手动运行）、架构、CLI 能力、前端类型/测试、CLI 和容器构建、平台专项检查 |
| [release.yml](.github/workflows/release.yml) / [platform-release.yml](.github/workflows/platform-release.yml) | 发布前校验依赖准备快照、tag 版本，并要求同一 main 提交有成功的全量 CI（main push 或 main 上的手动运行）；平台发版条件遵循 [AGENTS.md](AGENTS.md) |

`release-build-check.yml` 在合并请求和 main 上跑的内容不同（MUL-516）：

- 合并请求只跑快检查：架构守卫、CLI 能力、前端类型/测试、CLI 和容器构建、平台专项检查。`build` job 里的「Backend test suite」显示为跳过（skipped），job 仍正常报告结果。同一个合并请求推送新提交时，未跑完的旧运行会被自动取消。
- 后端全套 `bun run test` 在合入 main 后的 push 运行里跑。main 上的运行互不取消，每个 main 提交都有自己的完整结果。
- 发版门禁不变：打 tag 前，目标 main SHA 必须有一次全绿的 main push 运行或 main 上的手动运行（都含后端全套）。合并请求上的绿灯不能代替。检查停用后重新打开时，main 不会自动补跑，用 `gh workflow run release-build-check.yml --ref main` 手动跑一次。
- main 上后端全套变红时，带头大哥当天定位到对应的合并，修复或回滚。QA 维护测试集的职责不变：测试本身的问题由 QA 修复或暂时隔离，代码问题开单处理。
- 合并请求作者仍应在本地跑与改动相关的测试文件（`bun run test <path>`）。

真实 provider、飞书和浏览器 harness 的成功不能由普通单测或构建绿灯推断。报告验证时写明实际命令、环境、结果和未覆盖项。

## 测试环境隔离与排查

`bun test` 通过 [bunfig.toml](bunfig.toml) 的 preload 在测试模块加载前执行 [hermetic-env.ts](tests/setup/hermetic-env.ts)，清除继承的产品配置和凭据。精确范围以纯模块 [hermetic-env-policy.ts](tests/setup/hermetic-env-policy.ts) 为准：清除 `MULTIREMI_*`、`REMI_*`、`ANTHROPIC_*`、`FEISHU_*` 及列明的独立变量，保留 `MULTIREMI_TEST_*`、`FEISHU_TEST_*` 测试输入。测试需要的环境变量由测试自己设置并还原；显式指定的测试数据库连接失败不能当作未配置而跳过。

清理后，preload 每次创建独立临时根，覆盖 `MULTIREMI_TEST_RUN_ROOT`（不信任继承值），并把 `HERMETIC_ENV_RUN_ROOT_PATHS` 中的七个现有路径开关指向该根：state、workspaces、session archives、plugin cache、uploads、config 文件和 REMI_HOME。退出时尝试删除自己的根；测试保存还原 env 时应恢复这些动态值。子进程 helper 再次 scrub 后必须转发这些路径开关。新增写入默认路径应优先挂在现有开关下，并登记到该表；只有 setter/构造参数的模块必须由测试显式注入临时路径，不新增生产开关。

两类跨进程工作区锁必须由同一宿主 HOME 下的 daemon 共用，不能跟随各自的 MULTIREMI_STATE_DIR：生产 runtime lease 仍为 `join(homedir(), ".multiremi", "runtime-workspace-leases")`，supervisor 及活跃 owner 枚举仍为 `join(userInfo().homedir, ".multiremi", "workspace-supervisors")`。仅在 NODE_ENV=test 时，[共享锁路径](packages/shared/src/home-paths.ts)指向 `MULTIREMI_TEST_RUN_ROOT/shared-locks/` 的对应子目录，缺少运行根抛 real_home_default_in_test。测试子进程必须转发 MULTIREMI_TEST_RUN_ROOT；outbox 继续使用各自的 state 开关。[真实双进程回归](tests/unit/daemon/workspace-shared-locks.test.ts)以临时启动 HOME 验证不同 STATE_DIR 的竞争、活跃 owner 枚举与释放后重获。

直接 `bun test <path>` 保留 `NODE_ENV`、`PATH`、`HOME`、`SHELL`、`USER`、`GIT_*` 和 `SQLITE_LIB_PATH` 等宿主能力，只提供上述进程内隔离。preload 不修改 HOME，不 mock OS；Bun 1.3.14 的 `homedir()` 和 `userInfo().homedir` 在启动时固定。workspaces、archive、state 的 HOME 兜底在 `NODE_ENV=test` 时抛 `real_home_default_in_test`，要求开关或显式参数。

`bun run test <path> [bun test 参数]` 通过 [run-tests.ts](scripts/run-tests.ts) 在启动测试进程前换成假 HOME（Windows 同设 USERPROFILE），清除 XDG_*，把 Git 全局配置指向不存在的临时 .gitconfig，并将 Bun 转译/安装缓存放在仓库 `node_modules/.cache/bun/` 下。跑完递归检查假 HOME；任何文件、空目录或符号链接都逐行报告并返回 1，无白名单。HOME 为空时保留测试退出码，再清理假 HOME。CI 的 archive 专项、架构和后端全套均使用此包装；这层覆盖无路径开关及未来新增的 HOME 写入。遇到 Git 配置差异，定位实际影响并修测试夹具，不修改用户全局配置。

Daemon 测试和独立 harness 必须注入 [disabledSshMeshRuntime()](tests/helpers/ssh-mesh-isolation.ts)，或使用带临时 `home` 的 SSH Mesh paths；仅更换 mesh root 不会隔离 `.ssh/config` 和 `.ssh/authorized_keys`。`NODE_ENV=test` 时，[SSH Mesh 路径解析](packages/daemon/src/ssh-mesh.ts)拒绝模块加载时的 `HOME` / `userInfo().homedir` / `homedir()`（含符号链接别名），抛出 `ssh_mesh_real_home_in_test`；进程内改写 HOME 不能代替显式注入。启动 daemon 的测试子进程也必须使用临时 HOME。[回归测试](tests/integration/daemon-real-home-isolation.test.ts)用假 HOME 运行 steer、approval-e2e、drain-outbox，比较整个 HOME 的目录列表、文件 SHA-256 和符号链接，保留原有 Mesh/OpenSSH sentinel，并以故意写入验证快照能检出变化。

[环境护栏测试](tests/arch/hermetic-test-env.test.ts)检查 preload 挂载、实际执行标记和变量泄漏；测试只导入 policy，不能通过直接导入 preload 自行清理后证明隔离成功。[HOME 调用 ratchet](tests/arch/homedir-call-sites.test.ts)限制生产源码每文件的 HOME 读取数量，新增调用需要隔离审查。通过 `bun run` 执行的独立手动 harness 不加载该测试 preload，也不走 test 包装，仍使用真实环境。

[包装信号回归](tests/unit/scripts/run-tests-signals.test.ts)实际转发 SIGINT/SIGTERM 并保留子进程退出码；[包装环境回归](tests/unit/scripts/run-tests.test.ts)核对 CI 的测试数据库 URL 与 lock sentinel 输入；[多文件 preload 回归](tests/unit/scripts/hermetic-preload-process.test.ts)验证多个文件及其 awaited afterAll 子进程结束前共享运行根仍在，整个套件结束才清理。

[Remi core 测试](tests/unit/remi/core.test.ts)通过构造参数把旧 sessions.json 迁移和 metrics 写入临时 home；shared/config 的生产常量仍按原 HOME 解析，不读取 REMI_HOME 环境变量。[Claude wrapper 测试](tests/unit/acp/claude-runtime-wrapper.test.ts)为子进程设置 npm_config_logs_dir 与 npm_config_cache。[Lark CLI 集成测试](tests/integration/lark-cli-message-provider.test.ts)保留真实健康探测；无配置文件时将 CLI 配置、数据、日志目录放入测试运行根，避免未登录探测生成 HOME 缓存。直接 bun test 且存在 CLI 配置时保留原登录环境，继续运行真实 CLI 用例。
