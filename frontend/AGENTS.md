# 前端 Agent 规则

先读[仓库级规则](../AGENTS.md)。本文件只补充 `frontend/` 的约束；当前结构与源码导航见[前端开发上下文](../docs/dev/frontend.md)。

## 包边界

- `packages/core/` 放 API、查询、纯业务逻辑及共享 Zustand store；不引入 `react-dom`、UI 库或 `process.env`。持久化通过 `StorageAdapter`，业务代码不直接访问 `localStorage`。
- `packages/ui/` 放基础组件和样式，不依赖 `@multiremi/core`。
- `packages/views/` 放业务页面和组件，不定义共享 store，不引入 `next/*` 或 `react-router-dom`；导航使用 `useNavigation()` / `AppLink`。
- `apps/web/` 承接 Next.js 路由、服务端布局和浏览器配置；共享导航的框架适配放在 `apps/web/platform/navigation.tsx`。
- 各包显式声明直接导入的外部依赖。共享版本引用根 `package.json` 的 `catalog`；安装与工作区命令遵循根文档。

## 状态与实时数据

- TanStack Query 保存服务端数据；Zustand 保存筛选、草稿、选择等客户端状态。不要把查询结果复制进 store。
- 工作区身份来自 URL，由工作区 layout 同步给平台层。工作区集合查询的 key 必须包含 `wsId`；资源查询沿用该领域现有 key 工厂及切换、删除清理规则。
- 可复用的工作区查询/hook 接收 `wsId`，避免假定调用位置一定在页面 Provider 内。
- Zustand selector 返回稳定引用；需要组合结果时使用浅比较。只持久化有长期价值的偏好与草稿，工作区数据使用分区存储。
- WS 的服务端数据更新写入或失效 Query cache，不写入 Zustand。清理客户端选择、导航等副作用沿用现有领域处理器。
- 新事件同时检查 `realtime/sync/` 的精确处理器和 `prefix-refresh.ts`，避免重复刷新；保留流式消息的批处理与订阅清理。
- 乐观更新必须有可恢复的缓存快照和失败回滚。创建、删除及依赖服务器结果的导航等待请求成功；发送消息保留 pending/失败重试状态。

## API 与 UI

- API 响应通过 `packages/core/api/schema.ts` 的 schema 边界解析，不把裸 JSON 强制断言为业务类型。展示读取可显式降级；命令响应不能把格式异常当成成功，使用适当的严格解析。
- 对未知服务端枚举保留展示兜底；修改响应消费逻辑时覆盖缺字段、错误类型等边界。
- 优先复用现有基础组件、`packages/ui/styles/` 的语义 token，以及 `packages/views/i18n/` 的翻译入口；修改文案同步检查 `locales/` 的语言键。
- 保持长文本截断、滚动容器、加载态与空态可用。新增全局路由需检查工作区 slug 路由冲突。

## 测试

- 测试跟随实现：数据/状态在 `packages/core/`，业务组件在 `packages/views/`，Next.js 接线在 `apps/web/`。
- `packages/views/` 测试不 mock `next/*` 或 `react-router-dom`；通过导航适配器和 `@multiremi/core/api` 隔离平台及网络。
- Mock Zustand store 时保留可调用 selector 与 `.getState()` 的形状；沿用同目录已有 fixture。
- 先运行受影响包的针对性测试，再按影响范围扩展检查；不为文档修改启动服务或执行完整端到端流程。实际测试环境和入口见[开发上下文](../docs/dev/frontend.md#验证入口)。
