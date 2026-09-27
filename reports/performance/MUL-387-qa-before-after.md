# MUL-387 QA 前后对比与正式验收

- 被测分支/提交：`agent/MUL-387` @ `16119de8c22239d0a8182d44af50cd63db143b35`（= `origin/agent/MUL-387` = PR #257 head）
- 改动前基线：`main` @ `a1e6162312b34d272e22b633d185f014f535f23e`
- 结论：**通过**（逐条判定见 §4）
- 测量方式：进程内/本机回环；**未接触 209**，未改 `./wiki`，未执行 `remi wiki push`，无 token 落盘

## 1. 方法

所有脚本只调用**公开 HTTP 面**或**真实进程 CLI**，不 import 本单新增符号，因此同一份文件能在改动前后原样复跑。

脚本位于 QA 工作区 `issues/MUL-387/qa-bench-after/`（为遵守「只提交报告文件」的约束，脚本本体不随本次提交进入仓库）：

| 脚本（相对 QA 工作区） | 作用 | 运行方式 |
|---|---|---|
| `tests/manual/qa-bench-repository-wiki-list.ts` | 列表接口 p50/p95/读取次数/响应体 | 146 篇、fake OpenViking `read` 固定 700ms、串行 100 次、warmup 3 次、SQLite in-memory、`app.request()` |
| `tests/manual/qa-bench-repository-wiki-contract.ts` | ADR §3 / 裁决 §6 契约逐条断言（50 条） | 同上 fixture，含 UA/env/strict/400 家族；违约则退出码非 0 |
| `tests/manual/qa-bench-repository-wiki-cli-e2e.ts` | 真实 CLI 子进程 × 真实 API 进程（21 条） | `bun apps/remi/main.ts` ↔ `Bun.serve` + in-memory SQLite + OpenViking stub；工作副本由 daemon 自己的 `prepareIssueWikiWorkspace` 物化 |
| `tests/manual/qa-bench-repository-wiki-frontend-client.ts` | 前端 `ApiClient` + zod schema 打真实服务端（10 条） | 出货代码，非重写实现 |

| 脚本 | sha256 |
|---|---|
| `qa-bench-repository-wiki-list.ts` | `3c428cbd2f9f3baa771d01b71edcae42ea56a68211de91dc4e6f835e7ac44e9a` |
| `qa-bench-repository-wiki-contract.ts` | `031e633d56810b921eaaa38d182d78f449dde0d7fde74528f5c1ebbc44a88ec4` |
| `qa-bench-repository-wiki-cli-e2e.ts` | `b6d2ba5410692076dc3e8bf1a98d8b6376a1efc02cda4990cddc93bc58499516` |
| `qa-bench-repository-wiki-frontend-client.ts` | `ec2a0aab63c414295e277b64939cba0a39286ccbe42687f5f6c17fb0b8ca4e0c` |

结果 JSON：`MUL-387-qa-list-before.json`、`MUL-387-qa-list-after.json`、`MUL-387-qa-contract.json`、`MUL-387-qa-cli-e2e.json`、`MUL-387-qa-frontend-client.json`。

改动的代码身份用 **内容哈希**（`sourceDigest`），不依赖 git ref：

- before（`service.ts` / `workspaces.ts` / `api/server.ts`）：`07b23f8ca5c4fa0b080454b390fccfea30635c569e953460dc906e763ba5eb83`
- after（同上三文件）：`875c068ae232cd21e590882529ef250865ffb6a155f5b01c5c2123ba55415dc9`

> 说明：临时 worktree 的 gitdir 槽位会被并发的 `git worktree add` 回收（本轮实测发生过），所以 `git rev-parse` 在临时检出里不可信；哈希对内容负责。

## 2. 列表接口前后对比（146 篇 / 700ms / 100 次）

