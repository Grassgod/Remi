# Runtime Skill 导入

在侧栏「配置 → Skills」打开「从运行时导入」，选择自己拥有且在线的 Runtime，指定目录、扫描并勾选要导入的 Skill。导入结果保存在该 Runtime 所属工作区的 Remi 技能库，之后可在云友配置中选用；导入本身不会自动给某个云友启用 Skill。

目录位于 Runtime 所在机器，可输入绝对路径或 `~/` 路径后扫描。`~` 由 daemon 按自己的用户主目录展开；CLI 示例中的路径使用引号，避免调用方的 Shell 提前展开。选择默认目录或在 CLI 中省略 `--root` 时，沿用 provider 的默认 Skill 目录及现有发现流程：Claude 默认 `~/.claude/skills`，Codex 默认 `$CODEX_HOME/skills`（未设置时为 `~/.codex/skills`），daemon 已配置的目录覆盖仍有效。

切换 Runtime 或修改目录后，需要重新扫描再勾选。列表展示名称、描述、来源路径和文件数；无法完整导入的 Skill 展示原因且不可勾选。批量导入逐项返回成功或失败，已成功的条目不会因其他条目失败而回滚。

## 指定目录的扫描与文件范围

扫描发现目录中的 `SKILL.md`，包含隐藏目录、深层目录及根目录自身。每个 Skill 的 `key` 是相对扫描根目录的路径，根目录自身的 key 为 `.`。包含 `SKILL.md` 的目录作为一个完整 Skill，其内部的示例 `SKILL.md` 属于支持文件，不再单独列为 Skill；`.git` 和 `node_modules` 作为仓库元数据与依赖目录排除。

自定义目录扫描最多检查 10,000 个目录条目、列出 1,000 个 Skill，并设有 20 秒扫描预算。达到上限或某个子目录不可读时，结果通过 `warnings` 明确说明未扫描完整，可改选更具体的目录重扫。根目录不存在、不是目录或无法读取时，整个扫描失败。发现阶段支持指向目录的符号链接，按真实路径去重以避免循环。

技能库采用文本文件存储。指定目录导入包含 `SKILL.md` 和可保存的 UTF-8 支持文件，附件中的 `.git` 和 `node_modules` 同样排除。每个文件上限 1 MiB，主文件和支持文件合计上限 8 MiB，支持文件最多 128 个；打包还限制目录遍历深度、条目数和耗时。二进制、无效 UTF-8、不可读文件、符号链接主文件或附件、非法文件路径及超限会使该 Skill 不可导入，不通过静默丢弃附件生成残缺副本。旧默认目录流程保留原有兼容行为；需要上述完整性检查时显式指定目录。

每次导入在技能库创建新副本，保留当时读取的内容和来源信息，不覆盖原文件、不按名称自动去重，也不建立与原目录的持续同步。扫描确认目录和可选 key，文件内容在导入时重新读取、校验；扫描后源文件若变化，实际导入以本次读取为准。

## CLI 和请求契约

以下命令使用 Runtime ID，也支持现有 CLI 的 Runtime 名称解析：

```bash
remi runtime skill scan <runtime-id> --root '~/.agents/skills' --json
remi runtime skill status <runtime-id> <scan-request-id> --json
# 等扫描 status 为 completed，再使用结果中的 key：
remi runtime skill import <runtime-id> --scan-request <scan-request-id> --key '.system/example' --name 'Example' --json
remi runtime skill import-status <runtime-id> <import-request-id> --json
```

`scan` 请求体为 `{ "root": "~/.agents/skills" }`，返回请求 ID。轮询 `status` 得到状态、自定义目录的实际绝对 `root`、`skills` 和 `warnings`。`import` 使用 `{ "scan_request_id": "…", "skill_key": "…" }`，可追加 `name` 和 `description`。扫描必须属于同一 Runtime，且已完成、受支持、包含所选 key，所选 Skill 不能带有扫描错误。服务端从扫描记录读取目录，调用方不能另填导入目录来替换来源。

`import-status` 的 `completed` 表示副本已进入技能库，结果带有导入后的 Skill；`failed` 时读取 `error`。扫描与导入都是异步请求，创建成功不能视为导入完成。API 路由及返回兼容字段见[Runtime 接口](../packages/server/src/api/routers/runtimes.ts)。

现有 `--data` 和 `--file` JSON 请求输入保留，显式参数覆盖同名请求字段；`--json` 是输出格式选项。省略 `--root` 的扫描和省略 `--scan-request` 的导入保留旧默认目录接口。自定义目录请求需要支持该能力的新 daemon；旧 daemon 领取时将请求明确标为失败并要求更新，不会改为扫描默认目录。

## 实现与验证入口

入口：[导入面板](../frontend/packages/views/skills/components/runtime-local-skill-import-panel.tsx)、[扫描和打包](../packages/server/src/worker/local-skills.ts)、[daemon 请求执行](../packages/server/src/worker/daemon.ts)、[请求存储](../packages/server/src/store/repos/runtimes-repo.ts)、[CLI 注册](../apps/remi/cli/commands/operations.ts)。

```bash
bun test tests/unit/remi/cli-operations.test.ts
bun test tests/unit/daemon/runtime-skill-directory.test.ts tests/unit/multiremi/runtime-skill-directory.test.ts
bun test tests/unit/multiremi/multiremi-api-runtimes.test.ts tests/unit/multiremi/store-runtime-request-queue.test.ts
bun run --filter @multiremi/views test skills/components/runtime-local-skill-import-panel.test.tsx
bun run cli:capabilities:check
```

这些命令是验证入口，不表示当前环境已执行；具体执行结果在对应变更的验收记录中说明。
