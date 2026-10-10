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

普通合成根 Issue 使用 `createResponsibleTestIssue(store, input)`，显式建立命名测试人类；
合成自动化配置使用 `createResponsibleTestAutopilot`，按实际 workspace 建立同样明确的测试人类，
避免调度、Webhook 或事件派活借 Runtime owner 创建根责任。已给出的责任字段（包括显式 null）保留原事实。
子单仍继承根责任，显式空责任和生产创建负向用例直接调用原 Store，不能覆盖 Store 方法。
闭环用例明确配置 Agent/团队执行归属，并用 `acceptTestIssueDelivery` 提交、验收实际交付。
历史升级 fixture 使用其原表形状和历史 writer，不能借合成工厂提前写入新责任字段或验收收据。

[公开参考价格 PG/CLI 回归](tests/unit/scripts/usage-reference-prices.test.ts)沿用 CI 的 `MULTIREMI_TEST_POSTGRES_URL`；可用 `MULTIREMI_TEST_REFERENCE_DATABASE_URL` 单独覆盖。所选测试连接必须具有创建测试库的权限，两条用例各创建随机命名的独立数据库，所有并发 writer 与 CLI 只连接该库，完成后仅删除本次成功创建的数据库。不要指向生产；连接或清理失败会使测试失败，不会跳过或强制删除公共表。

[路由矩阵夹具](tests/helpers/routing-matrix-database.ts)仅用于同步 placement cells：每个 dialect 初始化一次独立数据库与 Store，各 cell 开始前提交恢复原生临时表保存的基线，保留真实 transaction/afterCommit 行为。它拒绝 schema 变化、request cache、订阅、后台工作、sequence/trigger 和不支持的外键种子依赖。迁移、冷启动、竞态或生命周期测试必须继续使用新夹具；不能把矩阵复用推广为全套共享数据库。显式 PG URL 仅接受本机测试服务，创建随机专属数据库并清理；reset 失败不能算成功。SQLite/PG 场景保留同一组风险维度与断言。

[SQLite snapshot 工厂](tests/helpers/sqlite-store-snapshot.ts)只供显式接入的普通业务测试：目前18个文件使用 `createSnapshotStore` / `createLocalSnapshotStore`，每例仍有独立SQLite连接和新Store，正常迁移入口走已有 unified schema 的检查路径；`createStore` / `createLocalStore` 默认仍fresh。snapshot共享迁移种子的时间戳和元数据，环境、时钟、ID生成、空schema、迁移或startup副作用敏感用例不用它。兼容检查失败或迁移报告缺失会回退fresh，不能跳过生产迁移入口。`snapshotStatsForFile` 在消费文件的beforeAll采起点、afterAll输出 `scope: "file-window"` 增量，仅包含该窗口的冷bootstrap、clone、fresh fallback、Store初始化和初始化时间，不是全仓累计值。

[Pending-turn 夹具](tests/unit/multiremi/pending-turn-test-backends.ts)默认仍为每例fresh；七个已审阅的同步普通业务套件显式选择 `{ isolation: 'committed-baseline' }`，每suite独立数据库和Store、每例开始前提交恢复基线。业务 `fixture.transaction` 必须通过Store的数据库wrapper，保留SQLite afterCommit、缓存失效和锁顺序守卫；raw数据库事务仅用于基线恢复或原用例已有的raw SQL边界。共用[恢复实现](tests/helpers/reusable-store-database.ts)重置analytics和已settled只读缓存，未结束的锁/lease、未提交version、replay、afterCommit、订阅或后台工作会失败，schema、request cache及env/clock/UUID注入同样拒绝。PG仅连接显式本机测试服务、删除本次成功创建的随机owned DB，初始化失败清理已开资源；消费suite的afterAll必须await `dispose()`：先排空已排队microtask并停止调度，等待活跃dispatch及原sender实际settled后清理连接/owned DB（dispatch超时不代表原send已结束），随后仍报告后台工作违约。原sender调用在测试夹具中追踪，registry/send运行期替换拒绝；同步 `close()` 仅供已idle的调用；永不settled且不可取消的外部工作不在支持范围，不能强制销毁其连接。SQLite wrapper的afterCommit闭包依靠同步transaction/savepoint的finally弹栈与排空保证，不通过raw DB字段反射声称已检测全部状态。迁移、reopen、多连接、多进程和生产startup恢复继续fresh，外部Context监听器由用例自己的finally清理。

