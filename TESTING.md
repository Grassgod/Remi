# TESTING.md

测试组织约定。核心原则一句话:**统一的是"规则",不是"目录"。**

本仓库是多语言 monorepo,有两套**各自自洽**的测试体系。不要把其中一套强行搬进另一套——那会违背工具默认行为,得不偿失。

| 范围 | 工具 | 测试放哪 | 怎么发现 |
|---|---|---|---|
| 后端 (Bun/TS) | `bun:test` | **集中** 在 `tests/` 下 | `bunfig.toml` 里 `[test] root = "tests"`,只扫 `tests/` |
| 前端 (Next/React) | Vitest | **贴着源码** `foo.test.ts` 挨着 `foo.ts` | Vitest 扫源码旁的 `*.test.ts(x)` |
| 前端 E2E | Playwright | **独立目录** `frontend/e2e/` | `frontend/playwright.config.ts` 指向 `./e2e` |

> 为什么前端贴源码、后端集中?见文末「为什么是两套」。

---

## 后端测试(集中在 `tests/`)

`bun test` 通过 `bunfig.toml` 的 `root = "tests"` **只发现 `tests/` 下的 `*.test.ts`**。目录按用途分四层:

```
tests/
├── unit/          纯逻辑 + 接口级单测,无外部依赖,bun test 自动跑
│   ├── acp/  connectors/  daemon/  memory/  multiremi/  remi/  shared/
├── integration/   跨组件 / 全栈 / e2e 冒烟,部分需真实依赖(provider/浏览器/DB)
├── manual/        手动调试脚本(取参数、对真实服务),不是回归测试
└── fixtures/      测试用的录制数据(如 acp/*.json)
```

### 命名约定 = 是否自动跑

- **`*.test.ts`** → `bun test` **自动发现并运行**。日常单测、接口单测都用这个后缀。
  - 例:`tests/unit/multiremi/multiremi-api-issues.test.ts`(用 `createMultiremiApp()` + `app.request()` 在进程内打接口,是接口级单测的范式)。共用装置(`createStore`/`mockFetch`/`signTestJwt`/WebSocket 等待)统一从 `tests/unit/multiremi/helpers.ts` 导入,不要在测试文件里重抄一份。
- **`*.ts`(无 `.test`)** → 是**独立 harness**,`bun test` 不碰,必须通过 `package.json` 里的脚本入口手动跑(见下)。需要真实 provider / 浏览器 / Postgres 才能成立的强依赖场景放在这里。

自动发现的 `*.test.ts` **没有必需的 CI secret 或外部服务**,但不等于完全不创建连接:测试会启动 `127.0.0.1` 随机端口服务,会用保留域名验证网络失败降级,也有 Postgres/Voyage 等可选 integration block;依赖不可用时这些 block 自行 skip。CI 的安全前提是"外部依赖非必需且不注入真实凭据",不是"测试进程绝不发起连接"。

> 新增一个后端测试时:能不依赖外部服务就写成 `tests/unit/**/*.test.ts`;需要起真实服务/浏览器的写成 `tests/integration/*.ts` 并**在 `package.json` 加一个入口脚本**(否则会变成没人跑的孤儿)。

### 运行

```bash
bun test                                  # 跑所有 tests/ 下的 *.test.ts
bun test tests/unit/memory/memory.test.ts # 单个文件
```

---

## 前端测试(`frontend/`,贴着源码)

`frontend/` 的包(`packages/{ui,core,views}` + `apps/web`)是**根 bun workspace 的成员**,靠 `bun run --filter '@multiremi/*' <script>` 驱动(带 vitest 的是 core / views / web 三个;`ui` 只有 typecheck)(`frontend/package.json` 里还留着 `turbo`/`packageManager: pnpm` 的字段,但仓库里**没有 `turbo.json`**,实际不走 turbo/pnpm)。测试**故意贴着源码放**(`derive-health.test.ts` 就在 `derive-health.ts` 隔壁)。这是 Vitest/Jest 生态的主流约定,且保证每个 package 自包含、可单独构建/发布。

### 两层

1. **单元 / 组件测试(Vitest)** —— 贴源码的 `*.test.ts` / `*.test.tsx`
   - 纯逻辑:直接调函数断言返回值(同后端单测)。
   - 组件:`@testing-library/react` 的 `render(<Comp/>)` 在内存假浏览器(jsdom)里渲染,用 `vi.mock(...)` 替换依赖,断言行为。
2. **E2E(Playwright)** —— `frontend/e2e/*.spec.ts`
   - 开真 Chromium,真登录、真点击,**不 mock 后端**(连真 Postgres + 真后端)。
   - `playwright.config.ts` **不自动起服务**(`they must be running already`),跑前要先把前后端拉起来。

### 运行

```bash
# 单元 / 组件(快,不用起服务)
bun run test:frontend            # = bun run --filter '@multiremi/*' test(各包 vitest run)
cd frontend && bun run test      # 同上,从 frontend/ 里跑
cd frontend && bun run --filter @multiremi/core test   # 单个包

# E2E(需先起好前端:3000 + 后端 + Postgres)
cd frontend && bunx playwright test
```

> 注意:`frontend/e2e/` 默认连 `:8080` + `verification_code` 表,是**上游 Go 后端**的契约。要对**本仓库的 Bun 后端**跑前端真 e2e,用根目录的 `bun run e2e:frontend`(见下)。

---

