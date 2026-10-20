---
title: Remi 前端翻译上下文
status: active
summary: 当前语言资源、翻译调用及键与插值一致性检查入口。
---

# Remi 前端翻译上下文

[资源入口](index.ts)汇集 `en`、`zh-Hans`、`ko`、`ja` 四种语言，按业务 namespace 拆分 JSON。页面通过 [useT](../i18n/use-t.ts)及 selector 形式读取翻译，例如 `t($ => $.signin.title)`。

修改术语先核对对应页面实际消费的 namespace，以及同一资源在四种语言中的文案；当前中文导航用词见 [zh-Hans/layout.json](zh-Hans/layout.json)。资源键是实现契约，不要求用户可见文案与代码实体名相同。

Chat 运行中的两种后续发送方式沿用 Codex 的中文用词：**引导**（Steer，送进正在运行的这一轮，不中断模型）与**排队**（Queue，这一轮结束后发送）。它们与 Issue 任务的「转向」（`issues.task_steer`）是不同功能；ja、ko 由英文翻译，引导与 Issue 转向共用「方向転換」「방향 전환」。键在 `chat.input`、`chat.queue` 与 `settings.preferences.chat`。

**子代理**（subagent）是 Agent 在一轮里派生、替它完成一部分工作的代理，包括 Claude 的 Agent / Task 和 Codex 的子线程；**智能体**只指用户自己的 Agent，两者不混用。en 用 subagent，ja 用「サブエージェント」，ko 用「하위 에이전트」。执行步骤里的子代理文案在 `chat.steps`（`subagent_*`、`agent_*`、`summary_agent_*`），与 `@multiremi/shared` 的 `STEP_COPY_ZH` 同源；子代理行、完成行、运行条和子代理面板的文案在 `chat.subagents`，折叠标题后缀与控制动作详情在 `chat.turn_steps`（`background_running`、`message_to*`），侧栏计数在 `chat.sidebar.status.subagents`。

**后台任务**（background task）是 Agent 的一次调用交给后台继续跑的工作：后台命令（Claude 的后台 Bash、Codex 的后台终端）、后台工作流和其他后台任务，可以在这一轮结束后继续运行；它不是子代理。en 用 background task / background command / background workflow，ja 用「バックグラウンドタスク」「バックグラウンドコマンド」「バックグラウンドワークフロー」，ko 用「백그라운드 작업」「백그라운드 명령」「백그라운드 워크플로」。执行步骤里启动它的那一行的文案在 `chat.steps`（`background_*`），与 `STEP_COPY_ZH` 同源；右侧面板的后台任务视图、运行条、结束提示、门铃行和停止的文案，以及共享本地文件夹被另一个对话的后台任务占用时的等待提示（`folder_held*`），在 `chat.bg_tasks`，会话头「查看子代理与后台任务」按钮与子代理概览的分组文案在 `chat.subagents`（`panel_toggle*`、`chat_empty`、`turn_untitled`），侧栏计数在 `chat.sidebar.status.bg_tasks`，归档与删除确认里的后台任务说明在 `chat.sidebar.archive_dialog` / `delete_dialog`。门铃是平台在后台任务结束时发给智能体的消息，Chat 里显示为一行「后台任务 X 已完成」。

Chat 输入框的「/」菜单分两组：**Agent 命令**（agent 自己的桥发布的命令，en 用 Agent commands，ja 用「エージェントコマンド」，ko 用「에이전트 명령」）和**技能**（Remi 上给这个 agent 配置的技能，en 用 Skills，ja「スキル」，ko「스킬」），见 [ADR 0025](../../../../docs/adr/0025-chat-slash-commands.md)。菜单文案在 `editor.slash_command`；输入框下方被拦截命令的提示和排队说明在 `chat.input`（`blocked_command`、`command_queues`），排队沿用上文「排队」的用词。

新增文案时同步维护各语言的键和插值占位符，验证入口为 [parity.test.ts](parity.test.ts)。开发规则见[前端 AGENTS.md](../../../AGENTS.md)，运行命令见[前端验证入口](../../../../docs/dev/frontend.md#验证入口)。
