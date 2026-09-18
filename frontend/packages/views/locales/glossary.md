---
title: Remi 前端翻译上下文
status: active
summary: 当前语言资源、翻译调用及键与插值一致性检查入口。
---

# Remi 前端翻译上下文

[资源入口](index.ts)汇集 `en`、`zh-Hans`、`ko`、`ja` 四种语言，按业务 namespace 拆分 JSON。页面通过 [useT](../i18n/use-t.ts)及 selector 形式读取翻译，例如 `t($ => $.signin.title)`。

修改术语先核对对应页面实际消费的 namespace，以及同一资源在四种语言中的文案；当前中文导航用词见 [zh-Hans/layout.json](zh-Hans/layout.json)。资源键是实现契约，不要求用户可见文案与代码实体名相同。

新增文案时同步维护各语言的键和插值占位符，验证入口为 [parity.test.ts](parity.test.ts)。开发规则见[前端 AGENTS.md](../../../AGENTS.md)，运行命令见[前端验证入口](../../../../docs/dev/frontend.md#验证入口)。
