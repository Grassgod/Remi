# 仓库指南

本文件是仓库级 Agent 规则的唯一事实来源；项目架构和命令见 `CLAUDE.md`。
处理子目录时，还需遵循该目录中的指令文件。

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
