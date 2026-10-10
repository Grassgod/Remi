# 开发命令

仓库规则见 [AGENTS.md](AGENTS.md)，实现地图见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，按任务导航见 [docs/dev/README.md](docs/dev/README.md)。

所有下列命令均从仓库根目录运行。使用 [package.json](package.json) 固定的 Bun 1.3.14；后端与前端共享一次根目录安装。

```bash
bun install --registry https://registry.npmjs.org --frozen-lockfile
bun run test
bun run test tests/unit/daemon/agent-runtime-send-options.test.ts
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
bun run test tests/arch/
bun run scripts/snapshot-api-routes.ts --check
bun run cli:capabilities:check
bun run build:multiremi
```

文档检查使用 Node.js 22+，不需要 Bun 或安装依赖。测试分层、需要真实服务的 E2E 和 CI 范围见 [TESTING.md](TESTING.md)；性能复现入口见[性能调查](docs/dev/performance.md)。构建产物不等于发版。

CI 的后端四分片、完整覆盖报告和权重维护入口见 [测试与 CI 覆盖](TESTING.md#ci-覆盖)。文件规划不执行测试：

```bash
bun run scripts/ci-backend.ts plan --sha <40位提交SHA> --shards 4 --out ci-backend/plan.json
bun run scripts/ci-backend.ts weights --coverage ci-backend/coverage.json --run-id <完整运行ID> --out ci-backend/weights.json
```

依赖准备的新版本提交到 main 后，该次 main push 完整 CI 直接保存正式 CLI/OCI 候选，无需再为同一 SHA 手动重复完整检查。补生成或重建仍可用 `gh workflow run release-build-check.yml --ref main -f release_candidate=true` 显式执行完整 CI；普通 main、PR 和 verified retry 不生成正式候选，候选生成不等于授权发版。发布复用与失败恢复规则见 [TESTING.md](TESTING.md)。
