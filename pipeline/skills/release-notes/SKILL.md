---
name: release-notes
description: 版本发布总结 — 汇总当前 release 分支包含的所有 Mission 变更，生成 release notes，写入 PR 描述并推送到群。发布版本时自动触发。
---

# 版本发布总结 Skill

## 目标

在版本发布时，自动汇总当前 release 分支包含的所有 Mission 变更，生成结构化的 release notes，用于 PR 描述和群通知。

## 触发条件

- Dashboard 点击"发布版本"按钮时触发
- 也可手动触发（用户说"生成 release notes"）

## 输入

- ProjectConfig.pipeline.releaseBranch（当前 release 分支名）
- 所有 target 为当前 releaseBranch 的已完成 Mission（状态为 done）
- 每个 Mission 的 `.missions/{missionId}/` 下的产物：
  - `description.md` — 功能描述
  - `contract.json` — 验收结果
  - `summary.md` — 执行总结（如果有）

## 执行流程

### 阶段一：收集 Mission 数据

1. 查询 DB 中所有合入当前 releaseBranch 的已完成 Mission
2. 对每个 Mission：
   - 读取 `description.md` 提取一句话功能描述
   - 读取 MR 编号和标题
   - 读取 contract 通过率
   - 分类：新功能（feat）/ 修复（fix）/ 优化（improve）/ 其他

### 阶段二：生成 Release Notes

3. 按分类组织变更列表
4. 生成 release notes，格式如下

### 阶段三：输出

5. 将 release notes 写入 PR 描述（作为 release → main 的 PR body）
6. 版本确认合入后，将 release notes 推送到 ProjectConfig.notifications 配置的目标群

## 产出格式

### Release Notes（Markdown）

```markdown
# {项目名} {version} Release Notes

## 新功能
- **{Mission 标题}**: {一句话功能描述} (#{MR编号})
- **{Mission 标题}**: {一句话功能描述} (#{MR编号})

## 修复
- **{Mission 标题}**: {一句话问题描述} (#{MR编号})

## 优化
- **{Mission 标题}**: {一句话优化描述} (#{MR编号})

---
📊 本版本统计:
- 共 {count} 个 Mission
- Contract 通过率: {rate}%
- 涉及 {files} 个文件变更
```

### 飞书通知（卡片消息）

```
🚀 {项目名} {version} 已发布

✨ 新功能:
  • {Mission 标题} (#{MR编号})
  • {Mission 标题} (#{MR编号})

🐛 修复:
  • {Mission 标题} (#{MR编号})

📊 统计: {count} 个 Mission | Contract 通过率 {rate}%
```

## 配置依赖

推送通知受 `ProjectConfig.notifications` 控制。release notes 推送到所有启用了 `missionProgress` 的目标群。

## 约束

- 只汇总合入当前 releaseBranch 的 Mission，不包含之前版本的
- 功能描述从 description.md 提取，保持一句话精简
- 分类（feat/fix/improve）优先从 Mission 的 commit message 前缀推断，无法推断则归为"其他"
- 如果没有任何 Mission 变更，生成空 release notes 并标注"无功能变更"
