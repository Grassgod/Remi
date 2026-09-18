---
title: Remi 前端统计接线
status: active
summary: 根据当前源码说明 PostHog 初始化、页面统计及仍有调用的前端事件边界。
---

# Remi 前端统计接线

本页描述 Remi Web 现有接线，不将导出的工具函数视为已经可用的产品流程。

## 配置与身份

[服务端 /api/config](../../packages/server/src/api/server.ts)返回 `posthog_key`、`posthog_host` 等配置。`POSTHOG_API_KEY` 未设置时 key 为空；`ANALYTICS_DISABLED=true` 或 `1` 会覆盖为空。

[AuthInitializer](../packages/core/platform/auth-initializer.tsx)读取配置，仅在 key 非空时调用 [initAnalytics](../packages/core/analytics/index.ts)。登录成功调用 identify，传入用户 ID、邮箱和名称；登出或鉴权失败清理统计身份。当前实现不能据此宣称“不发送个人信息”。

`initAnalytics` 在浏览器初始化 PostHog，关闭自动页面统计、自动捕获、热图、异常捕获、会话录制和问卷。客户端属性包括 `client_type`、`event_schema_version`、`environment`、`is_demo`，可附带版本号。初始化前的 identify、pageview 与事件有各自缓冲；具体时序以实现和[单元测试](../packages/core/analytics/index.test.ts)为准。

## 当前调用路径

| 信号 | 接线与行为 |
| --- | --- |
| 页面浏览 `$pageview` | [PageviewTracker](../apps/web/components/pageview-tracker.tsx)挂在 [WebProviders](../apps/web/components/web-providers.tsx)，路由变化时调用 `capturePageview`；函数移除查询串、hash 和资源 ID，并折叠连续相同 section。 |
| 登录归因 cookie | AuthInitializer 调用 `captureSignupSource`，记录有长度上限的 UTM 与 referrer origin；不保留 referrer 查询串。该调用独立于 PostHog key 是否配置。 |
| 人物属性更新与自定义事件 | `captureEvent`、`setPersonProperties` 是封装能力；确认具体业务调用方后再登记为实际产品事件。 |

[download.ts](../packages/core/analytics/download.ts)仍导出下载事件函数，但当前 Web 没有下载页面；[LandingFooter](../apps/web/features/landing/components/landing-footer.tsx)还会过滤 `/download` 链接。这些函数不证明存在可用的桌面下载漏斗。

服务端自身的事件记录实现见 [AnalyticsRepo](../../packages/server/src/store/repos/analytics-repo.ts)。新增跨前后端统计时，分别核对发送路径、事件字段与配置，不从前端依赖推断服务端已有上报服务。

## 验证

修改初始化、身份或 pageview 归一化时，运行 core 的 [analytics/index.test.ts](../packages/core/analytics/index.test.ts)，并检查配置关闭、登录/退出、首屏配置延迟、URL 中含查询参数的行为。命令见[前端验证入口](../../docs/dev/frontend.md#验证入口)。这些是后续修改的验证要求，本次文档核对未运行产品测试或真实 PostHog 上报。
