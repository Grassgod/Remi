---
name: daily-changelog
description: 每日合入通知 — 汇总昨日所有 MR 合入情况，按 ProjectConfig 配置发送到目标群。每日凌晨 cron 触发。支持多群推送。
---

# 每日合入通知 Skill

## 目标

汇总昨日所有项目的 MR 合入情况，生成简洁的变更日报，发送到配置的目标群。

## 触发条件

- 每日凌晨 cron 任务
- 也可手动触发（用户说"发昨日合入通知"）

## 执行流程

### 阶段一：收集数据

1. 遍历所有项目
2. 对每个项目，查询昨日状态变为 `done` 的 missions
3. 对每个完成的 mission：
   - 读取 description.md 提取功能描述（一句话总结新增了什么）
   - 读取 git log（分支 diff 统计：commits 数、增删行数）
   - 读取 MR 标题、编号和目标分支（releaseBranch）
   - 读取 contract 通过率
   - 读取 RFC → MR 总耗时

### 阶段二：生成报告

4. 按项目分组汇总
5. 生成飞书卡片消息

### 阶段三：发送通知

6. 读取每个项目的 `ProjectConfig.notifications.dailyChangelog`
7. 如果 `enabled` 为 true，发送到 `targets` 列表中的每个群
8. 如果昨日无合入，不发送（可配置为发"昨日无合入"）

## 消息格式

飞书卡片：

```
📋 {项目名} 每日合入报告 — {日期}
🏷️ 当前版本: {releaseBranch}

✅ {Mission 标题}
   新增功能: {从 description.md 提取的一句话功能描述}
   MR: #{编号} → {releaseBranch} ({commits} commits, +{additions}/-{deletions})
   Contract: {passed}/{total} Cases 通过 | 耗时: {duration}

✅ {Mission 标题}
   修复: {从 description.md 提取的一句话描述}
   MR: #{编号} → {releaseBranch} ({commits} commits, +{additions}/-{deletions})
   Contract: {passed}/{total} Cases 通过 | 耗时: {duration}

总计: {count} 个 Mission 完成
```

## 配置依赖

此 skill 依赖 `ProjectConfig.notifications.dailyChangelog`：

```json
{
  "enabled": true,
  "targets": ["chatId_1", "chatId_2"]
}
```

- `enabled`: 是否启用每日通知
- `targets`: 接收通知的飞书群 chatId 列表，支持多群

## 约束

- 只汇总昨日（00:00 - 23:59）完成的 mission
- 如果项目无合入且未配置"发送空报告"，跳过该项目
- 消息格式保持简洁，关键信息一目了然