| | before（`a1e61623`） | after（`16119de8`） | 变化 |
|---|---|---|---|
| p50 | 705.14 ms | **0.98 ms** | 719× |
| p95 | **706.26 ms** | **1.47 ms** | 480× |
| p99 | 708.62 ms | 2.62 ms | |
| max | 710.84 ms | 2.94 ms | |
| 每次请求 `content/read` 次数 | 146（100 次样本恒定） | **0** | 全部消除 |
| 单请求在飞 read 峰值 | 146（无上限） | 0 | |
| 响应字节 | 339,468 B | 119,008 B | −65% |

- **p95 < 200ms：通过**（1.47ms，余量 136×）。
- 复现性：before 三次独立运行 p95 = 706.71 / 707.23 / 706.26ms；after 两次 = 1.51 / 1.47ms。
- 对照口径：before 把 fake 延迟设为 0 后 p95 = 5.52ms（仍 146 次 read），说明 700ms 的读延迟是耗时主体，不是测量噪声。
- 注意 700ms 是 209 上的**单读下限**；生产 p95 13.87s 更差是因为 138–146 并发把单读抬到约 830ms。所以 before 这一列已经是老路径的最好情况，它仍超目标 3.5 倍。

`include_body=true&ids=<20 个>`：在飞 read 峰值 **4**（= `REPOSITORY_WIKI_BODY_READ_CONCURRENCY`），总耗时 3507ms ≈ 5 批 × 700ms，读 20 篇，20 篇全带正文。**通过**。

## 3. 真实进程 CLI 端到端（本单最大风险项）

**老 CLI（`a1e61623`）对候选服务端**（`Bun/1.3.14` → UA shim）：

| 断言 | 结果 |
|---|---|
| `wiki status` 退出码 0 | 通过 |
| `clean=true`（没有把远端误判成空文档） | 通过 |
| 走整包 shim，读满 6 篇 | 通过（6 次 read） |
| shim 响应每篇都带 `body` 键 | 通过 |
| 拉出的文件里空文件数 | 0 |

**新 CLI 对候选服务端**：无改动时 `status` 退出码 0、`clean=true`、**0 次正文读**（复用 `.multiremi/wiki-base`）；服务端改一篇后，**只取那 1 篇**，且命中的正是该篇 `contentUri`；正文不可读时 `status` 非 0 退出、报错文案指明正文不可读、**本地文件零改动**（不会把空正文合并进工作副本）。

**新 CLI 对老服务端**：老服务端返回含 `body` 的超集响应被直接采用，行为正常。

**一项对照澄清**：`wiki pull` 在远端正文变化后**不会**改写本地仓库页（两种 CLI 都是如此，见 `MUL-387-qa-cli-e2e.json` 的 `新旧 CLI 行为对照` 条目）。仓库页由 daemon 在任务开工时物化，`pull` 负责 Project Wiki。这是**既有行为**，不是本单引入的回归——新旧两代结果一致。

