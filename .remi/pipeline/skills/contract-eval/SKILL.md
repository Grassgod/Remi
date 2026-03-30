---
name: contract-eval
description: Contract 验收评估 — 验证实现是否满足用户提交的验收标准。BunQueue 独立 agent，上下文隔离，只读 contract 和需求文档。用于评估交付物是否符合 Contract Case。
---

# Contract 验收评估 Skill

## 目标

验证 Mission 的实现是否满足所有用户提交的 Contract Case。

## 上下文隔离

此 skill 运行在 BunQueue 独立 agent 中。agent 上下文仅包含：
- `contract.json`（验收用例）
- `description.md`（需求描述）
- 项目代码仓库访问权（用于跑测试）

**不包含**：RFC.md、tasks.md、execute 对话记录。
目的：避免评估被实现过程的上下文污染，确保独立客观判断。

## 基座

无需调用 superpowers — 这是一个纯验证 skill，按 Case 逐个执行测试并比较结果。

## 触发条件

- Execute 阶段完成后，BunQueue 自动触发
- MR 创建/更新后

## 输入

从 `.missions/{missionId}/` 读取：
- `contract.json` — 验收用例
- `description.md` — 需求描述

从项目代码仓库：
- 执行分支上的代码（用于运行测试）

## 执行流程

1. 读取 contract.json
2. 对每个 Case：
   a. 根据输入构造测试场景
   b. 执行测试
   c. 将实际输出与 expectedOutput 比较
   d. 如果 Case 涉及飞书文档链接：使用 lark_fetch 对比
   e. 如果 Case 涉及截图：使用视觉对比
   f. 记录通过/失败及详细信息
3. 运行项目测试套件（test, lint, build）
4. 生成 eval-report.md
5. 更新 contract.json 中的 verificationResults

## 判定

- 全部通过 → Mission 进入 `in_review`
- 任一失败 → Mission 回到 `execute` 重试

## 产出

### 宣告验收结果（必须）

验证完成后，**必须**通过 Bash 执行以下命令宣告结果：

通过时：
```bash
echo "PASS" > {outputDir}/eval-verdict
```

未通过时：
```bash
echo "FAIL" > {outputDir}/eval-verdict
```

**这是唯一的结果判定方式。** Pipeline 只读 `eval-verdict` 文件内容来决定下一步。不写此文件 = 视为失败。

### 其他产出

- `eval-report.md` → `.missions/{missionId}/eval-report.md`
- 更新后的 `contract.json`（含 verificationResults）
- 在飞书话题发送评测报告摘要

## 约束

- 评估期间不修改生产代码
- 报告所有失败，不在第一个失败处停止
- 保持客观 — 不读实现过程的上下文，只看输入输出
