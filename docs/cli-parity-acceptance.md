# CLI 能力验收

CLI 的当前命令、别名和 API 映射来自 [CommandRegistry](../apps/remi/cli/core/command-registry.ts) 与 [cli-capabilities.json](../cli-capabilities.json)。不要复制某次发版的命令数量或 `Pass` 表格作为本版本验收。

## 验收入口

| 需要确认 | 执行依据 |
|---|---|
| API 能力均有真实命令或允许的 exemption，missing 为 0 | `bun run cli:capabilities:check`；[检查脚本](../scripts/check-cli-capabilities.ts) |
| 新增/变更命令的参数、help、身份和输出声明完整 | [manifest 测试](../tests/arch/cli-capabilities-manifest.test.ts)与 [Registry](../apps/remi/cli/core/command-registry.ts) |
| CLI 路径是 canonical，旧 alias 生命周期正确 | [命令迁移契约](cli-command-migration.md) |
| 鉴权和实际行为正确 | [CLI API 测试](../tests/unit/multiremi/multiremi-api-cli.test.ts)、[当前权限边界](dev/auth.md)与各域 CLI 执行测试 |
| 路由形状未意外改变 | `bun run scripts/snapshot-api-routes.ts --check` |
| 二进制、类型、测试与平台产物满足门禁 | [release-build-check.yml](../.github/workflows/release-build-check.yml)；[测试指南](../TESTING.md)解释其覆盖范围 |

新增或变更用户能力时按 [AGENTS.md](../AGENTS.md)先注册真实可执行命令或声明合法 exemption，再运行 `bun run cli:capabilities:generate` 并检查生成差异。单纯重生成 manifest 不能证明命令可执行或鉴权正确。

记录本次实际命令、工作树/提交、通过或失败结果及未运行项目。真实 provider 与浏览器验证需要独立执行，不能从 manifest 覆盖率推断；发版遵循仓库规则中的明确授权与完整检查要求。