## 4. 逐条判定（ADR §3 / 裁决 §6）

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 无参数列表 0 次 `content/read` | 通过 | contract §3 默认列表；after 100 次样本 max=0 |
| 2 | 无参数列表不返回 `body` 键 | 通过 | `bodyKeyPresentOnSomeDoc=false`（缺失，非 `""`） |
| 3 | 无参数列表 p95 < 200ms | 通过 | 1.47ms |
| 4 | 仍带 `version` / `content_sha256` | 通过 | contract 两条断言 |
| 5 | `include_body&ids=20` 在飞 ≤ 4 | 通过 | 峰值 4 |
| 6 | `include_body&ids=20` 总耗时 ≈ 5×0.7s | 通过 | 3507ms（区间断言 3.5–7.0s） |
| 7 | 21 个 id → 400 | 通过 | contract §3 上限 |
| 8 | `include_body` 缺 `ids` → 400 | 通过 | 同上 |
| 9 | `q` 与 `include_body`/`ids` 互斥 → 400 | 通过 | 两条 |
| 10 | 重复 `ids=` 去重后 ≤20 仍 200 | 通过 | 同 id ×21 → 200 |
| 11 | `ids=` 未知 id 静默省略 | 通过 | 200 且 0 篇 |
| 12 | 任一篇读不到 → 整个请求 503，无空正文 | 通过 | 单篇 503、混合批量 503、部分结果 0 篇 |
| 13 | UA `Bun/1.3.14` → 整包带正文 | 通过 | 146 次 read，全带 body |
| 14 | `remi-cli/`、无 UA、浏览器 UA → 快路径 | 通过 | 三者 0 次 read、不带 body |
| 15 | env `always` → 整包；`never` → 快路径 | 通过 | 两种模式各覆盖（含浏览器 UA） |
| 16 | `always` 下 `include_body` 仍 strict | 通过 | 不可读 → 503、无空正文 |
| 17 | CLI：未变篇 0 次取正文 | 通过 | 真实进程，0 次 |
| 18 | CLI：变一篇只取那 1 篇 | 通过 | 1 次且命中该 `contentUri` |
| 19 | CLI：请求正文却缺失 → 报错且本地零写入 | 通过 | 退出码非 0、文件逐字节未变 |
| 20 | CLI：每个请求带 `remi-cli/` | 通过 | 单测 + E2E 请求头断言 |
| 21 | 老 CLI 兼容窗口不丢内容 | 通过 | 老 CLI × 新服务端：`clean=true`、0 空文件 |
| 22 | 前端列表可解析、正文按选中项加载 | 通过 | 出货 `ApiClient` + zod：列表 0 次读、body 为 `undefined`、单篇 1 次读 |
| 23 | 前端搜索契约不变（`q`） | 通过 | 仍返回命中篇且带正文 |
| 24 | 前端不回归 | 通过 | `test:frontend` core 1023 / views 2322（跳过 18）/ web 55；`typecheck:frontend` 四包全 0 |

**关于「`include_body`/`ids` 在 `always` 下也走 strict」这处对裁决的收紧：判定为与裁决一致。** 裁决要求 `include_body` 必须 strict，并未把 `always` 排除在外；实现把它收窄到「仅默认列表形态吃 shim」，避免回滚杆把不可读篇以 `body:""` 返回、重新打开丢内容路径。未引入新风险，见第 16 行断言。

## 5. 独立复跑（不依赖实现者）

| 检查 | 结果 |
|---|---|
| `bunx tsc --noEmit` | 退出码 0 |
| `bun test tests/unit/multiremi tests/unit/remi` | **3135 pass / 84 skip / 0 fail**（3219 tests，268 files，403.8s） |
| `bun test tests/arch/` | 91 pass / 0 fail |
| `bun run cli:capabilities:check` | 668 mapped / 91 exempt / **0 missing**（759 routes） |
| `bun run scripts/snapshot-api-routes.ts --check` | matches golden |
| `bun run test:frontend` | core 1023 / views 2322（跳过 18）/ web 55，全 0 fail |
| `bun run typecheck:frontend` | ui / core / views / web 全 0 |

## 6. 未覆盖与限制

- **前端页面渲染**：本地 Next.js dev server 能起、路由 200，但该 ad-hoc 环境里客户端始终没有发起 `/api` 请求（页面 HTML 输出 290 KB、`body` 文本为空），根因未定位，可能是本机 dev 配置而非产品缺陷。因此前端只做了**数据层**（出货 `ApiClient` + zod + 真实服务端）与**测试层**验证，**没有**给出页面渲染结论。10.36.0.212 桌面验收未执行：本 Runtime 没有 `multiremi-web-qa` 的浏览器包装脚本，按 QA 规则不得用 headless 结果冒充 212 验收。
- **209 发版后复核**：未做（本单不涉及发版，且生产只读约束下不做写操作）。
- 本报告的 before 数据来自改动前的独立 clone（`qa-bench-before`），不是共享检出切分支。
- 所有测量都是进程内 / 本机回环；**不等于**生产端到端延迟，不建模网络传输与 PostgreSQL。

## 7. 结论

**通过。** 全部 24 条验收判定通过，无「不通过」项。唯一需要记录的是前端页面渲染未在本环境取得有效结果（数据层与测试层已通过），建议由具备 212 桌面能力的轮次补一次真实浏览器复测；这不构成本次判定失败，但属于显式未覆盖项。
