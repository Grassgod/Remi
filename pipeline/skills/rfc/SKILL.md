---
name: rfc
description: 技术方案生成 — 分析项目代码库，产出 RFC 技术提案。Mission 审批通过后由 BunQueue 自动触发。与 decompose 共享同一个 agent session。完全自动化，无用户交互。
---

# RFC 技术方案 Skill

## 目标

分析项目代码库，产出将需求映射到具体实现方案的技术提案（RFC）。此 skill 与 Decompose 共享同一个 BunQueue 阶段 — RFC 完成后，Decompose 在同一个 agent session 中继续执行，复用代码库理解。

## 基座

1. 调用 `superpowers:using-git-worktrees` — 在任何探索之前创建隔离工作区
2. 调用 `superpowers:writing-plans` — 使用其代码分析和方案设计方法论

## 自动模式

此阶段完全自动化。**禁止使用 AskUserQuestion。** 所有必要信息已在 Intake 阶段收集。如果确实存在歧义，选择更安全/更简单的方案，并在 RFC 中记录假设。

## 触发条件

- Owner 批准 Mission（状态: approved）
- BunQueue 启动 RFC+Decompose 阶段

## 输入

从 `.missions/{missionId}/` 读取：
- `description.md` — Intake 阶段的结构化需求
- `contract.json` — Contract Case

## 执行流程

### 阶段一：代码库探索

1. 阅读项目结构：关键目录、入口文件、配置文件
2. 识别相关的现有代码：
   - 需要修改的文件/模块
   - 需要扩展的接口/类型
   - 覆盖受影响区域的测试
3. 记录项目中已使用的模式和约定

### 阶段二：方案设计

4. 确定实现方案：
   - 新增 vs 修改
   - 数据模型变更（如有）
   - API/接口变更（如有）
   - 需要的依赖（如有）
5. 对于非简单变更，至少评估一个替代方案及其权衡
6. 将每个 Contract Case 映射到具体设计决策 — 如果某个 Case 无法满足，明确标记

### 阶段三：撰写 RFC

7. 按以下格式生成 `RFC.md`

## 产出格式

### RFC.md

```markdown
# RFC: {Mission 标题}

## 摘要
{一段话：此 RFC 提出什么方案}

## 动机
{链接回 description.md 中的需求}

## 设计

### 实现方案
{详细的实现方案}

### 变更文件
| 文件 | 变更内容 |
|------|---------|
| path/to/file.ts | {具体变更} |

### 数据模型变更
{新类型、Schema 变更 — 没有则省略此节}

### API 变更
{新增/修改的端点或接口 — 没有则省略此节}

## 替代方案
{至少一个替代方案及权衡分析 — 简单变更写"N/A — 直接明了的变更"}

## 风险
{已知风险、未知点 — 简单变更写"低风险"}

## Contract 对齐
| Case | 设计决策 |
|------|---------|
| case-1 | {此设计如何满足此 Case} |
```

## 产出位置

- 将 `RFC.md` 写入 `.missions/{missionId}/RFC.md`
- 在飞书话题发送 RFC 摘要
- 可选：创建飞书文档（lark_render）并在话题中链接

## 约束

- 此阶段不写实现代码
- 每个 Contract Case 必须出现在 Contract 对齐表中
- 如果变更很简单（< 50 行，单文件），保持 RFC 精简并标记可能跳步
- 不退出 agent session — Decompose 在同一个 session 中继续

## 退出条件

RFC 完成 → 立即进入 Decompose skill（同一个 agent，同一个 worktree）。
