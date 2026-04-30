# Mission Board — 需求文档 (PRD)

> **项目代号**: Mission Board
> **版本**: v0.1 Draft
> **作者**: Jack (贺华杰) / Remi
> **日期**: 2026-03-23
> **试点项目**: LarkParser TS ([GitHub](https://github.com/Grassgod/LarkParser))

---

## 1. 产品定位

Mission Board 是 Remi 的**需求管理与自动化执行看板**。

它将飞书话题作为交互界面，Web 看板作为全局视图，实现从需求提交到代码合入的全流程自动化。核心理念：**用户在飞书里完成所有交互，看板提供全局进度感知。**

### 1.1 一句话描述

> 一个按 Project 组织的 Mission 看板，每个 Mission = 一个飞书话题 = 一条从需求到交付的自动化流水线。

### 1.2 核心价值

| 角色 | 价值 |
|------|------|
| **Jack (Owner)** | 一眼看到所有项目的 Mission 进度，早上看全局、晚上做评审，两个卡点之间全自动 |
| **用户 (需求方)** | 在飞书群里提需求，被引导补全细节，全程在话题里跟进进度 |
| **Remi (Agent)** | 有结构化的执行流水线，每一步有明确的 Skill 驱动，产出可验证 |

---

## 2. 用户与场景

### 2.1 用户角色

| 角色 | 说明 |
|------|------|
| **Owner (Jack)** | 唯一审批人，负责需求审批和最终验收 |
| **User (需求方)** | 任何在项目群里提需求的人，通过飞书交互 |
| **Viewer (访客)** | 看板公开可见，任何人可查看项目进度（未来可加同意环节） |

### 2.2 核心场景

**场景 A — 每日晨检**
Jack 早上打开看板，按 Project 切换，扫一眼：
- Inbox 里有 3 个新需求待审批
- In Progress 有 2 个正在执行
- In Review 有 1 个等验收
点击卡片可展开查看飞书话题的完整对话流。

**场景 B — 需求评审**
晚上 Jack 逐个 Review Inbox 里的 Mission：
- 点击卡片，查看需求详情和 Contract（验收 Case）
- 合理的 → 点"批准"→ 自动进入流水线
- 不合理的 → 点"驳回"→ 飞书话题里通知用户

**场景 C — 用户提需求**
用户在 LarkParser 项目群里说"我想要 xxx 功能"：
- Remi 自动在群里创建一个新话题
- 通过需求澄清 Skill 反复追问，补全需求细节
- 引导用户提交可验证的 Case（Contract Engineering）
- 完成后 Mission 进入 Inbox 等待审批

**场景 D — 自动化执行**
Mission 审批通过后，流水线自动推进：
- RFC → Task 拆解 → 编码 → 测试 → MR
- 每一步的产出都在飞书话题里发出
- 遇到 MR 卡点等待人工合并
- MR 合入后自动标记 Done

---

## 3. Mission 数据模型

### 3.1 Mission 定义

**一个 Mission = 一个飞书话题 = 一条流水线实例**

```typescript
interface Mission {
  id: string;                    // 唯一 ID
  title: string;                 // 标题
  description: string;           // 需求描述
  status: MissionStatus;         // 当前状态
  projectId: string;             // 所属 Project

  // 飞书关联
  chatId: string;                // 项目群 ID
  threadId: string;              // 话题 ID (root_id)

  // 流水线
  currentStep: PipelineStep;     // 当前步骤
  contract?: Contract;           // 交付协议
  mrUrl?: string;                // MR 链接
  mrStatus?: 'open' | 'merged' | 'closed';

  // 元数据
  createdBy: string;             // 需求提交人 (飞书 open_id)
  createdAt: string;             // 创建时间
  updatedAt: string;             // 最后更新
  completedAt?: string;          // 完成时间

  // 统计
  totalTokens?: number;          // 累计 token
  totalCost?: number;            // 累计成本
  totalDuration?: number;        // 累计耗时
}
```

### 3.2 状态流

```
                    ┌──────────┐
                    │  Inbox   │ ← 需求澄清完成，等待审批
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │ Approved │          │ Rejected │ → 终态，通知用户
        └────┬─────┘          └──────────┘
             │
             ▼
        ┌──────────┐
        │In Progress│ ← RFC → Task 拆解 → 编码 → 测试
        └────┬─────┘
             │          ▲
             │          │ Review 反馈 (带意见回到执行)
             ▼          │
        ┌──────────┐    │
        │In Review │────┘ ← 执行完成，等待验收
        └────┬─────┘
             │
             ▼
        ┌──────────┐
        │   Done   │ ← MR 合入 / 验收通过
        └──────────┘

        ┌──────────┐
        │ Blocked  │ ← 任何阶段遇到阻塞，需人工介入
        └──────────┘
```

**状态枚举**:
```typescript
type MissionStatus =
  | 'inbox'        // 待审批
  | 'approved'     // 已批准，排队执行
  | 'in_progress'  // 执行中
  | 'in_review'    // 待验收
  | 'done'         // 完成
  | 'rejected'     // 驳回
  | 'blocked';     // 阻塞
```

### 3.3 Project 定义

**一个 Project = 一个看板 = 一个飞书群 = 一个代码仓库**

```typescript
interface Project {
  id: string;
  name: string;                  // 显示名称 (如 "LarkParser TS")
  chatId: string;                // 飞书项目群 ID
  repoUrl: string;               // GitHub 仓库地址
  cwd: string;                   // 本地代码路径
  pipelineConfig?: PipelineConfig; // 流水线配置 (可选)
}
```

### 3.4 Contract (交付协议)

```typescript
interface Contract {
  cases: ContractCase[];         // 用户提交的验证 Case
  acceptanceCriteria: string[];  // 验收标准 (从 Case 推导)
  verificationResults?: {        // 验证结果
    caseResults: { caseId: string; passed: boolean; detail: string }[];
    overallPassed: boolean;
    verifiedAt: string;
  };
}

interface ContractCase {
  id: string;
  description: string;          // Case 描述
  input: string;                // 输入
  expectedOutput: string;       // 期望输出
  type: 'unit' | 'integration' | 'e2e'; // Case 类型
}
```

---

## 4. 执行流水线

### 4.1 六步流水线

每个 Mission 审批通过后，按以下步骤自动执行。每一步由专属 Skill 驱动，产出在飞书话题中发出。

```
Step 1: 需求澄清 (intake)
  ├─ 触发: 用户在项目群提需求 / 看板新建 Mission
  ├─ Skill: intake-skill
  ├─ 行为: 多轮追问，补全需求细节，引导提交验证 Case
  ├─ 产出: 结构化需求描述 + Contract
  └─ 出口: Mission 进入 Inbox，等待 Owner 审批

Step 2: RFC / Proposal
  ├─ 触发: Owner 批准 Mission
  ├─ Skill: rfc-skill
  ├─ 行为: 分析 codebase，输出技术方案
  ├─ 产出: 完整 RFC 全文发到话题 + 飞书文档链接
  └─ 出口: 自动进入 Step 3 (或等 Owner 确认方案)

Step 3: Task 拆解
  ├─ 触发: RFC 完成
  ├─ Skill: decompose-skill
  ├─ 行为: 将 RFC 拆成 Claude Code 可执行的 Task 列表
  ├─ 产出: Task checklist (Claude Code TodoWrite 粒度)
  └─ 出口: 自动进入 Step 4

Step 4: 执行
  ├─ 触发: Task 列表就绪
  ├─ Skill: execute-skill
  ├─ 行为: 逐个执行 Task，编码、测试、提交
  ├─ 产出: 代码变更 + MR
  ├─ 卡点: MR 必须人工合并
  └─ 出口: MR 创建后进入 Step 5

Step 5: 自动化评测
  ├─ 触发: 代码提交 / MR 创建
  ├─ Skill: eval-skill
  ├─ 行为:
  │   (a) 执行 Contract 中的每个 Case → 单项验收
  │   (b) 执行整个 Contract → 整体验收
  │   (c) 跑项目已有测试套件 (lint, test, build)
  ├─ 产出: 评测报告发到话题
  └─ 出口: 全部通过 → In Review; 未通过 → 回到 Step 4

Step 6: 总结
  ├─ 触发: Mission 标记 Done (MR 合入)
  ├─ Skill: summary-skill
  ├─ 行为:
  │   (a) 记录本次执行经验
  │   (b) 提取 Skill 优化素材 (被驳回原因、Review 反馈)
  │   (c) 更新项目知识库
  ├─ 产出: 执行总结发到话题
  └─ 出口: Mission 归档
```

### 4.2 流水线配置

不同项目可配置不同的流水线行为：

```typescript
interface PipelineConfig {
  // 步骤跳过控制
  skipRfc?: boolean;             // 小改动可跳过 RFC
  skipDecompose?: boolean;       // 单任务不需要拆解
  autoApproveRfc?: boolean;      // RFC 自动通过不等确认

  // MR 配置
  mrRequired: boolean;           // 是否必须有 MR (默认 true)
  autoMerge?: boolean;           // MR 自动合并 (默认 false, 建议保持)

  // 评测配置
  testCommand?: string;          // 测试命令 (如 "bun test")
  lintCommand?: string;          // lint 命令
  buildCommand?: string;         // 构建命令
}
```

### 4.3 智能跳步

系统根据 Mission 复杂度自动判断是否跳过某些步骤：
- **简单 Bug Fix**: 跳过 RFC + Task 拆解，直接执行
- **小功能**: 跳过 Task 拆解
- **大功能**: 完整流水线

判断依据：需求描述长度、涉及文件数、历史类似 Mission 的步骤耗时。

---

## 5. 飞书集成

### 5.1 话题生命周期

```
用户在项目群发消息: "我想要 xxx"
  │
  ▼
Remi 创建新话题 (标题 = Mission 标题)
  │
  ▼
在话题中同步用户原始需求内容
  │
  ▼
Intake Skill 在话题中与用户多轮交互
  │
  ▼
需求澄清完成 → Mission 进入 Inbox
  │
  ▼
Owner 审批 (看板操作 or 飞书操作)
  │
  ▼
流水线各步骤的产出均在话题中发出:
  ├─ RFC 全文 + 飞书文档链接
  ├─ Task 列表
  ├─ 执行进度
  ├─ 评测报告
  └─ 总结
```

### 5.2 双向同步

| 操作位置 | 动作 | 同步效果 |
|----------|------|----------|
| 看板 | 点击"批准" | 飞书话题发消息通知用户 |
| 看板 | 点击"驳回" | 飞书话题发驳回原因 |
| 看板 | 拖拽卡片改状态 | 飞书话题发状态变更通知 |
| 飞书 | 用户在话题中回复 | 看板卡片更新最新消息预览 |
| 飞书 | Owner 在话题中说"通过" | 看板状态自动变更 |
| GitHub | MR 合入 | 看板 Mission 自动标记 Done |

### 5.3 消息渲染

看板中展开卡片显示的对话流，需渲染以下类型：
- 纯文本消息
- Markdown (代码块、表格、列表)
- 飞书卡片 (Remi 的回复卡片)
- 折叠区域 (thinking 内容)
- 图片
- 文件附件

---

## 6. Contract Engineering

### 6.1 流程

```
用户提需求
  │
  ▼
Intake Skill 追问细节
  │
  ▼
引导用户提交验证 Case:
  "请描述一个具体的使用场景，包括输入和期望输出"
  │
  ▼
用户提供 Case (可多个):
  Case 1: 输入 A → 期望输出 B
  Case 2: 输入 C → 期望输出 D
  │
  ▼
系统生成 Contract:
  ├─ 用户提交的 Case → 验收用例
  ├─ 推导验收标准
  └─ 形成交付协议
  │
  ▼
Contract 随 Mission 一起进入审批
  │
  ▼
执行阶段: Agent 以 Contract 为目标编码
  │
  ▼
评测阶段:
  (a) 逐个跑 Case → 单项通过/失败
  (b) 整体 Contract 验收 → 全部通过才算完成
```

### 6.2 Contract 在话题中的呈现

```
📋 交付协议 (Contract)

验收用例:
  ✅ Case 1: 传入 wiki 链接 → 返回 Markdown (输入/输出已确认)
  ✅ Case 2: 传入 sheet 链接 → 返回表格 Markdown
  ⬜ Case 3: 传入无权限链接 → 返回友好错误提示

验收标准:
  - 所有 Case 通过
  - 现有测试不被破坏
  - lint 和 build 通过
```

---

## 7. Skill 自动优化

### 7.1 优化闭环

```
每日凌晨 4:00 Cron Job
  │
  ▼
收集前一天的反馈数据:
  ├─ 被 Owner 驳回的 Mission (驳回原因)
  ├─ 反复 Review 的 Mission (Review 次数 + 反馈意见)
  ├─ Contract 验证失败的 Case (失败原因)
  └─ 执行耗时异常的步骤
  │
  ▼
使用 Skill Creator 分析反馈:
  ├─ "需求澄清不够深入" → 优化 intake-skill 的追问逻辑
  ├─ "代码没考虑边界条件" → 优化 execute-skill 的 prompt
  ├─ "RFC 缺少性能分析" → 优化 rfc-skill 的模板
  └─ 产出 Skill 变更建议
  │
  ▼
自动应用优化 (Skill Creator 的 bounded 行为)
  │
  ▼
记录优化日志，供 Owner 查看
```

### 7.2 反馈数据存储

```typescript
interface SkillFeedback {
  missionId: string;
  step: PipelineStep;
  skillName: string;
  feedbackType: 'rejected' | 'review_revision' | 'contract_fail' | 'timeout';
  detail: string;                // 具体反馈内容
  createdAt: string;
}
```

---

## 8. 看板前端

### 8.1 页面结构

```
┌─────────────────────────────────────────────────────────┐
│  Mission Board                          [LarkParser TS ▾] │ ← Project 选择器
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Inbox (3)  │ Approved (1) │ In Progress (2) │ In Review (1) │ Done (12) │
│             │              │                 │               │           │
│ ┌─────────┐ │ ┌──────────┐ │ ┌─────────────┐ │ ┌───────────┐ │           │
│ │ 支持     │ │ │ 优化     │ │ │ 重构解析器   │ │ │ 新增      │ │           │
│ │ minutes  │ │ │ 错误提示 │ │ │ ████░░ 60%  │ │ │ sheet支持 │ │           │
│ │ 格式     │ │ │          │ │ │ Step 4/6    │ │ │ 待验收    │ │           │
│ │          │ │ └──────────┘ │ │ $0.24       │ │ │ MR #47    │ │           │
│ │ by: 朱坤 │ │              │ └─────────────┘ │ └───────────┘ │           │
│ │ 2h ago   │ │              │                 │               │           │
│ └─────────┘ │              │ ┌─────────────┐ │               │           │
│ ┌─────────┐ │              │ │ 修复 auth   │ │               │           │
│ │ 增加     │ │              │ │ ██████░ 80% │ │               │           │
│ │ 批量API  │ │              │ │ Step 5/6    │ │               │           │
│ │          │ │              │ └─────────────┘ │               │           │
│ └─────────┘ │              │                 │               │           │
│             │              │                 │               │           │
└─────────────┴──────────────┴─────────────────┴───────────────┴───────────┘
```

### 8.2 卡片信息

每张卡片显示：
- **标题** — Mission 名称
- **提交人** — 飞书用户名
- **时间** — 创建时间 / 最后更新
- **进度** — 当前 Step (如 "Step 4/6 执行中")
- **成本** — 累计 token / 费用
- **MR 状态** — MR 链接 + open/merged 状态
- **最新消息预览** — 话题中最后一条消息的前 50 字

### 8.3 卡片展开 — 对话流视图

点击卡片展开全屏对话流，渲染飞书话题中的完整消息：

```
┌─────────────────────────────────────────────┐
│ ← 返回看板    重构解析器模块    🟢 In Progress │
├─────────────────────────────────────────────┤
│                                             │
│ 📋 Contract                                 │
│ ┌─────────────────────────────────────────┐ │
│ │ ✅ Case 1: wiki 链接 → Markdown         │ │
│ │ ⬜ Case 2: 嵌套文档 → 递归解析          │ │
│ │ ⬜ Case 3: 超大文档 → 分页处理          │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 👤 朱坤 · 3月22日 14:30                     │
│ 希望支持嵌套文档的递归解析，目前遇到...      │
│                                             │
│ 🤖 Remi · 3月22日 14:31                     │
│ 收到，我有几个问题需要确认：                  │
│ 1. 嵌套层级最深支持到几层？                  │
│ 2. 循环引用如何处理？                        │
│                                             │
│ 👤 朱坤 · 3月22日 14:35                     │
│ 最多 5 层，循环引用报错就行                   │
│                                             │
│ 🤖 Remi · 3月22日 15:00                     │
│ 📄 RFC: 嵌套文档递归解析方案                  │
│ ┌─ 完整 RFC 内容 ─────────────────────────┐ │
│ │ ## 背景                                 │ │
│ │ ## 方案设计                              │ │
│ │ ## 影响范围                              │ │
│ │ ...                                     │ │
│ └─────────────────────────────────────────┘ │
│ 🔗 飞书文档: https://xxx.feishu.cn/docx/xxx │
│                                             │
│ 🤖 Remi · 3月22日 15:05                     │
│ ⚡ 开始执行...                               │
│ ┌─ 🔍 Thinking (折叠) ─────────────────┐   │
│ └───────────────────────────────────────┘   │
│ Task 1/3: 添加递归解析器 ✅                  │
│ Task 2/3: 循环检测 ✅                        │
│ Task 3/3: 分页处理 🔄 进行中                 │
│                                             │
└─────────────────────────────────────────────┘
```

### 8.4 看板操作

| 操作 | 触发方式 | 效果 |
|------|----------|------|
| 批准 Mission | Inbox 卡片上的"批准"按钮 | 状态 → Approved，飞书通知 |
| 驳回 Mission | Inbox 卡片上的"驳回"按钮 + 输入原因 | 状态 → Rejected，飞书通知 |
| 改变状态 | 拖拽卡片到其他列 | 状态变更，飞书通知 |
| 查看详情 | 点击卡片 | 展开对话流视图 |
| 新建 Mission | 看板顶部"+"按钮 | 在项目群创建新话题 |
| 切换 Project | 顶部 Project 选择器 | 加载对应项目的看板 |

### 8.5 技术栈

| 层 | 选择 | 理由 |
|----|------|------|
| 框架 | React 19 + Vite | 轻量快速 |
| 拖拽 | dnd-kit | 10KB，零依赖 |
| UI | shadcn/ui + Tailwind | 统一 Remi 技术栈 |
| Markdown | react-markdown + rehype | GFM + 代码高亮 |
| 状态管理 | Zustand | 轻量，适合 WS |
| 实时通信 | WebSocket | Remi 后端直接广播 |

---

## 9. 后端 API

### 9.1 新增路由 (Remi Hono 后端)

```
# Mission CRUD
GET    /api/projects                    → 项目列表
GET    /api/projects/:id/missions       → 某项目的 Mission 列表 (看板数据)
GET    /api/missions/:id                → 单个 Mission 详情
POST   /api/missions                    → 新建 Mission
PATCH  /api/missions/:id                → 更新 Mission (改状态、改标题等)
POST   /api/missions/:id/approve        → 批准
POST   /api/missions/:id/reject         → 驳回 (body: reason)

# 对话消息
GET    /api/missions/:id/messages       → 拉取飞书话题消息 (代理飞书 API)

# Contract
GET    /api/missions/:id/contract       → 获取 Contract
PUT    /api/missions/:id/contract       → 更新 Contract

# 统计
GET    /api/projects/:id/stats          → 项目统计 (Mission 数、成本、耗时)

# WebSocket
WS     /ws/board                        → 实时推送 (Mission 状态变更、新消息)
```

### 9.2 数据存储

复用 `~/.remi/remi.db`，新增表：

```sql
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  project_id TEXT NOT NULL,

  -- 飞书关联
  chat_id TEXT NOT NULL,
  thread_id TEXT,

  -- 流水线
  current_step TEXT DEFAULT 'intake',
  contract TEXT,                    -- JSON
  mr_url TEXT,
  mr_status TEXT,

  -- 元数据
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,

  -- 统计
  total_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  total_duration INTEGER DEFAULT 0,

  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chat_id TEXT,                     -- 飞书项目群 ID
  repo_url TEXT,                    -- GitHub 仓库地址
  cwd TEXT,                         -- 本地代码路径
  pipeline_config TEXT,             -- JSON
  created_at TEXT NOT NULL
);

CREATE TABLE skill_feedbacks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  step TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  feedback_type TEXT NOT NULL,      -- rejected / review_revision / contract_fail / timeout
  detail TEXT,
  created_at TEXT NOT NULL,

  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE INDEX idx_missions_project ON missions(project_id);
CREATE INDEX idx_missions_status ON missions(status);
CREATE INDEX idx_feedbacks_skill ON skill_feedbacks(skill_name);
```

---

## 10. MR 状态感知

### 10.1 GitHub 集成

- **仓库**: `Grassgod/LarkParser`
- **感知方式**: GitHub Webhook (push / pull_request events) 或定时轮询 `gh api`
- **触发逻辑**:
  - MR 创建 → Mission 记录 `mr_url`
  - MR 合入 → Mission 状态 → Done，触发 Step 6 总结
  - MR 关闭 → Mission 状态 → Blocked

### 10.2 轮询方案 (MVP)

```typescript
// 每 5 分钟检查一次所有 open MR 的状态
cron('*/5 * * * *', async () => {
  const missions = await db.getMissionsWithOpenMR();
  for (const m of missions) {
    const status = await gh.getMRStatus(m.mrUrl);
    if (status === 'merged') {
      await updateMissionStatus(m.id, 'done');
      await triggerSummarySkill(m.id);
    }
  }
});
```

---

## 11. 实施计划

### Phase 0 — 基础设施 (1 周)

- [ ] 新建 LarkParser TS 飞书项目群
- [ ] 新增 `missions` / `projects` / `skill_feedbacks` 表
- [ ] Project 注册 (LarkParser TS 作为第一个)
- [ ] 后端 Mission CRUD API

### Phase 1 — 看板 MVP (1-2 周)

- [ ] React + Vite 项目搭建
- [ ] 看板视图 (dnd-kit 拖拽 + shadcn/ui 卡片)
- [ ] Project 切换
- [ ] 卡片基本信息展示
- [ ] 批准/驳回操作
- [ ] 内网端口访问

### Phase 2 — 飞书话题同步 (1 周)

- [ ] 话题自动创建 (用户提需求 → Remi 建话题)
- [ ] 消息拉取 + 渲染 (对话流视图)
- [ ] 看板操作 → 飞书通知
- [ ] WebSocket 实时推送

### Phase 3 — 流水线引擎 (2 周)

- [ ] Intake Skill (需求澄清 + Contract 收集)
- [ ] RFC Skill
- [ ] Execute Skill
- [ ] Eval Skill (Contract 验证)
- [ ] BunQueue 任务编排 (Step 链式触发)

### Phase 4 — 闭环 (1 周)

- [ ] MR 状态感知 (GitHub 轮询)
- [ ] Summary Skill
- [ ] Skill 自动优化 (凌晨 4:00 cron)
- [ ] 反馈数据收集与存储

---

## 12. 试点计划

**试点项目**: LarkParser TS
- **GitHub**: https://github.com/Grassgod/LarkParser
- **本地路径**: 待确认
- **飞书群**: 待新建

**试点目标**:
1. 验证完整的 Mission 生命周期 (从需求到 MR 合入)
2. 验证 Contract Engineering 的可行性
3. 收集第一批 Skill 优化反馈
4. 确认看板 + 飞书双向同步的体验

**成功标准**:
- 至少 5 个 Mission 走完完整流水线
- Contract 验证准确率 > 80%
- 用户无需离开飞书即可完成所有交互
- Owner 通过看板可在 30 秒内掌握项目全局状态

---

## 附录 A: 参考项目

| 项目 | 参考点 |
|------|--------|
| [Plane](https://github.com/makeplane/plane) (46.7k stars) | 看板 UI、多视图、Issue 状态流 |
| [Linear](https://linear.app) | 状态流设计、快捷操作 |
| [OpenSpec](https://github.com/openspec) | RFC 模板、结构化需求文档 |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | 拖拽实现 |
| [Mission Control](https://github.com/builderz-labs/mission-control) (2.8k stars) | Agent 看板、多 Agent 调度 |

## 附录 B: 名词表

| 术语 | 定义 |
|------|------|
| **Mission** | 最小需求单元，对应一个飞书话题和一条执行流水线 |
| **Project** | 项目，对应一个代码仓库、一个飞书群、一个看板 |
| **Contract** | 交付协议，由用户提交的验证 Case + 验收标准组成 |
| **Pipeline** | 六步流水线 (intake → rfc → decompose → execute → eval → summary) |
| **Skill** | 流水线每一步的执行单元，可被自动优化 |
| **Owner** | 审批人 (目前固定为 Jack) |