[PR2大夹具](tests/fixtures/multiremi/first-screen-hotspots-pr2-fixture.ts)的 `attachmentOnly: true` 仅用于附件上传、权限和ETag功能场景，保留所需身份、Issue和Chat；未传该选项的golden、query-count和benchmark仍使用原默认规模。不得用小夹具替代规模回归或更新golden来掩盖变化。

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

全路由 golden 捕获是功能契约检查，单次测试限时 60 秒；其限时不作为 API 延迟或查询性能预算。页面首屏、SQL 查询次数和读取字节边界仍由对应性能 guard 独立验证。

## CI 覆盖

| 工作流 | 实际检查范围 |
|---|---|
| [dev-context.yml](.github/workflows/dev-context.yml) | PR / main push；Linux、Windows 上的 Node 检查器测试及默认文档阅读链校验 |
| [release-build-check.yml](.github/workflows/release-build-check.yml) | 按路径触发；独立的架构/CLI 守卫、CI 编排小回归、前端类型、前端测试、CLI/API/Web 构建、平台专项和浏览器专项；main push 与手动运行另有四个后端分片及完整覆盖校验 |
| [release.yml](.github/workflows/release.yml) / [platform-release.yml](.github/workflows/platform-release.yml) | 校验准备快照、tag 版本及同一 main SHA 的成功完整 CI 或严格验证的失败文件补跑；复用符合来源与内容校验的正式 candidate，缺少可用 candidate 时保留原构建路径 |

`build` 保留为分支保护的必需检查，是所有适用 job 的汇总，不再承载串行测试与构建。它逐项要求预期的 success / skipped；失败、取消、缺少分片报告或非预期 skipped 均不能给出绿灯。PR 跳过后端分片；main push 与默认手动运行要求完整后端覆盖。PR 新提交取消该 PR 的旧运行，main 运行互不取消。两个浏览器专项保留各自的路径检测，路径不相关时跳过专项步骤，job 仍需正常成功。

[ci-backend.ts](scripts/ci-backend.ts) 从 bunfig 的 test root 自动发现 Bun 支持的 `.test` / `_test` / `.spec` / `_spec` 文件和八种 JS/TS 扩展，排除隐藏目录与 node_modules，隐藏文件名仍按后缀发现；不维护测试文件清单。它按 [历史权重](scripts/ci-backend-weights.json) 做 LPT 分配，新文件使用至少 60 秒或历史 p90 的保守权重。初始权重来自文件中标识的真实 Actions run/job/SHA，按日志文件标题边界计时，包含部分 runner 开销，不能视为当前版本的实测耗时。

每片使用独立 runner、PostgreSQL service 和一次包装测试进程，保留 hermetic preload、假 HOME 检查及 lock-order sentinel。启动前实际验证显式 `MULTIREMI_TEST_POSTGRES_URL` 的连接，失败报错。计划与报告绑定 SHA、bunfig 指纹、scope/preload 和完整文件归属；覆盖校验要求每个文件恰好出现一次且所有分片成功。架构快守卫故意在 `guards` 先跑，并在全量分片再次覆盖，以保留快速反馈与可审计发现范围。`guards` 另以 `CI=true`、`GITHUB_ACTIONS=true` 显式执行 CI 编排自身的五个小回归文件（ci-backend、run-tests、run-tests-signals、retry-failed-backend-tests、release-candidate），让真实 GitHub 分组日志、包装退出/清理、覆盖及补跑来源问题在 PR 阶段暴露；该步骤不执行数据库或业务套件。

