---
title: Remi Web 视觉实现
status: active
summary: 当前 Web 样式入口、语义 token、字体与基础组件来源。
---

# Remi Web 视觉实现

本页定位当前样式实现；前端开发约束统一维护在[前端规则](../AGENTS.md)。

## 样式来源

| 内容 | 源码 |
| --- | --- |
| Tailwind 与共享样式接线 | [Web globals.css](../apps/web/app/globals.css) |
| 明暗主题、语义色、图表色及圆角变量 | [tokens.css](../packages/ui/styles/tokens.css) |
| Markdown 高亮、动画与通用样式 | [base.css](../packages/ui/styles/base.css) |
| Web 专属样式 | [custom.css](../apps/web/app/custom.css) |
| 主题切换 | [ThemeProvider](../apps/web/components/theme-provider.tsx) |

`tokens.css` 用 OKLCh 定义 `:root` 和 `.dark` 两套色值，经 `@theme inline` 映射为 Tailwind 语义类。主要文字/表面使用 `foreground`、`background`、`muted` 等；状态使用 `destructive`、`success`、`warning`、`info`，品牌使用 `brand`。具体色值及圆角比例以该文件为准。

## 字体

[Web layout](../apps/web/app/layout.tsx)通过 `next/font/google` 加载 Inter、Geist Mono、Source Serif 4。正文的 CJK fallback 和日语优先字体链在 `globals.css`；等宽及衬线字体使用相应 CSS 变量。修改字体需要同时核对布局提供的变量与 CSS 引用。

## 基础组件

[ui/components/ui](../packages/ui/components/ui/)提供按钮、表单、弹层等基础组件。例如 [Button](../packages/ui/components/ui/button.tsx)基于 Base UI 与 `class-variance-authority` 定义 variant、size、focus-visible、disabled 和 aria-invalid 的样式；业务页面复用这些实现。

组件验证按实际交互覆盖明暗主题、键盘焦点、禁用/错误状态、长文本和窄屏滚动。验证命令见[前端开发上下文](../../docs/dev/frontend.md#验证入口)；本页不代表这些检查已执行。
