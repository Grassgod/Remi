# 开发命令

仓库规则见 [AGENTS.md](AGENTS.md)，实现地图见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，按任务导航见 [docs/dev/README.md](docs/dev/README.md)。

所有下列命令均从仓库根目录运行。使用 [package.json](package.json) 固定的 Bun 1.3.14；后端与前端共享一次根目录安装。

```bash
bun install --registry https://registry.npmjs.org --frozen-lockfile
bun test
bun test tests/unit/daemon/agent-runtime-send-options.test.ts
bunx tsc --noEmit
bun run test:frontend
bun run typecheck:frontend
bun run --filter @multiremi/web dev          # 此脚本依赖 sh
bun run apps/server/main.ts serve
bun run apps/remi/main.ts start
```

Windows 原生 PowerShell 没有 `sh` 时，在 `frontend/apps/web` 中运行 `bunx next dev --webpack --port 3000`，完成后回仓库根目录运行其他命令。

Web、API、daemon 是独立入口。API 的生产启动先校验必要配置，见[认证与启动约束](docs/dev/auth.md)；底层 Store 支持 PostgreSQL 和本地 SQLite，不能把缺少生产配置解释为可直接启动。Web 的 `REMOTE_API_URL` 指向 API。daemon 连接、工作区及 Feishu bot 的必要环境见[环境说明](docs/deploy/66-8-remi-environment.md)。真实 provider 还需要对应 CLI 的凭据，安装方式见 [README](README.md)。

按变更范围选择检查：

```bash
npm run docs:test
npm run docs:check
bun test tests/arch/
bun run scripts/snapshot-api-routes.ts --check
bun run cli:capabilities:check
bun run build:multiremi
```

文档检查使用 Node.js 22+，不需要 Bun 或安装依赖。测试分层、需要真实服务的 E2E 和 CI 范围见 [TESTING.md](TESTING.md)；性能复现入口见[性能调查](docs/dev/performance.md)。构建产物不等于发版。
