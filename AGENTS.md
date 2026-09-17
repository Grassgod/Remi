# 仓库指南

本文件是仓库级 Agent 规则的唯一事实来源；架构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，命令见 [`CLAUDE.md`](CLAUDE.md)。
处理子目录时，还需遵循该目录中的指令文件。

## 开发上下文

- 从 [`docs/dev/README.md`](docs/dev/README.md) 按任务读取当前说明，再定位源码和验证入口；不默认加载全量文档、旧方案或任务记录。文档与实现冲突时核对源码并修正文档，不能只加历史提示后继续作为开发依据。
- 代码改变已记录的架构、契约或命令时，同批更新对应文档；维护归属、文档状态与检查方式见 [`context-maintenance.md`](docs/dev/context-maintenance.md)。仓库级规则仍只在本文件定义，前端专属规则见 [`frontend/AGENTS.md`](frontend/AGENTS.md)。
- 文档中的完成状态、性能数字和验证结论必须有实际证据；没有执行的检查明确标为未执行。
- 过时内容在原归属处重写，已被替代的方案从工作树移除并通过 Git 历史追溯；提交前运行 `npm run docs:test` 和 `npm run docs:check`，避免默认阅读链重新引入过期资料。

## CLI 能力对齐

- 新增或变更用户侧 API/功能时，必须同批对齐 CLI：在 CommandRegistry 注册真实可执行命令
  （help/鉴权/参数由声明生成），或按固定 category 在 manifest 写明理由 `cli_exempt`；
  然后运行 `bun run scripts/generate-cli-capabilities.ts` 更新 `cli-capabilities.json`，
  保持 `bun run scripts/check-cli-capabilities.ts` 为 0 missing。
  不得通过调高 ratchet 或滥用 exempt 掩盖用户能力缺口。
- 新增顶层主题域需同步 Registry 帮助与 `docs/cli-command-migration.md`；
  弃用旧命令路径必须注册 deprecated alias 并保留至少一个发版周期，
  服务端注入 prompt 与文档只使用 canonical 命令。

## 云友与 Skill 配置规范

- 新增或修改 agent 模板（`packages/server/src/api/agent-templates/*.json`）与仓库内
  SKILL.md（`.remi/pipeline/skills/`、`frontend/.agents/skills/`）时，必须遵循
  `docs/agent-config-spec.md`：提示词六段骨架，description 必填且写明触发条件；
  `bun test tests/arch/agent-config-metadata.test.ts` 必须通过。
- 变更工作区云友（DB 中的 instructions/头像）同样以该规范为 checklist；
  可复制的提示词模板见 `docs/templates/agent-prompt.md.example`。

## 版本与发版

- 仅在用户明确要求时按 SemVer 发版；`package.json`、Git tag 和 GitHub Release
  必须一致且不得复用 tag，平台部署与 daemon CLI 发版分开处理。
- 发版必须使用公共依赖源和固定 Bun 版本，并先通过
  `.github/workflows/release-build-check.yml` 的完整检查；失败时不得发版。
- 每次发版（包括夜间发版）先运行 `bun run release:prepare --version <下一版本>`，
  查询并验证最新稳定 ACP / Claude SDK / CC / Codex，更新 `package.json` 与
  `packages/acp/src/runtime-versions.json`，同批提交后再跑 CI、打 tag。
  不得只改版本号跳过依赖准备，也不得在 tag 构建或 daemon 运行时重新解析 latest。
