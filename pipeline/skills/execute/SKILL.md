---
name: execute
description: 任务执行 — 逐个实现代码变更、跑测试、创建 MR。支持首次执行和 Review 后重跑两种模式。BunQueue 独立 agent，干净上下文。完全自动化，无用户交互。
---

# 任务执行 Skill

## 目标

逐个拾取任务并实现代码变更。此 skill 作为 BunQueue 启动的**独立 agent** 运行 — 以干净上下文启动，只读取所需的 mission 产物。独立 agent 的原因：RFC+Decompose 阶段积累了大量探索上下文，会挤占实现工作的空间并可能触碰上下文上限。

## 基座

1. 调用 `superpowers:using-git-worktrees` — 使用 RFC 阶段创建的 worktree（或不存在时创建新的）
2. 调用 `superpowers:executing-plans` — 遵循其逐步执行和检查点机制
3. 对每个任务调用 `superpowers:test-driven-development` — 先写失败测试再实现
4. 完成前调用 `superpowers:verification-before-completion` — 运行验证，不要只声称"完成了"

## 自动模式

完全自动化。**禁止使用 AskUserQuestion。** 如果任务描述不清晰，重新阅读 RFC.md 和 contract.json。如果仍有歧义，选择更安全的方案，在 commit 消息中记录假设，继续执行。

## 触发条件

- BunQueue 在 RFC+Decompose 完成后启动此 agent（模式 A）
- BunQueue 在 Review 反馈就绪后启动此 agent（模式 B）

## 模式检测

检查 `.missions/{missionId}/` 下的 `review-summary.md`：

```
if review-summary.md 存在且比上次执行更新:
  → 模式 B（Review 后重跑）
else:
  → 模式 A（首次执行）
```

## 输入

### 模式 A（首次执行）
从 `.missions/{missionId}/` 读取：
- `tasks.md` — 有序任务列表
- `RFC.md` — 技术方案供参考
- `contract.json` — Contract Case 用于最终验证

### 模式 B（Review 后重跑）
从 `.missions/{missionId}/` 读取：
- `tasks.md` — 原始任务列表（提供上下文）
- `RFC.md` — 技术方案（提供上下文）
- `contract.json` — Contract Case
- `review-summary.md` — 审查反馈及滚动状态

模式 B 中，`review-summary.md` 驱动需要变更的内容。先读它，再查阅 tasks.md 和 RFC.md 了解受影响区域的上下文。

### review-summary.md 格式（由 Review agent 维护）

单文件滚动更新 — 不论经历多少轮 review，Execute 永远只读这一个文件：

```markdown
# Review 摘要 — 第 {N} 轮

## 待解决
- { 本轮新反馈 + 上轮未解决项 }

## 已解决
- { 已确认修复的项 }
```

Review agent 负责跨轮维护此文件 — 将已修复项提升到"已解决"，未解决项保留在"待解决"。Execute 模式 B 只需解决"待解决"中的所有项。

## 执行流程

### 阶段零：准备

1. 进入 mission 的 worktree
2. 模式 A：从 ProjectConfig.pipeline.releaseBranch 创建功能分支 `mission/{missionId}`（如果 releaseBranch 为空，则从 main 创建）
3. 模式 B：检出已有分支，读 review-summary.md 了解需修复的内容
4. 将任务加载到 TodoWrite：
   - 模式 A：tasks.md 中的所有任务
   - 模式 B：从 review-summary.md "待解决"部分生成修复任务

### 阶段一：逐个执行任务（循环）

对每个任务按顺序执行：

5. 在 TodoWrite 中标记任务为 `in_progress`
6. 阅读任务描述和"完成条件"
7. 使用 TDD 实现：
   - 为期望行为编写一个失败测试
   - 实现变更使测试通过
   - 如需重构则重构
8. 运行相关测试 — 如果失败，调试修复后再继续
9. 验证"完成条件"已满足
10. 提交，附描述性消息：
    ```
    feat(mission): {任务标题}

    Mission: {missionId}
    Task: {taskNumber}/{totalTasks}
    ```
11. 在 TodoWrite 中标记任务为 `completed`
12. 在飞书话题发送进度：
    > "任务 {n}/{total} 完成: {任务标题}"

### 阶段二：最终验证

13. 运行完整项目测试套件（test, lint, build）
14. 验证所有 Contract Case 可被实现满足
15. 如有失败：
    - 诊断并修复
    - 重新运行验证
    - 每个任务最多 3 次重试，全部失败则设 mission 状态为 `blocked`

### 阶段三：创建/更新 MR

16. 推送分支到远程
17. 模式 A：通过 `gh pr create` 创建 MR
    - 目标分支：ProjectConfig.pipeline.releaseBranch（如果为空则为 main）
    - 标题：Mission 标题
    - 正文：需求摘要 + 任务列表 + contract 状态
18. 模式 B：推送修复 commit，更新 MR 描述说明变更内容
19. 在飞书话题发送 MR 链接

## 错误处理

- **测试失败**: 调试、修复、重跑（每个任务最多 3 次）
- **构建失败**: 修复，不跳过
- **任务不清晰**: 重读 RFC.md 和 contract.json；仍不清晰则选更安全的方案，在 commit 中记录
- **3 次重试后仍阻塞**: 设 mission 状态为 `blocked`，在飞书话题发送诊断信息

## 约束

- 一个任务一个 commit — 保持变更原子化和可审查
- 永远不 force-push 或改写 git 历史
- 永远不跳过失败的测试
- 不修改 tasks.md 范围外的文件，除非修复必须
- 模式 B 中，只关注 reviewer 标记的问题 — 不重构无关代码

## 退出条件

MR 创建/更新 → 当前 agent session 结束。BunQueue 进入 Contract Eval。