每次完整运行上传 `backend-plan`、各 `backend-shard-*` 和 `backend-coverage`；失败片尽可能上传已形成的报告。coverage JSON 包含文件耗时、分片归属、总文件时间、各片时间和最慢 30 个文件；文件时间按 stderr 标题至下一标题或进程退出计量。夹具的 `REMI_TEST_DB_FIXTURE_STATS` 行提供创建数据库、初始化 Store、迁移、重置、连接与 setup/reset 时间，只覆盖输出该行的 helper，不能当作全仓数据库成本。

以下入口只做文件规划或报告校验，不启动测试；`run` 才执行后端分片：

```bash
bun run scripts/ci-backend.ts plan --sha <40位提交SHA> --shards 4 --out ci-backend/plan.json
bun run scripts/ci-backend.ts verify --plan ci-backend/plan.json --reports ci-backend --out ci-backend/coverage.json
bun run scripts/ci-backend.ts weights --coverage ci-backend/coverage.json --previous scripts/ci-backend-weights.json --run-id <完整运行ID> --out ci-backend/weights.json
```

`verify` 使用 CI 的 `GITHUB_SHA` 核对报告身份。`weights` 只导入通过完整覆盖校验的报告；检查新权重来源后更新仓库权重文件，CI 规划不依赖联网获取历史记录。并行关键路径与总 runner 成本应分别比较；独立安装与启动的成本也需计入，未跑新 CI 时不能宣称提速或节省已验证。

完整后端套件已经跑完且仅少量用例失败时，可用 `gh workflow run release-build-check.yml --ref main -f retry_backend_run_id=<完整运行ID>` 补跑失败文件。[旧基准验证器](scripts/retry-failed-backend-tests.ts)仍核验原运行来自 main、完整测试汇总和 HOME 清理、失败文件数量与其他 job 全绿；原 SHA 必须是目标 SHA 的祖先，差异只能是它允许的重跑入口、脚本/测试和本说明，不能改变业务源码、依赖或原有测试。旧单进程基准继续使用最终日志汇总；分片基准下载同仓库该运行的计划与全部分片 artifact，核对完整实际文件归属、Bun 最终汇总、精确失败文件、子进程退出与 HOME 清理，且其他 job 必须成功（覆盖校验仅因后端失败跳过）。HOME 写入、observer 错误、缺报告、取消、中断、部分套件及补跑自身均不能作基准。合法补跑记录为 `verified-retry`，保留原有发布资格，但不声称本轮重跑全量，不生成正式 candidate。夹具创建的 15 秒预算不是性能验收阈值。

依赖准备变更提交到 main 后，若 `release:check` 对 push 的 base SHA 检查成功且版本增加，该次 main push 完整检查直接生成正式 candidate；正常流程无需再为同一 SHA 手动执行一轮完整检查。普通非版本变更 main、PR、verified retry 和未请求候选的手动运行不生成候选。需要补生成或重建时仍可显式执行 `gh workflow run release-build-check.yml --ref main -f release_candidate=true`，该手动请求会重新执行完整检查；非 main 或同时指定 retry 的候选请求失败。候选不发版、不打 tag、不推送镜像。构建使用 package.json 的正式版本，并校验准备快照；只有实际完整后端覆盖与其余检查成功后，`candidate-package` 才上传 `release-candidate-<SHA>`（保留 30 天）。产物分为保留 30 天的 `candidate-cli`（四平台 CLI 归档与安装脚本）、`candidate-api` / `candidate-web`（linux/amd64 OCI 归档）和最终 `release-candidate-<SHA>` manifest；聚合时完整校验三部分，最终 artifact 不重复上传 OCI。

