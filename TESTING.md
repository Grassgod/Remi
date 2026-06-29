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
  - 例:`tests/unit/multiremi/multiremi-core.test.ts`(用 `createMultiremiApp()` + `app.request()` 在进程内打接口,是接口级单测的范式)。
- **`*.ts`(无 `.test`)** → 是**独立 harness**,`bun test` 不碰,必须通过 `package.json` 里的脚本入口手动跑(见下)。这样做是因为它们依赖真实 provider / 浏览器 / Postgres,不能在普通单测里跑。

> 新增一个后端测试时:能不依赖外部服务就写成 `tests/unit/**/*.test.ts`;需要起真实服务/浏览器的写成 `tests/integration/*.ts` 并**在 `package.json` 加一个入口脚本**(否则会变成没人跑的孤儿)。

### 运行

```bash
bun test                                  # 跑所有 tests/ 下的 *.test.ts
bun test tests/unit/memory/memory.test.ts # 单个文件
```

---

## 前端测试(`frontend/`,贴着源码)

前端是 Turbo + pnpm monorepo,测试**故意贴着源码放**(`derive-health.test.ts` 就在 `derive-health.ts` 隔壁)。这是 Vitest/Jest 生态的主流约定,且保证每个 package 自包含、可单独构建/发布。

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
bun run test:frontend            # = cd frontend && pnpm test (turbo → 各包 vitest run)
cd frontend && pnpm --filter @multiremi/core test   # 单个包

# E2E(需先起好前端:3000 + 后端 + Postgres)
cd frontend && pnpm exec playwright test
```

> 注意:`frontend/e2e/` 默认连 `:8080` + `verification_code` 表,是**上游 Go 后端**的契约。要对**本仓库的 Bun 后端**跑前端真 e2e,用根目录的 `bun run e2e:frontend`(见下)。

---

## npm 脚本入口一览(`package.json`)

所有需要手动跑的测试 harness 都有入口,不留孤儿:

| 脚本 | 跑什么 | 前置依赖 |
|---|---|---|
| `bun test` | 后端全部 `*.test.ts` | 无 |
| `bun run test:frontend` | 前端 Vitest 单元/组件 | 已 `pnpm install`(frontend) |
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

- 根仓库 GitHub Actions 目前只有 `.github/workflows/release.yml`,**只做 build,不跑任何测试**。
- `frontend/.github/workflows/ci.yml` 是从上游 multica 带来的(指向 Go `server/`),**嵌套目录的 workflow GitHub 不会执行**,等于摆设。
- 即 `bun test` / 前端 Vitest / e2e **当前都不在 CI 上自动跑**,需本地手动执行。补 CI 时:`bun test` 和 `test:frontend` 可直接进;e2e 需要真实 provider/浏览器/DB,要么配 secrets,要么用 mock provider。

---

## 为什么是两套(而不是全塞进 `tests/`)

把前端测试也搬进根 `tests/` 会**破坏**而非改善体系:

1. **工具默认**:Vitest 默认就扫源码旁的 `*.test.ts`,这是整个 JS 生态的约定。
2. **import 路径**:组件测试 `import { X } from "./comp"` 就在隔壁;搬走后变成 `../../../../...`,源码一挪测试全断。
3. **包自洽**:`turbo test` 按包跑/构建/发布,package 必须连同自己的测试一起自包含。
4. **成本倒挂**:搬 180+ 文件、改一堆 import、重配扫描路径,只为得到一个违背约定的目录。

所以:**后端集中、前端贴源码,各自内部保持一致,就是本仓库的"体系化"。**