## npm 脚本入口一览(`package.json`)

所有需要手动跑的测试 harness 都有入口,不留孤儿:

| 脚本 | 跑什么 | 前置依赖 |
|---|---|---|
| `bun test` | 后端全部 `*.test.ts` | 无必需外部依赖;可选 integration block 在依赖不可用时 skip |
| `bun run test:frontend` | 前端 Vitest 单元/组件 | 根目录 `bun install`(frontend 在 root workspaces 里) |
| `bun run smoke:multiremi:acp` | multiremi ACP 冒烟 | 真实 ACP agent |
| `bun run e2e:multiremi` | 内置 dashboard 全栈 e2e(真 server+daemon+**真 LLM 任务**) | provider CLI + Chromium |
| `bun run e2e:frontend` | Next 前端 ↔ 本仓库 Bun 后端(Postgres) | 前端:3000 + 后端:6130 + Postgres |
| `bun run e2e:acp` | ACP provider 冒烟 | 真实 `claude-agent-acp` |
| `bun run e2e:acp:full` | ACP 全场景套件(多工具/计划/子agent/resume) | 真实 ACP agent |
| `bun run probe:feishu` | 飞书流式渲染探针 | 真实飞书凭据 |
| `bun run replay:coverage` | ACP fixture 重放覆盖率 | 无(用 `fixtures/`) |

### `tests/manual/` 调试脚本(取参数,非回归测试,不入脚本表)

按需直接 `bun run`,多数接受参数:

```bash
bun run tests/manual/replay-fixture.ts <name>   # 重放 ACP fixture 到真实飞书卡片
bun run tests/manual/diagnose-auto-mode.ts
bun run tests/manual/test-permission-ui.ts      # 等
```

---

## CI 现状(诚实记录)

根仓库 GitHub Actions 有两个 workflow:

| workflow | 触发 | 跑什么 |
|---|---|---|
| `.github/workflows/release-build-check.yml` | PR + push to `main`(按 `apps/**`/`packages/**`/`frontend/**`/`scripts/**`/`bin/**`/`tests/**` 等路径过滤) | `build:multiremi` + `cli:capabilities:check` + `bun test tests/arch/` + **全量 `bun test`** + `typecheck:frontend` + `test:frontend` + 两个容器镜像构建;另有 `session-archive-platform` job 在 ubuntu/macOS 上跑 `tests/unit/daemon/session-archive.test.ts` |
| `.github/workflows/release.yml` | push tag `v*` | `bun run build:multiremi` → 上传 tar.gz + `scripts/install-remi.sh` 到 GitHub Release(release notes 由 `generate_release_notes` 自动生成) |

- **前端 Vitest + typecheck 在 CI 上跑**(release-build-check)。
- **后端全量 `bun test` 在 CI 上跑**(MUL-129)。此前这一步是**手写的 ~20 个文件列表**,列表外的文件在 CI 里从不执行——`tests/unit/multiremi/multiremi-api-auth.test.ts` 就因此自 `5e8ee09f` 起在 `main` 上稳定失败而门禁全绿。同时 `paths` 过滤器**不含 `tests/**`**,纯测试改动的 PR 根本不触发该 workflow。两个洞现已一起补上。
- **需要真实依赖的 e2e / 冒烟 harness 仍不在 CI 上**:它们要真实 provider/浏览器/Postgres,文件命名为 `*.ts`(无 `.test`),不会被 `bun test` 发现。自动发现集合里的本地服务测试与可选 integration block 不需要 CI secret;后者在依赖不可用时 skip。

### 本地跑 `bun test` 的两个环境陷阱

CI runner 是干净环境,本地不是。本地跑出来的失败先排除这两项再当成真 bug:

| 陷阱 | 症状 | 排除方式 |
|---|---|---|
| **`MULTIREMI_*` 环境变量注入** | 在 Multiremi 任务内跑测试时,daemon 会注入 `MULTIREMI_TOKEN`/`MULTIREMI_SERVER_URL` 等十几个变量,测试读到真实控制面配置 → 大面积失败(实测 164 条) | 清掉再跑:`env $(env \| grep -o '^MULTIREMI_[A-Z_]*' \| sed 's/^/-u /' \| tr '\n' ' ') bun test` |
| **全局 `core.hooksPath`** | `multiremi-repo-cache.test.ts` 的 prepare-commit-msg 钩子用例失败(2 条),因为测试新建的临时仓库继承了全局钩子目录 | 确认:`git config --global --get core.hooksPath`;临时排除:`GIT_CONFIG_GLOBAL=/dev/null bun test ./tests/unit/multiremi/multiremi-repo-cache.test.ts` |

---

## 为什么是两套(而不是全塞进 `tests/`)

把前端测试也搬进根 `tests/` 会**破坏**而非改善体系:

1. **工具默认**:Vitest 默认就扫源码旁的 `*.test.ts`,这是整个 JS 生态的约定。
2. **import 路径**:组件测试 `import { X } from "./comp"` 就在隔壁;搬走后变成 `../../../../...`,源码一挪测试全断。
3. **包自洽**:`bun run --filter '@multiremi/*' test` 按包跑/构建,package 必须连同自己的测试一起自包含。
4. **成本倒挂**:搬 180+ 文件、改一堆 import、重配扫描路径,只为得到一个违背约定的目录。

所以:**后端集中、前端贴源码,各自内部保持一致,就是本仓库的"体系化"。**
