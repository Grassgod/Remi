---
title: Remi 时区与使用量
status: active
summary: 当前查看者时区、调度时区、查询缓存及服务端用量聚合路径。
---

# Remi 时区与使用量

调度时区决定规则里的本地时间何时触发；查看者时区决定使用量图表的日界。两者来自不同的用户选择。

## 前端读取与传递

| 环节 | 当前实现 |
| --- | --- |
| 查看者时区 | [useViewingTimezone](../packages/views/common/use-viewing-timezone.ts)先取 `user.timezone`，未设置时调用 [browserTimezone](../packages/views/common/timezone-select.tsx)，浏览器检测失败回退 UTC。 |
| 保存偏好 | [PreferencesTab](../packages/views/settings/components/preferences-tab.tsx)通过 `api.updateMe` 保存，成功后更新 Auth store；清空偏好后跟随浏览器。 |
| 使用量请求与缓存 | [runtime 查询工厂](../packages/core/runtimes/queries.ts)将 `tz` 放入 query key，并传给 [runtime API](../packages/core/api/endpoints/runtimes.ts)的查询参数。 |
| 图表窗口 | [UsageSection](../packages/views/runtimes/components/usage-section.tsx)使用查看者时区获取数据，并将同一 `tz` 传给 [sliceWindow 等聚合函数](../packages/views/runtimes/utils.ts)。 |
| 调度时区选择 | [自动化时区选择器](../packages/views/autopilots/components/pickers/timezone-picker.tsx)服务于触发规则；平台自动更新在 [PlatformTab](../packages/views/settings/components/platform-tab.tsx)维护自己的调度配置。 |

变更查看者时区时，请求参数、缓存 key、图表窗口要一起核对。不要仅改变标签时区而继续展示另一个时区的缓存数据。

## 服务端实际聚合

[runtime 路由](../../packages/server/src/api/routers/runtimes.ts)将参数交给 [usageQuery](../../packages/server/src/api/helpers/tasks.ts)，后者读取请求的 `tz`，缺省为 null；这里没有读取用户时区偏好的回退。前端需要显式传入查看者时区。

[UsageRepo](../../packages/server/src/store/repos/usage-repo.ts)筛选 `multiremi_tasks`，再在 JavaScript 中聚合用量。日期/小时通过 `Intl.DateTimeFormat` 按 `tz` 分桶；缺省或无效时区使用 UTC。窗口起点由 `usageSince` 计算，包含日界与时区偏移处理。任务的归属时间按完成、失败、取消、启动、分发、更新、创建时间的顺序选取。

这是当前逐任务读取与聚合的实现。没有本页支持的性能测量；优化时先记录数据量、查询数、服务端耗时和边界正确性，流程见[性能上下文](../../docs/dev/performance.md)。

## 验证入口

- 查看者偏好与浏览器回退：[use-viewing-timezone.test.ts](../packages/views/common/use-viewing-timezone.test.ts)。
- 保存/清空偏好：[preferences-tab.test.tsx](../packages/views/settings/components/preferences-tab.test.tsx)。
- 图表聚合与窗口：[runtimes/utils.test.ts](../packages/views/runtimes/utils.test.ts)。
- 服务端用量：[store-usage-repo.test.ts](../../tests/unit/multiremi/store-usage-repo.test.ts)。

变更上述路径时，关注 UTC 午夜、夏令时切换、无效时区和切换偏好后的缓存隔离。具体执行命令见[前端验证入口](../../docs/dev/frontend.md#验证入口)及[仓库测试指南](../../TESTING.md)；本次仅核对源码，未运行这些产品测试。