发布侧 [release-candidate.ts](scripts/release-candidate.ts)核对同仓库、main、精确 SHA、workflow/event/run/job 来源，以及版本、Bun、lock/runtime 快照、构建参数、目标平台、文件 SHA-256、OCI digest 和配置标签；CLI 侧使用 `resolve --kind cli`，只下载 manifest 与 CLI 部分；平台侧使用 `resolve --kind images`，只下载 manifest 与 API/Web 部分。固定部分名绑定同一个可信 run，不跟随 manifest 内任意 URL；复用已验证归档，保持镜像 digest。manifest 或所需部分不存在/过期时，仅在完整 CI / 合法 verified retry 证据成立时回退原发布构建；存在但损坏、来源不符、认证或网络失败均报错。平台手动恢复仍使用既有正式 tag；已有版本/source 镜像对必须同 digest，不能覆盖冲突状态。现行依赖准备、完整 CI、SemVer 和用户明确授权发版要求不变。

main 后端变红时应定位相应合并并修复或回滚；测试问题由 QA 维护，代码问题按实际归属处理。QA 长期维护按风险行为与断言去重：只有另一个保留用例覆盖同一风险、输入差异和关键断言时才移除重复测试；保留独立生命周期、竞态、错误路径与公共契约覆盖，不以行数或测试数下降替代覆盖证据。PR 作者仍应运行改动相关文件。真实 provider、飞书和浏览器 harness 的成功不能从普通单测或构建推断；报告写明命令、环境、结果与未执行项。

## 测试环境隔离与排查

`bun test` 通过 [bunfig.toml](bunfig.toml) 的 preload 在测试模块加载前执行 [hermetic-env.ts](tests/setup/hermetic-env.ts)，清除继承的产品配置和凭据。精确范围以纯模块 [hermetic-env-policy.ts](tests/setup/hermetic-env-policy.ts) 为准：清除 `MULTIREMI_*`、`REMI_*`、`ANTHROPIC_*`、`FEISHU_*` 及列明的独立变量，保留 `MULTIREMI_TEST_*`、`FEISHU_TEST_*` 测试输入。测试需要的环境变量由测试自己设置并还原；显式指定的测试数据库连接失败不能当作未配置而跳过。

清理后，preload 每次创建独立临时根，覆盖 `MULTIREMI_TEST_RUN_ROOT`（不信任继承值），并把 `HERMETIC_ENV_RUN_ROOT_PATHS` 中的八个现有路径开关指向该根：state、workspaces、session archives、plugin cache、uploads、config 文件、REMI_HOME 和 REMI_PLUGINS_DIR。CLI 插件发现显式读取临时 plugins 目录，避免帮助与命令清单加载宿主已安装的扩展；插件测试仍可设置自己的 fixture 目录并还原。退出时尝试删除自己的根；测试保存还原 env 时应恢复这些动态值。子进程 helper 再次 scrub 后必须转发这些路径开关。新增写入默认路径应优先挂在现有开关下，并登记到该表；只有 setter/构造参数的模块必须由测试显式注入临时路径，不新增生产开关。

两类跨进程工作区锁必须由同一宿主 HOME 下的 daemon 共用，不能跟随各自的 MULTIREMI_STATE_DIR：生产 runtime lease 仍为 `join(homedir(), ".multiremi", "runtime-workspace-leases")`，supervisor 及活跃 owner 枚举仍为 `join(userInfo().homedir, ".multiremi", "workspace-supervisors")`。仅在 NODE_ENV=test 时，[共享锁路径](packages/shared/src/home-paths.ts)指向 `MULTIREMI_TEST_RUN_ROOT/shared-locks/` 的对应子目录，缺少运行根抛 real_home_default_in_test。测试子进程必须转发 MULTIREMI_TEST_RUN_ROOT；outbox 继续使用各自的 state 开关。[真实双进程回归](tests/unit/daemon/workspace-shared-locks.test.ts)以临时启动 HOME 验证不同 STATE_DIR 的竞争、活跃 owner 枚举与释放后重获。

直接 `bun test <path>` 保留 `NODE_ENV`、`PATH`、`HOME`、`SHELL`、`USER`、`GIT_*` 和 `SQLITE_LIB_PATH` 等宿主能力，只提供上述进程内隔离。preload 不修改 HOME，不 mock OS；Bun 1.3.14 的 `homedir()` 和 `userInfo().homedir` 在启动时固定。workspaces、archive、state 的 HOME 兜底在 `NODE_ENV=test` 时抛 `real_home_default_in_test`，要求开关或显式参数。

