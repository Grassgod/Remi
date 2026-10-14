---
title: Remi 前端翻译上下文
status: active
summary: 当前语言资源、翻译调用及键与插值一致性检查入口。
---

# Remi 前端翻译上下文

[资源入口](index.ts)汇集 `en`、`zh-Hans`、`ko`、`ja` 四种语言，按业务 namespace 拆分 JSON。页面通过 [useT](../i18n/use-t.ts)及 selector 形式读取翻译，例如 `t($ => $.signin.title)`。

修改术语先核对对应页面实际消费的 namespace，以及同一资源在四种语言中的文案；当前中文导航用词见 [zh-Hans/layout.json](zh-Hans/layout.json)。资源键是实现契约，不要求用户可见文案与代码实体名相同。

Chat 运行中的两种后续发送方式沿用 Codex 的中文用词：**引导**（Steer，送进正在运行的这一轮，不中断模型）与**排队**（Queue，这一轮结束后发送）。它们与 Issue 任务的「转向」（`issues.task_steer`）是不同功能；ja、ko 由英文翻译，引导与 Issue 转向共用「方向転換」「방향 전환」。键在 `chat.input`、`chat.queue` 与 `settings.preferences.chat`。

新增文案时同步维护各语言的键和插值占位符，验证入口为 [parity.test.ts](parity.test.ts)。开发规则见[前端 AGENTS.md](../../../AGENTS.md)，运行命令见[前端验证入口](../../../../docs/dev/frontend.md#验证入口)。
