# 参与前端开发

先读[仓库级规则](../AGENTS.md)与[前端规则](AGENTS.md)，再按[前端开发上下文](../docs/dev/frontend.md)定位需要修改的包及验证入口。

依赖安装、API 与 Web 启动命令统一维护在[仓库开发入口](../CLAUDE.md)。从仓库根使用 Bun workspace；包的实际脚本见各包的 `package.json`。

提交前说明用户可观察到的变化和实际执行的验证。测试范围按[测试指南](../TESTING.md)选择；涉及数据流、API 契约或命令时，同批更新负责该主题的文档，维护方式见[上下文维护](../docs/dev/context-maintenance.md)。

按任务补充阅读：

| 任务 | 当前实现入口 |
| --- | --- |
| 样式、字体、组件交互 | [视觉实现](docs/design.md) |
| 产品事件与页面浏览统计 | [前端统计](docs/analytics.md) |
| 使用量图表、时区和日界 | [时区与使用量](docs/timezone.md) |
| 翻译与语言资源 | [翻译上下文](packages/views/locales/glossary.md) |