`bun run test <path> [bun test 参数]` 通过 [run-tests.ts](scripts/run-tests.ts) 在启动测试进程前换成假 HOME（Windows 同设 USERPROFILE），清除 XDG_*，把 Git 全局配置指向不存在的临时 .gitconfig，并将 Bun 转译/安装缓存放在仓库 `node_modules/.cache/bun/` 下。跑完递归检查假 HOME；任何文件、空目录或符号链接都逐行报告并返回 1，无白名单。HOME 为空时保留测试退出码，再清理假 HOME。CI 的 archive 专项、架构和后端全套均使用此包装；这层覆盖无路径开关及未来新增的 HOME 写入。遇到 Git 配置差异，定位实际影响并修测试夹具，不修改用户全局配置。

Daemon 测试和独立 harness 必须注入 [disabledSshMeshRuntime()](tests/helpers/ssh-mesh-isolation.ts)，或使用带临时 `home` 的 SSH Mesh paths；仅更换 mesh root 不会隔离 `.ssh/config` 和 `.ssh/authorized_keys`。`NODE_ENV=test` 时，[SSH Mesh 路径解析](packages/daemon/src/ssh-mesh.ts)拒绝模块加载时的 `HOME` / `userInfo().homedir` / `homedir()`（含符号链接别名），抛出 `ssh_mesh_real_home_in_test`；进程内改写 HOME 不能代替显式注入。启动 daemon 的测试子进程也必须使用临时 HOME。[回归测试](tests/integration/daemon-real-home-isolation.test.ts)用假 HOME 运行 steer、approval-e2e、drain-outbox，比较整个 HOME 的目录列表、文件 SHA-256 和符号链接，保留原有 Mesh/OpenSSH sentinel，并以故意写入验证快照能检出变化。三个子进程真实并行运行，共享一个 90 秒总预算；steer、approval-e2e 和 drain-outbox 保留各自原有用例期限，并在三者都结束后检查整个 HOME。

[环境护栏测试](tests/arch/hermetic-test-env.test.ts)检查 preload 挂载、实际执行标记和变量泄漏；测试只导入 policy，不能通过直接导入 preload 自行清理后证明隔离成功。[HOME 调用 ratchet](tests/arch/homedir-call-sites.test.ts)限制生产源码每文件的 HOME 读取数量，新增调用需要隔离审查。通过 `bun run` 执行的独立手动 harness 不加载该测试 preload，也不走 test 包装，仍使用真实环境。

[包装信号回归](tests/unit/scripts/run-tests-signals.test.ts)实际转发 SIGINT/SIGTERM；中断后子进程退出 0 时包装仍返回失败，原非零退出码继续保留，并检查 HOME 清理；[包装环境回归](tests/unit/scripts/run-tests.test.ts)核对 CI 的测试数据库 URL 与 lock sentinel 输入；[多文件 preload 回归](tests/unit/scripts/hermetic-preload-process.test.ts)验证多个文件及其 awaited afterAll 子进程结束前共享运行根仍在，整个套件结束才清理。

[Remi core 测试](tests/unit/remi/core.test.ts)通过构造参数把旧 sessions.json 迁移和 metrics 写入临时 home；shared/config 的生产常量仍按原 HOME 解析，不读取 REMI_HOME 环境变量。[Claude wrapper 测试](tests/unit/acp/claude-runtime-wrapper.test.ts)为子进程设置 npm_config_logs_dir 与 npm_config_cache。[Lark CLI 集成测试](tests/integration/lark-cli-message-provider.test.ts)保留真实健康探测；无配置文件时将 CLI 配置、数据、日志目录放入测试运行根，避免未登录探测生成 HOME 缓存。直接 bun test 且存在 CLI 配置时保留原登录环境，继续运行真实 CLI 用例。
