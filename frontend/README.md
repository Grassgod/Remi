# Remi 前端

这里是 Remi / Multiremi 的 Web 控制台：查看任务与执行过程，在工作台处理待验收或待输入任务，管理项目、云友、设备与自动化。

当前应用入口是 `apps/web/`（Next.js App Router）。业务逻辑、页面和基础组件分别放在 `packages/core/`、`packages/views/`、`packages/ui/`。后端位于仓库根的 `packages/server/`，由 Bun + Hono 提供 API；本目录不单独维护服务端或客户端发布流程。

开始开发前阅读：

- [仓库开发入口](../CLAUDE.md)：环境、命令与全局导航。
- [前端开发上下文](../docs/dev/frontend.md)：目录职责、启动接线、数据流和源码定位。
- [前端 Agent 规则](AGENTS.md)：状态、包边界和测试要求。

依赖由[根 Bun workspace](../package.json)统一管理，在仓库根安装。各包命令以其 `package.json` 为准；前端目录内的旧包管理元数据不构成另一套安装流程。
