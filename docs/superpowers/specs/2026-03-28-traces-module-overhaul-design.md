# Traces Module Overhaul — Design Spec

**Date:** 2026-03-28
**Branch:** dashboard-redesign
**Scope:** 全面改造 traces 页面为调试分析页

---

## 问题总结

当前 traces 页面展示的是假数据：
- 从 conversations 表硬造 trace spans，不是真实执行记录
- 统计卡片数字全错（前端基于截断的 50 条算）
- "UNSET" 状态标签用户看不懂
- Trace 详情列为空，没有真正的 trace 数据可绑定

真正的执行记录在 Claude Code 的 JSONL 文件里，但页面完全没读它。

---

## 改造方案

做三件事：

### 1. 列表 — 还是查 DB

DB 查询快，包含业务上下文（谁发的、哪个群、哪个 connector）。

**修改点：**
- 新增 `GET /api/v1/traces/stats?date=` 端点，后端 SQL 聚合 count/avg/p95/error_rate
- 统计排除 `status = 'processing'` 的记录（duration=0 拉低均值）
- 表格新增列：model、tokens（in+out）、cost
- "UNSET" 改显示为 "Processing"
- 新增日期选择器和状态筛选

**Stats API 返回：**
```json
{
  "total": 162,
  "processing": 13,
  "errors": 3,
  "errorRate": 2.01,
  "avgDurationMs": 12340,
  "p95DurationMs": 45200
}
```

### 2. 详情 — 点进去读 JSONL

点击某条 trace 后，后端根据 DB 记录找到 JSONL 文件，解析出这一轮实际做了什么。

**新增 `GET /api/v1/traces/:id/detail` 端点：**

后端流程：
1. 查 conversations 表拿 `cli_session_id` + `cli_round_start` + `cli_round_end`
2. `findSessionJsonl(cli_session_id)` 定位 JSONL 文件
3. 解析 JSONL，按 `[round_start, round_end]` 时间窗口切出这一轮的 events
4. 提取 tool_use / tool_result 配对，算出每个 tool call 的耗时

**返回结构：**
```typescript
{
  // 元数据（from DB）
  meta: {
    status: string,
    durationMs: number,
    model: string,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    connector: string,
    chatId: string,
    senderName: string
  },
  // 用户原始消息（from DB user_message 或 JSONL）
  userMessage: string,
  // Tool calls 链路（from JSONL）
  toolCalls: Array<{
    name: string,        // e.g. "Read", "Bash", "mcp__remi-memory__recall"
    input: object,       // tool input（截断到 500 字符）
    output: string,      // tool output（截断到 1000 字符）
    durationMs: number,  // tool_result.timestamp - tool_use.timestamp
    status: "ok" | "error"
  }>,
  // JSONL 是否可用
  jsonlAvailable: boolean,
  // Remi 处理步骤（from DB spans 列，作为补充）
  remiSpans: Array<{ op: string, ms: number }>
}
```

### 3. 关联方式

```
DB conversation record
  → cli_session_id (UUID)
    → ~/.claude/projects/<dir>/<sessionId>.jsonl
      → 按 [cli_round_start, cli_round_end] 时间窗口过滤
        → 这一轮的 tool calls
```

- `cli_session_id` 填充率：97.5%
- `cli_round_start/end` 填充率：98.4% / 94.7%
- 一个 JSONL 文件包含多轮对话（平均 12.6 轮），必须用时间窗口切分

---

## 前端改动

### Stats Cards（4 个）
- Total Traces — 真实总数（from stats API）
- Errors — 错误数 + 错误率
- Avg Duration — 后端算的均值（排除 processing）
- P95 Duration — 后端算的 P95

### 表格列
| 列 | 来源 | 说明 |
|----|------|------|
| Time | created_at | MM/DD HH:MM:SS |
| Status | status | OK / Error / Processing（替代 UNSET） |
| Duration | duration_ms | Xs 或 Xms |
| Model | model | e.g. claude-opus-4-6 |
| Tokens | input_tokens + output_tokens | 简写如 "1.2K / 3.4K" |
| Cost | cost_usd | $0.12 |

移除当前空的 "Operation" 和 "Spans" 列。

### 详情面板
点击表格行 → 下方展开详情面板（不是 overlay）：
- **顶部**：元数据卡片（status, duration, model, cost, connector）
- **中部**：Tool Calls 列表，每个 tool call 显示 name、耗时、状态
  - 可展开查看 input/output
- **底部**：Remi Spans（如果有的话，作为补充信息）
- **降级**：JSONL 不可用时显示提示，只展示 DB 数据

### 筛选
- 日期选择器（默认今天）
- 状态筛选（All / OK / Error / Processing）

---

## 降级策略

| 情况 | 行为 |
|------|------|
| JSONL 文件存在 | 展示完整 tool calls 链路 |
| JSONL 文件被删 | 显示"原始数据不可用"，只展示 DB 的 meta + remiSpans |
| cli_session_id 为 NULL | 同上 |
| cli_round_start/end 为 NULL | 无法切分，展示整个 session 的最近 N 条 events |

---

## 复用已有代码

| 模块 | 路径 | 用途 |
|------|------|------|
| `findSessionJsonl()` | src/conversation/parser.ts | 按 session ID 定位 JSONL 文件 |
| `parseSessionPairs()` | src/conversation/parser.ts | 解析 JSONL 为对话对（需扩展以提取 tool calls） |
| `rowToTraceData()` | src/tracing.ts | 保留用于降级场景 |
| Stats cards UI | web/frontend/src/pages/Traces.tsx | 保留组件结构，改数据源 |
| WaterfallChart | web/frontend/src/components/ | 暂时保留，后续可用于展示 tool call 时序 |

---

## 不做的事

- 不做 Flamegraph（方案 C 内容，过度设计）
- 不做时间轴热力图
- 不做 span 全文搜索
- 不做分页（单日 limit=200 足够）
- 不重新设计 DB schema（利用现有字段）
