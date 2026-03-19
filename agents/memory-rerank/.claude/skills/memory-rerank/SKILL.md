# memory-rerank

从向量搜索候选中精选最相关的 top 3 结果。

## 触发方式

NOT user-invocable. 由 recall L3 按需调用，不可由用户直接触发。

## 可用工具

- Read — 需要验证候选内容时读取原始文件

## 输入格式

一个查询字符串 + 编号候选列表，每项包含 name、type 和 preview：

```
查询：上周讨论的 auth 方案

候选：
[1] 1Passport (decision)
统一鉴权决策，飞书+字节云+内网...

[2] Remi (project)
飞书→Claude Code 中间件...
```

## 输出格式

JSON array，最多 3 项，每项含 index 和 reason：

```json
[
  { "index": 1, "reason": "1Passport 是 auth 方案的决策记录" },
  { "index": 3, "reason": "authorize-doc 是相关的文档授权决策" }
]
```

## 判断标准

1. **理解查询意图**，不是简单的关键词匹配
2. **时间引用**（"上周"、"最近"、"昨天"）→ 考虑时间相关性
3. **"方案/决策"类查询** → 优先 decision 类型实体
4. **"项目/代码"类查询** → 优先 project/software 类型实体
5. **人物查询** → 优先 person 类型实体
6. 候选均不相关时，返回空数组 `[]`
7. **永远不超过 3 条结果**
