---
name: mission-summary
description: Mission 完成总结 — 分析已完成 Mission 的全流程，提取经验教训，迭代项目级 skill。Mission 流转到 done 时自动触发。
---

# Mission 完成总结 Skill

## 目标

分析已完成的 Mission，提取经验教训并推动 skill 质量迭代。

## 触发时机

Mission 流转到 `done` 时触发（不是每日定时）。每个 mission 完成后立刻评估。

## 数据源

1. Git 分支 diff（整个分支 vs main）
2. MR diff 和 review comments（`gh pr view --comments`）
3. 飞书话题聊天记录（mission 话题中的对话流）
4. Contract 评估结果（eval-report.md）
5. review-summary.md（所有轮次的 review 反馈）

## 执行流程

### 阶段一：收集数据

1. 读取 `.missions/{missionId}/` 下所有阶段产出
2. 读取 git log 和 MR 信息

### 阶段二：分析

3. 对比 RFC 与最终实现 — 识别差距
4. 分析 review comments — 按反馈类型分类：
   - 代码质量问题
   - 边界场景遗漏
   - 架构设计问题
   - 性能问题
5. 检查 Contract eval 结果 — 哪些 Case 失败了，为什么
6. 读取 review-summary.md — 统计被打回次数和主要原因

### 阶段三：统计指标

7. 计算关键指标：
   - **intake 轮次**: 提问了几批才澄清需求
   - **RFC → MR 总耗时**: 从审批到 MR 创建的时间
   - **execute retry 次数**: 执行阶段重试了几次
   - **contract 通过率**: 首次 eval 的通过率
   - **review 轮次**: 几次 review 才最终通过

### 阶段四：Skill 迭代

8. 从 review 反馈中提取改进模式
9. 写入 `skill_feedbacks` 表，供 Skill Creator 消费
10. 如果发现重复问题（连续 3 个 mission 出现相同类型的 review 反馈），标记为"需要更新 skill"并生成具体改进建议

### 阶段五：跨 mission 模式识别

11. 查询近期 missions 的 skill_feedbacks，识别跨 mission 的共性问题
12. 如果某个 skill 的同类问题重复出现，生成项目级 skill 改进提案

## 产出

- `summary.md` → `.missions/{missionId}/summary.md`
  - 做得好的部分
  - 可以改进的部分
  - 具体的 skill 改进建议
  - 关键指标数据
- 更新 `skill_feedbacks` 表
- 在飞书话题发送总结摘要

## 约束

- 具体化 — 引用 file:line 说明代码问题
- 聚焦可执行的改进，不给泛泛的建议
- 指标要精确，不要估算
