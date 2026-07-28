# 仓库指南

本文件是仓库级 Agent 规则的唯一事实来源；项目架构和命令见 `CLAUDE.md`。
处理子目录时，还需遵循该目录中的指令文件。

## 版本与发版

- 仅在用户明确要求时按 SemVer 发版；`package.json`、Git tag 和 GitHub Release
  必须一致且不得复用 tag，平台部署与 daemon CLI 发版分开处理。
- 发版必须使用公共依赖源和固定 Bun 版本，并先通过
  `.github/workflows/release-build-check.yml` 的完整检查；失败时不得发版。
