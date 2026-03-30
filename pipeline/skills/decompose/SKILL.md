---
name: decompose
description: 任务拆解 — 将 RFC 拆成 TodoWrite 粒度的可执行任务列表。RFC 完成后在同一 agent session 中自动执行。完全自动化，无用户交互。
---

# 任务拆解 Skill

## 目标

将 RFC 拆解为有序的、具体的、可执行的任务列表。每个任务应足够小，能被单个 Claude Code agent 独立拾取、实现和提交。

## 基座

调用 `superpowers:writing-plans` 的任务拆解方法论。即使 RFC 阶段已调用过 writing-plans（同一 session），重新调用可以让拆解指导回到注意力焦点，也确保跳过 RFC 时能独立工作。此 skill 在其基础上增加：大小估算、依赖追踪和 tasks.md 输出格式。

## 自动模式

完全自动化。**禁止使用 AskUserQuestion。** RFC 和 Contract 提供了所有必要上下文。

## 触发条件

- RFC skill 完成（同一 agent session 继续）

## 输入

继承 RFC 阶段的上下文（同一 agent session）：
- `RFC.md` — 刚写完的技术方案
- `contract.json` — RFC 阶段已读取
- 代码库理解 — RFC 探索阶段已建立

## 执行流程

### 阶段一：识别工作单元

1. 从 RFC 中提取所有"变更文件"和设计决策
2. 将变更分组为逻辑工作单元：
   - 每个单元应可独立提交
   - 每个单元应有明确的完成条件
   - 优先小单元（1-3 个文件）

### 阶段二：排序与依赖

3. 确定执行顺序：
   - 数据模型/类型变更优先
   - 核心逻辑其次
   - 集成/连接第三
   - 测试伴随每个变更（TDD 风格）
4. 标记任务间的依赖关系

### 阶段三：估算与验证

5. 估算每个任务：
   - **S**（< 30 分钟）：单文件，直接明了
   - **M**（30-60 分钟）：2-3 个文件，需要一些决策
   - **L**（> 60 分钟）：考虑进一步拆分
6. 验证覆盖率：每个 RFC 设计点和每个 Contract Case 必须被至少一个任务覆盖

### 阶段四：撰写任务列表

7. 生成 `tasks.md`

## 产出格式

### tasks.md

```markdown
# 任务列表: {Mission 标题}

## 任务 1: {简短祈使句标题}
- **大小**: S / M / L
- **文件**: path/to/file1.ts, path/to/file2.ts
- **描述**: {做什么 — 祈使句、具体、自包含}
- **完成条件**: {可客观验证的条件}
- **依赖**: — (或 任务 N)

## 任务 2: {简短祈使句标题}
...

## 任务 N: 验证 Contract Case
- **大小**: S
- **文件**: tests/...
- **描述**: 运行 Contract 评估验证所有 Case 通过
- **完成条件**: 所有 Contract Case 通过，lint/test/build 绿灯
- **依赖**: 所有前序任务
```

每个任务描述必须自包含 — Execute agent 在没有 RFC 探索上下文的情况下读取 tasks.md，因此需包含足够细节可直接执行。

## 质量检查

每个任务必须包含：
- [ ] 清晰的祈使句标题（如"在 converter.ts 中添加 parseWiki 函数"）
- [ ] 具体文件列表
- [ ] 可客观验证的"完成条件"
- [ ] 大小估算
- [ ] 依赖信息

## 产出位置

- 将 `tasks.md` 写入 `.missions/{missionId}/tasks.md`
- 在飞书话题发送任务列表摘要

## 约束

- 不写实现代码
- 最后一个任务必须是"验证 Contract Case"
- 如果只需要 1 个任务，那就 1 个 — 不要凑数
- 如果某个任务是 L 级别，努力进一步拆分

## 退出条件

tasks.md 完成 → 当前 agent session 结束。BunQueue 启动新 agent 执行 Execute。
