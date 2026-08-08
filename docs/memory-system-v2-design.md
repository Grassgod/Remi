# 记忆系统 v2 设计文档

> **历史文档**:文中的 `src/memory/*` 现为 `packages/memory/src/*`。当前实现见 `CLAUDE.md` 的 Memory 段。

> 状态：草稿 v2.2（评审修订版）
> 作者：Jack Ho + Claude
> 日期：2026-02-19
> 范围：Remi 个人 AI 助手记忆系统重新设计

---

## 1. 动机

当前记忆系统（v1）存在以下局限：

- **仅支持项目级粒度** — 大型项目包含 N 个子服务时，单个 MEMORY.md 会积累过多知识，浪费 token
- **无实体记忆** — 没有结构化方式记住联系人、组织、决策
- **项目目录扁平** — `projects/{name}/MEMORY.md` 无法表示层级化的项目结构
- **无渐进式加载** — `read_with_ancestors()` 每层全量加载，无过滤
- **读写耦合** — 记忆写入在对话过程中同步发生，无异步维护

---

## 2. 设计决策

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 数据源 | **Markdown 文件**为唯一数据源，本期不引入知识图谱 |
| 2 | 实体目录结构 | **按 entityType 分目录**（people/、organizations/ 等） |
| 3 | 程序性记忆 | **不单独实现** — 在 memory.md 中使用 `## Procedures` 章节；该章节由维护 Agent **覆写**（而非追加），其余章节追加 |
| 4 | 上下文预算 | **不硬性限制** — 仅添加告警阈值；上下文超阈值时在 context 末尾注入提示让 agent 感知 |
| 5 | 知识图谱 | **推迟** — 本期纯文件系统 + frontmatter |
| 6 | Embedding 向量检索 | **推迟** — 本期使用全文/别名匹配 |
| 7 | 项目根目录发现 | **无隐式推断** — 用户通过 `remi init` 显式标记，最高层 `.remi/` 即为根 |
| 8 | 写入模式分类 | **Hot Path**（`remember`，对话中同步）+ **Background**（维护 Agent，对话后异步） |
| 9 | 项目记忆层级 | **两层为默认**（个人全局 + 项目根），模块层**按需扩展** — 模块知识积累到一定量时由用户手动 `remi init --child` 拆出；维护 Agent 默认只写两层 |

---

## 3. 架构概览

```
                    ┌──────────────────────────┐
                    │     Remi MemoryStore      │
                    │ (系统注入 + recall/remember)│
                    └─────────┬────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
     ┌────────────┐  ┌──────────────┐  ┌────────────────┐
     │   个人记忆   │  │   项目记忆    │  │   日志 (daily) │
     │  ~/.remi/   │  │  仓库内       │  │   ~/.remi/     │
     │  memory/    │  │  .remi/      │  │   memory/      │
     └────────────┘  └──────────────┘  └────────────────┘

              ┌────────────────────────────────────┐
              │         异步记忆写入（Background）    │
              │  Stop hook → 入队 → daemon 消费     │
              │  agent 审查 → patch 写入 .md        │
              └────────────────────────────────────┘
```

**记忆类型对照（CoALA 框架）**：

| 类型 | 说明 | v2 对应 |
|------|------|---------|
| Semantic（语义）| 知道"什么是什么"：事实、偏好、实体 | `entities/` + `memory.md` 非 Procedures 章节 |
| Episodic（情节）| 记得"发生过什么"：带时间戳的事件流水 | `daily/` 日志 |
| Procedural（程序性）| 知道"怎么做"：操作规程、工具用法 | `memory.md` 的 `## Procedures` 章节 |
| Working（工作）| 当下正在处理的内容 | 每次注入的 `<context>` |

---

## 4. 目录布局

### 4.1 个人记忆（`~/.remi/memory/`）

用户级知识，私有且跨项目。

```
~/.remi/memory/
├── MEMORY.md                      # 全局：用户偏好、核心事实
├── entities/
│   ├── people/
│   │   ├── Alice-Chen.md          # 联系人（文件名保留原始大小写）
│   │   └── Bob-Smith.md
│   ├── organizations/
│   │   ├── Acme-Corp.md
│   │   └── Manchester-Uni.md
│   └── decisions/
│       └── Hub-spoke-架构.md      # 跨项目决策
├── daily/
│   ├── 2026-02-17.md
│   └── 2026-02-18.md
└── .versions/                     # 时间戳备份，每个实体保留最近 10 个版本
```

### 4.2 项目记忆（仓库内 `.remi/`）

项目专属知识，和代码放在一起。

> **默认建议**：`.remi/` 加入 `.gitignore`。记忆内容通常包含个人上下文，不适合团队共享。如需团队共享项目知识，使用 `CLAUDE.md` 或 `README.md`。

**默认两层结构**（始终维护）：

```
~/Projects/remi/
├── .remi/
│   └── memory.md          # 项目唯一入口：架构、技术栈、约定、所有模块的 Procedures
└── src/
    └── ...                # 模块目录下默认不创建 .remi/
```

**按需扩展**（模块知识量大时手动拆出）：

当项目根 `memory.md` 中某个模块相关内容积累过多时，用户执行 `remi init --child` 将其拆为独立模块记忆：

```
~/Projects/remi/
├── .remi/
│   └── memory.md                  # 项目根：全局架构、跨模块约定
├── src/remi/memory/
│   └── .remi/
│       └── memory.md              # 拆出后的模块记忆（按需）
└── src/remi/engines/
    └── .remi/
        └── memory.md              # 拆出后的模块记忆（按需）
```

**拆出时机参考**：项目根 `memory.md` 超过 800 字符，且某模块相关内容占比超过 40%。

### 4.3 实体类型

`type` 是开放字符串，不是固定枚举。`remember` 遇到新 type 时自动创建对应目录。

**预置类型**（`remi init` 时创建目录）：

| type | 目录 | 说明 |
|------|------|------|
| person | `entities/people/` | 联系人、同事、合作者 |
| organization | `entities/organizations/` | 公司、大学、团队 |
| decision | `entities/decisions/` | 架构选择及其理由 |

**动态扩展**（agent 使用时自动创建）：

| type | 目录 | 示例 |
|------|------|------|
| concept | `entities/concepts/` | "知识图谱"、"RAG 架构" |
| event | `entities/events/` | "PyCon 2024" |
| tool | `entities/tools/` | "PaddleOCR"、"FastAPI" |
| ... | `entities/{type_plural}/` | 任意新类型 |

type → 目录名的映射规则：

```python
PLURAL_MAP = {"person": "people", "child": "children"}

def _type_to_dir(self, type_name: str) -> str:
    t = type_name.lower()
    if t in PLURAL_MAP:
        return PLURAL_MAP[t]
    return t + "s"
```

---

## 5. 记忆文件格式

### 5.1 实体文件（YAML frontmatter + Markdown 正文）

```markdown
---
type: person
name: Alice Chen                    # 原始显示名（必填，用于碰撞校验）
created: 2026-02-18T10:30:00+08:00
updated: 2026-02-18T14:22:00+08:00
tags: [colleague, cv-expert, acme]
source: user-explicit               # user-explicit | agent-inferred
summary: "Acme Corp 高级工程师，CV 专家"
aliases: [Alice, Alice S.]          # 参与 recall 检索
related: [Acme-Corp.md]             # 关联实体文件名
---

# Alice Chen

## 基本信息
- **角色：** Acme Corp 高级工程师
- **关系：** 同事，PyCon 2024 认识
- **时区：** PST (UTC-8)

## 专业领域
- 计算机视觉、文档理解
- PyTorch、ONNX 优化

## 沟通偏好
- 偏好 Slack，不爱用邮件
- 风格直接简洁

## 关键互动
- [2024-05-15] PyCon 上认识，讨论了 OCR pipeline
- [2024-09-10] 推荐尝试 Donut 模型

## 备注
- 在考虑离开 Acme 去创业公司
```

### 5.2 项目/模块记忆（纯 Markdown）

首行标题作为 Manifest 摘要。`## Procedures` 章节由维护 Agent **覆写**，其余章节**追加**。

```markdown
# Remi — Memory 模块：双层记忆系统，Markdown 为数据源

## 架构
- 双层设计：个人层 (~/.remi/) + 项目层 (仓库内 .remi/)
- Markdown 为数据源，暂无知识图谱
- 通过路径遍历实现渐进式加载

## 关键决策
- [2026-02-18] 选择 YAML frontmatter 作为实体文件格式
- [2026-02-18] 知识图谱推迟到后续阶段

## Procedures
- 跑测试：`pytest tests/test_memory.py -x`
- 记忆文件使用 UTF-8 编码
```

> **约定**：`.remi/memory.md` 的 `# 标题行` 同时作为 manifest 摘要，写入时确保标题简洁。

### 5.3 日志文件（仅追加）

```markdown
# 2026-02-18

- [10:30] [feishu] Jack: 讨论了记忆系统重设计
- [14:22] [feishu] Jack: 确认了 4 个设计决策
```

**日志保留策略**：
- 0–7 天：`daily/` 全文保留，Manifest 展示
- 8–30 天：Scheduler 每周压缩为 `daily/weekly-{YYYY-WNN}.md`，原文件删除
- 30 天以上：归档至 `daily/archive/`，不进 Manifest，`recall` 仍可访问

### 5.4 Frontmatter Schema

**必填字段**：

```yaml
---
type: string                         # 实体类型（person / organization / decision / ...）
name: string                         # 原始显示名，用于碰撞校验和 recall 精确匹配
created: ISO8601
updated: ISO8601
tags: [string]
source: user-explicit | agent-inferred
summary: string                      # 一行摘要，用于 Manifest 目录
---
```

**可选字段**：

```yaml
aliases: [string]     # 别名，参与 recall 检索
related: [string]     # 关联实体文件名
```

---

## 6. 上下文组装（Manifest/TOC 模式）

采用 **Manifest/TOC** 模式：只全文加载两端（全局 + 当前目录），中间层和实体走摘要目录，agent 用 `recall` 按需获取详情。零额外 LLM 调用。

### 6.1 加载策略

**默认两层场景**，`cwd = ~/Projects/remi/src/remi/memory/`，项目只有根层记忆：

```
全文加载（始终注入）：
  ✅ ~/.remi/memory/MEMORY.md              个人全局偏好
  ✅ remi/.remi/memory.md                  项目根记忆（唯一项目层文件）
  ✅ ~/.remi/memory/daily/2026-02-18.md    当日日志

Manifest 摘要：
  📋 entities/ 下所有实体（从内存索引读取）
  📋 日志入口
```

**已拆出模块层的场景**，`cwd = ~/Projects/remi/src/remi/memory/`，该目录有独立 `.remi/`：

```
全文加载（始终注入）：
  ✅ ~/.remi/memory/MEMORY.md              个人全局偏好
  ✅ src/remi/memory/.remi/memory.md       当前目录模块记忆（直接相关）
  ✅ ~/.remi/memory/daily/2026-02-18.md    当日日志

Manifest 摘要（recall 可查看全文）：
  📋 remi/.remi/memory.md                  项目根记忆（祖先）
  📋 src/remi/engines/.remi/memory.md      兄弟模块（如已拆出）
  📋 src/remi/connectors/.remi/memory.md   兄弟模块（如已拆出）
  📋 entities/ 下所有实体
  📋 日志入口
```

**规则**：
- 全文加载：当前目录有 `.remi/memory.md` 则加载该文件；否则加载项目根 `.remi/memory.md`（两者不重复）
- Manifest：项目内所有**其他** `.remi/memory.md` + 全部实体
- agent 通过 `recall` 按需获取任意一项的全文

### 6.2 组装格式

**默认两层示例**（项目只有根层记忆）：

```
<context>
# 个人记忆
[~/.remi/memory/MEMORY.md 全文]

---

# 项目记忆 (remi)
[remi/.remi/memory.md 全文]

---

# 当日日志
[daily 全文]

---

# 可用记忆（使用 recall 工具查看详情）
| 来源 | 路径/名称 | 摘要 |
|------|----------|------|
| 实体 | Alice Chen (person) | Acme Corp 高级工程师 |
| 实体 | Acme Corp (organization) | 合作公司 |
| 实体 | Hub-spoke 架构 (decision) | 2026-02 架构决策 |
| 日志 | daily/ | 最近 7 天可用，recall("日期或关键词") 查看 |
</context>
```

**已拆出模块层示例**（当前目录有独立 `.remi/`）：

```
<context>
# 个人记忆
[~/.remi/memory/MEMORY.md 全文]

---

# 当前模块记忆 (src/remi/memory)
[当前目录 .remi/memory.md 全文]

---

# 当日日志
[daily 全文]

---

# 可用记忆（使用 recall 工具查看详情）
| 来源 | 路径/名称 | 摘要 |
|------|----------|------|
| 项目记忆 | remi/.remi/memory.md | Hub-spoke 架构，Python 3.10+ |
| 模块记忆 | src/remi/engines/.remi/memory.md | Provider 抽象层 |
| 实体 | Alice Chen (person) | Acme Corp 高级工程师 |
| 实体 | Hub-spoke 架构 (decision) | 2026-02 架构决策 |
| 日志 | daily/ | 最近 7 天可用，recall("日期或关键词") 查看 |
</context>
```

```python
def _assemble(self, cwd: str | None) -> str:
    parts = []

    # 1. 个人全局记忆（始终注入）
    global_memory = self.root / "MEMORY.md"
    if global_memory.exists():
        parts.append(f"# 个人记忆\n{global_memory.read_text(encoding='utf-8')}")

    # 2. 项目记忆：当前目录有 .remi/memory.md 则全文加载；否则加载项目根
    project_root = self._project_root(cwd) if cwd else None
    current_memory = Path(cwd) / ".remi" / "memory.md" if cwd else None
    if current_memory and current_memory.exists():
        label = Path(cwd).name
        parts.append(f"# 当前模块记忆 ({label})\n{current_memory.read_text(encoding='utf-8')}")
    elif project_root:
        root_memory = project_root / ".remi" / "memory.md"
        if root_memory.exists():
            parts.append(f"# 项目记忆 ({project_root.name})\n{root_memory.read_text(encoding='utf-8')}")

    # 3. 当日日志
    today = date.today().isoformat()
    daily_file = self.root / "daily" / f"{today}.md"
    if daily_file.exists():
        parts.append(f"# 当日日志\n{daily_file.read_text(encoding='utf-8')}")

    # 4. Manifest
    manifest = self._build_manifest(cwd)
    if manifest:
        parts.append(manifest)

    return "\n\n---\n\n".join(parts)
```

上下文超过告警阈值时，在 context 末尾追加 agent 可见的提示：

```
⚠️ 当前上下文 {n} 字符（阈值：6000），建议用 recall 替代全文加载，或精简项目根 memory.md。
```

### 6.3 项目根目录发现

**规则**：向上扫描路径，找到**最高层**包含 `.remi/` 目录的路径即为项目根。没有隐式推断，用户通过 `remi init` 显式在某个目录创建 `.remi/`，任何目录都可以是根。

```python
def _project_root(self, cwd: str) -> Path | None:
    """向上扫描，保留最高层的 .remi/ 所在目录作为项目根。"""
    p = Path(cwd)
    root = None
    while p != p.parent:
        if (p / ".remi").is_dir():
            root = p          # 不加 is None 判断，持续更新，最终保留最高层
        p = p.parent
    return root
```

**典型场景**：

```
my-project/          ← remi init → 最高层有 .remi/，成为根
├── service-a/       ← remi init --child → 子节点
├── service-b/       ← remi init --child → 子节点
└── service-c/       ← remi init --child → 子节点
```

`remi init` 在当前目录创建 `.remi/memory.md`；`remi init --child` 同上，用于明确表示"这是子节点"（行为相同，仅语义区分）。

### 6.4 Manifest 生成逻辑

Manifest 从**内存索引**（`self._index`）读取实体摘要，不做磁盘扫描：

```python
def _build_manifest(self, cwd: str | None = None) -> str:
    """生成统一的摘要目录。实体从内存索引读取，项目记忆实时扫描。"""
    rows = []

    # 1. 项目内所有 .remi/memory.md（排除当前目录）
    project_root = self._project_root(cwd)
    current_memory = Path(cwd) / ".remi" / "memory.md" if cwd else None
    if project_root:
        for md_file in project_root.rglob(".remi/memory.md"):
            if md_file == current_memory:
                continue
            summary = self._read_first_line(md_file)
            rel = md_file.relative_to(project_root)
            source = "项目记忆" if md_file.parent.parent == project_root else "模块记忆"
            rows.append({"source": source, "name": str(rel), "summary": summary})

    # 2. 实体目录（从内存索引，O(1) 读取）
    for path_str, meta in self._index.items():
        rows.append({
            "source": "实体",
            "name": f"{meta['name']} ({meta['type']})",
            "summary": meta["summary"],
        })

    # 3. 日志入口
    daily_dir = self.root / "daily"
    if daily_dir.is_dir():
        days = sorted(daily_dir.glob("*.md"), reverse=True)
        if days:
            rows.append({
                "source": "日志",
                "name": "daily/",
                "summary": f"最近 {min(len(days), 7)} 天可用，recall(\"日期或关键词\") 查看",
            })

    if not rows:
        return ""
    header = "# 可用记忆（使用 recall 工具查看详情）\n\n"
    header += "| 来源 | 路径/名称 | 摘要 |\n|------|----------|------|\n"
    for r in rows:
        header += f"| {r['source']} | {r['name']} | {r['summary']} |\n"
    return header
```

### 6.5 告警阈值

```python
CONTEXT_WARN_THRESHOLD = 6000  # 字符数

def gather_context(self, cwd: str | None = None) -> str:
    self._ensure_initialized()
    context = self._assemble(cwd)
    if len(context) > CONTEXT_WARN_THRESHOLD:
        logger.warning("记忆上下文 %d 字符（阈值：%d）", len(context), CONTEXT_WARN_THRESHOLD)
        context += (
            f"\n\n⚠️ 当前上下文 {len(context)} 字符（阈值：{CONTEXT_WARN_THRESHOLD}），"
            "建议用 recall 替代全文加载，或精简 MEMORY.md 的 ## 近期焦点 章节。"
        )
    return context
```

### 6.6 渐进增强路径

```
现阶段：Manifest/TOC — 内存索引 + recall 按需加载
    ↓
实体 > 100：对 manifest 实体列表按 embedding 相关性排序，只展示 top-N
    ↓
实体 > 500：Sub-agent 预检索，或切换到 MemGPT 式 self-directed
```

---

## 7. Agent 感知

### 7.1 System Prompt

```
你是 Remi，Jack 的个人 AI 助手。

## 记忆系统
你拥有持久化记忆。每次对话开始时，相关记忆上下文自动注入在 <context> 标签中，
包含个人记忆、项目记忆、当日日志和可用实体目录。

你有两个记忆工具：
- recall(query, cwd?) — 搜索所有记忆（实体、历史日志、项目记忆）。
  当注入的上下文不够时使用。精确匹配实体名或别名返回全文，否则返回摘要列表。
- remember(entity, type, observation, scope?, cwd?) — 即时保存关于实体的重要信息。
  当用户告知值得长期记住的内容时使用（生日、偏好、重要决策）。
  scope="project" 时写入当前项目的实体目录，默认写入个人实体目录。
  注意：项目级技术知识（架构、技术栈）会在对话结束后由维护 agent 自动整理。

<context> 末尾的"可用记忆"表格是摘要目录，使用 recall(名称) 可查看完整详情。
```

### 7.2 Tool Description

```python
recall_tool = ToolDefinition(
    name="recall",
    description=(
        "搜索记忆。可搜索联系人、项目记忆、历史日志等所有记忆源。"
        "精确匹配实体名或别名返回全文，模糊匹配返回摘要列表。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "type":  {"type": "string", "description": "实体类型过滤（person/organization/decision）"},
            "tags":  {"type": "array", "items": {"type": "string"}, "description": "标签过滤"},
            "cwd":   {"type": "string", "description": "当前工作目录，用于搜索项目记忆"},
        },
        "required": ["query"],
    },
)

remember_tool = ToolDefinition(
    name="remember",
    description=(
        "即时记住重要信息。当用户告知生日、偏好、决策等值得长期保存的内容时调用。"
        "实体不存在则自动创建，已存在则追加为新观察。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "entity":      {"type": "string", "description": "实体名称"},
            "type":        {"type": "string", "description": "实体类型（person/organization/decision）"},
            "observation": {"type": "string", "description": "要记住的具体信息"},
            "scope":       {"type": "string", "description": "personal（默认）或 project"},
            "cwd":         {"type": "string", "description": "scope=project 时必填"},
        },
        "required": ["entity", "type", "observation"],
    },
)
```

---

## 8. 记忆接口

```
┌─────────────────────────────────────────────────────┐
│              Hot Path（对话中，同步）                  │
│  系统自动注入：gather_context(cwd)                    │
│  按需查找：recall tool                               │
│  即时记忆：remember tool                             │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│           Background（对话后，异步）                   │
│  Stop hook → 入队 → daemon 消费                      │
│  维护 Agent：批量整理、patch 写入                      │
│  Scheduler：日志压缩、归档                            │
└─────────────────────────────────────────────────────┘
```

### 8.1 系统自动注入（core.py）

```python
context = self.memory.gather_context(cwd=msg.metadata.get("cwd"))
```

### 8.2 对话 Agent Tool — recall

```python
def recall(
    self,
    query: str,
    type: str | None = None,
    tags: list[str] | None = None,
    cwd: str | None = None,
) -> str:
    results = []

    # 1. 搜索实体（先查内存索引，命中再读全文）
    for path_str, meta in self._index.items():
        if type and meta.get("type") != type:
            continue
        if tags and not set(tags) & set(meta.get("tags", [])):
            continue
        md_file = Path(path_str)
        if self._matches(md_file, query, meta):
            results.append(("entity", md_file, meta))

    # 2. 搜索历史日志
    daily_dir = self.root / "daily"
    if daily_dir.is_dir():
        for md_file in sorted(daily_dir.glob("*.md"), reverse=True):
            if self._matches_text(md_file, query):
                results.append(("daily", md_file, {}))

    # 3. 搜索项目记忆
    project_root = self._project_root(cwd) if cwd else None
    if project_root:
        for md_file in project_root.rglob(".remi/memory.md"):
            if self._matches_text(md_file, query):
                results.append(("project", md_file, {}))

    return self._format_results(results, query)


def _matches(self, md_file: Path, query: str, meta: dict) -> bool:
    """先检查索引中的 name + aliases，命中则精确返回全文，否则扫正文。"""
    q = query.lower()

    # 精确匹配 name
    if meta.get("name", "").lower() == q:
        return True

    # aliases 匹配（参与检索）
    for alias in meta.get("aliases", []):
        if q in alias.lower():
            return True

    # 正文 substring 匹配
    return self._matches_text(md_file, query)


def _matches_text(self, md_file: Path, query: str) -> bool:
    try:
        return query.lower() in md_file.read_text(encoding="utf-8").lower()
    except OSError:
        return False
```

**返回策略**：
- 精确匹配实体 name → 返回该实体全文
- 模糊匹配 → 返回匹配结果摘要列表（来源 + 匹配片段）
- 无匹配 → 返回空字符串

### 8.3 对话 Agent Tool — remember

```python
def remember(
    self,
    entity: str,
    type: str,
    observation: str,
    scope: Literal["personal", "project"] = "personal",
    cwd: str | None = None,
) -> str:
    """
    Hot Path 写入。source 固定为 user-explicit。
    scope="project" 时写入项目实体目录，否则写入个人实体目录。
    """
    if scope == "project":
        if not cwd:
            return "错误：scope=project 需要提供 cwd"
        project_root = self._project_root(cwd)
        if not project_root:
            return "错误：找不到项目根目录，请先 remi init"
        base_dir = project_root / ".remi" / "entities"
    else:
        base_dir = self.root / "entities"

    path = self._resolve_path(entity, type, base_dir)

    if path.exists():
        self._backup(path)
        self._append_observation(path, observation)
        self._update_frontmatter_timestamp(path)
        self._invalidate_index(path)
        return f"已更新 {entity}：{observation}"
    else:
        content = self._render_new_entity(entity, type, observation, source="user-explicit")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self._invalidate_index(path)
        return f"已创建 {entity}（{type}）：{observation}"
```

**与维护 Agent 的分工**：
- `remember`：对话中用户**主动告知**的重要信息，立即保存（Hot Path）
- 维护 Agent：对话后批量整理，提取隐含信息，整合矛盾，更新 Procedures（Background）

### 8.4 内部辅助方法

#### `_slugify` — 文件名生成

```python
def _slugify(self, name: str) -> str:
    """
    最小化处理：去掉路径非法字符，空格转连字符，保留中文和大小写。
    中文名直接保留（如"王伟.md"），不转拼音。
    """
    # 去掉 Windows/Unix 路径非法字符
    slug = re.sub(r'[<>:"/\\|?*\n\r\t]', '', name)
    slug = slug.strip().replace(' ', '-')
    return slug or "unnamed"
```

#### `_resolve_path` — 路径解析（含同名碰撞处理）

```python
def _resolve_path(self, entity: str, type: str, base_dir: Path) -> Path:
    """
    确定实体文件路径。
    优先找 frontmatter.name == entity 的已有文件；
    找不到则生成新路径，碰撞时加数字后缀。
    """
    type_dir = base_dir / self._type_to_dir(type)
    type_dir.mkdir(parents=True, exist_ok=True)
    slug = self._slugify(entity)

    # 查找已有文件中 name 匹配的
    for existing in type_dir.glob(f"{slug}*.md"):
        meta = self._parse_frontmatter(existing)
        if meta.get("name") == entity:
            return existing

    # 生成新路径，处理碰撞
    path = type_dir / f"{slug}.md"
    counter = 2
    while path.exists():
        path = type_dir / f"{slug}-{counter}.md"
        counter += 1
    return path
```

#### `_backup` — 备份

```python
def _backup(self, path: Path):
    """备份到 .versions/，每个实体只保留最近 10 个版本。"""
    versions_dir = self.root / ".versions"
    versions_dir.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    (versions_dir / f"{path.stem}-{ts}.md").write_text(
        path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    # 清理旧版本
    old = sorted(versions_dir.glob(f"{path.stem}-*.md"))
    for f in old[:-10]:
        f.unlink()
```

#### `_append_observation` — 追加观察

```python
def _append_observation(self, path: Path, observation: str):
    """追加到 ## 备注 章节，不存在则创建。"""
    content = path.read_text(encoding="utf-8")
    ts = datetime.now().strftime("%Y-%m-%d")
    entry = f"\n- [{ts}] {observation}"

    if "## 备注" in content:
        content = content.replace("## 备注", f"## 备注{entry}", 1)
    else:
        content += f"\n\n## 备注{entry}"

    path.write_text(content, encoding="utf-8")
```

#### `_update_frontmatter_timestamp` — 更新时间戳

```python
def _update_frontmatter_timestamp(self, path: Path):
    ts = datetime.now().isoformat(timespec="seconds")
    content = path.read_text(encoding="utf-8")
    content = re.sub(
        r'^updated:.*$', f'updated: {ts}',
        content, flags=re.MULTILINE
    )
    path.write_text(content, encoding="utf-8")
```

#### `_render_new_entity` — 生成新实体文件

```python
def _render_new_entity(
    self,
    entity: str,
    type: str,
    observation: str,
    source: Literal["user-explicit", "agent-inferred"] = "agent-inferred",
) -> str:
    ts = datetime.now().isoformat(timespec="seconds")
    return (
        f"---\n"
        f"type: {type}\n"
        f"name: {entity}\n"
        f"created: {ts}\n"
        f"updated: {ts}\n"
        f"tags: []\n"
        f"source: {source}\n"
        f"summary: \"\"\n"
        f"aliases: []\n"
        f"related: []\n"
        f"---\n\n"
        f"# {entity}\n\n"
        f"## 备注\n"
        f"- [{ts[:10]}] {observation}\n"
    )
```

### 8.5 内存索引

启动时建立一次，写入时增量更新，避免每次 `gather_context` 全量扫描磁盘：

```python
class MemoryStore:
    def __init__(self, root: Path):
        self.root = root
        # path_str → {type, name, tags, summary, aliases}
        self._index: dict[str, dict] = {}
        self._ensure_initialized()
        self._build_index()

    def _build_index(self):
        """启动时扫描一次 entities/，O(n) 但只跑一次。"""
        self._index.clear()
        entities_dir = self.root / "entities"
        if not entities_dir.is_dir():
            return
        for md_file in entities_dir.rglob("*.md"):
            meta = self._parse_frontmatter(md_file)
            self._index[str(md_file)] = {
                "type":    meta.get("type", ""),
                "name":    meta.get("name", md_file.stem),
                "tags":    meta.get("tags", []),
                "summary": meta.get("summary", ""),
                "aliases": meta.get("aliases", []),
            }

    def _invalidate_index(self, path: Path):
        """写入后调用，更新对应条目。"""
        meta = self._parse_frontmatter(path)
        self._index[str(path)] = {
            "type":    meta.get("type", ""),
            "name":    meta.get("name", path.stem),
            "tags":    meta.get("tags", []),
            "summary": meta.get("summary", ""),
            "aliases": meta.get("aliases", []),
        }
```

### 8.6 初始化保护

```python
def _ensure_initialized(self):
    """确保基础目录和文件存在，首次使用时自动创建。幂等。"""
    for d in [
        "entities/people",
        "entities/organizations",
        "entities/decisions",
        "daily",
        ".versions",
    ]:
        (self.root / d).mkdir(parents=True, exist_ok=True)

    global_memory = self.root / "MEMORY.md"
    if not global_memory.exists():
        global_memory.write_text(
            "# 个人记忆\n\n"
            "## 用户偏好\n\n"
            "## 长期目标\n\n"
            "## 近期焦点\n",
            encoding="utf-8",
        )
```

### 8.7 维护 Agent 内部方法（MemoryStore）

维护 Agent 对话结束后通过 Python 直接调用，不暴露为 MCP tool：

| 方法 | 签名 | 说明 |
|------|------|------|
| `create_entity` | `(name, type, content, source="agent-inferred")` | 创建实体文件，自动生成 frontmatter |
| `update_entity` | `(name, content)` | 覆写实体文件（自动备份，更新时间戳）|
| `append_observation` | `(name, observation)` | 追加到 `## 备注` 章节 |
| `patch_project_memory` | `(project_path, section, content, mode)` | Patch 写入项目记忆指定章节（mode: append \| overwrite）|
| `delete_entity` | `(name)` | 删除实体文件（自动备份）|
| `append_daily` | `(entry, date?)` | 追加到每日日志 |

`patch_project_memory` 的 `mode` 说明：
- `mode="append"` — 向指定章节末尾追加内容（适用于 `## 关键决策`、`## 架构` 等 Semantic 章节）
- `mode="overwrite"` — 替换整个章节内容（适用于 `## Procedures` 章节）

所有写入方法在修改前调用 `_backup()`，完成后调用 `_invalidate_index()`。

### 8.8 并发安全

`remember`（Hot Path，同步）和维护 Agent（Background，异步）可能写同一文件。

**策略**：
- 维护 Agent 启动时检查 `~/.remi/memory/.maintenance.lock`
- 锁存在且 mtime 距今 < 60s → 跳过本次维护
- 否则创建锁，执行维护，完成后删除
- `remember` 不加锁（单次原子写入），靠 `.versions/` 备份兜底
- 最坏情况：两者同时写同一实体 → `.versions/` 有备份，维护 Agent 下次自然整合

---

## 9. 异步写入模式（Background）

### 9.1 流程

```
用户对话结束
      │
      ▼
Stop hook 触发（< 1s）
      │
      ▼
将 transcript 写入 ~/.remi/queue/{timestamp}.jsonl
      │
      ▼
立即返回（不阻塞）
      │
      ▼
daemon 后台监听 queue/ 目录
      │
      ▼
逐个消费：读 transcript → LLM 分析 → patch 写入记忆文件
      │
      ▼
处理完成，移动到 queue/processed/（保留 30 天供 debug）
```

**幂等保护**：daemon 处理前计算 `sha256(transcript)[:16]` 写入 `.processed` 记录，重复触发时跳过。

### 9.2 Hook 配置

```json
{
  "hooks": {
    "Stop": [
      {
        "command": "python -m remi.memory.enqueue",
        "timeout": 5000
      }
    ]
  }
}
```

`remi.memory.enqueue` 只做入队（< 1s），实际 LLM 分析由 daemon 异步执行：

```bash
# daemon 启动（随 remi 启动，或 launchd/systemd 管理）
python -m remi.memory.daemon &
```

### 9.3 维护 Agent Prompt

```
你是 Remi 的记忆维护 agent。审查以下对话（最近 10 轮 + 对话摘要），
将值得长期记忆的信息写入正确的位置。

## 写入层级判断规则

默认只写两层：
- 全局偏好、跨项目通用知识    → ~/.remi/memory/MEMORY.md
- 项目相关的一切知识          → {project_root}/.remi/memory.md
- 关于人、组织、具体决策的信息 → ~/.remi/memory/entities/{type}/{name}.md

例外：当前 cwd 存在独立的 .remi/memory.md（模块层已拆出），
则模块相关的实现细节、局部约定写入该模块文件，项目根只保留跨模块内容。

## 写入模式说明
- ## Procedures 章节：使用 overwrite 模式（始终是最新版本）
- 其他章节：使用 append 模式（累积历史）

## 当前记忆结构
[由系统动态生成]

## 对话上下文
工作目录：{cwd}
对话摘要：{rolling_summary}
最近 10 轮对话：
{recent_turns}

## 请决定
对每条值得记忆的信息输出：
  - action: create_entity | update_entity | append_observation | patch_project_memory | append_global
  - target: 目标路径或实体名
  - section: 目标章节（patch_project_memory 时必填）
  - mode: append | overwrite（patch_project_memory 时必填）
  - content: 要写入的内容
  - source: agent-inferred

无值得记忆的内容则输出 SKIP。
```

**Rolling Summary**：Scheduler 在每次 daily 压缩时同步更新 `~/.remi/memory/.conversation_summary.md`，维护 Agent 读取该文件作为长期上下文，不消费全量 transcript。

---

## 10. Scheduler 变更

### 10.1 记忆压缩（增强）

新行为（每日触发）：
1. 读取昨日 `daily/{date}.md`
2. 对提及的每个实体，将相关观察追加到对应实体文件（`append_observation`）
3. 提取值得创建的新实体（`create_entity`）
4. 更新 Rolling Summary（`.conversation_summary.md`）
5. 将剩余跨领域洞察追加到 MEMORY.md
6. 压缩 8–30 天日志为周摘要（`weekly-{YYYY-WNN}.md`），归档 30 天以上日志
7. 无值得记忆的内容则 SKIP

### 10.2 重建索引（未来）

引入知识图谱后重建 `_graph.json`，本期不实现。

---

## 11. 从 v1 迁移

### 11.1 变更对照

| 组件 | v1 | v2 |
|------|----|----|
| 每日笔记 | `daily/` | `daily/`（不变，新增归档策略）|
| 项目记忆 | `projects/{name}/MEMORY.md` | 仓库内 `.remi/memory.md` |
| 实体记忆 | 无 | `entities/{type}/{name}.md`（带 frontmatter）|
| 模块记忆 | 无 | 仓库内 `.remi/memory.md`（默认合并在项目根，按需 `remi init --child` 拆出）|
| 上下文组装 | `read_with_ancestors()` 全量加载 | `gather_context(cwd)` Manifest/TOC |
| 写入模式 | 同步 | Hot Path（remember）+ Background（hook + daemon）|
| 性能 | 每次全扫描 | 启动时建内存索引，写入时增量更新 |

### 11.2 迁移步骤

1. `remi init` 初始化个人记忆目录（`_ensure_initialized` 幂等）
2. 在各项目根目录执行 `remi init --child` 创建 `{project}/.remi/memory.md`
3. 扫描现有 `daily/` 提取实体，生成初始实体文件
4. 将项目记忆从 `~/.remi/memory/projects/` 手动迁移到对应仓库的 `.remi/memory.md`
5. 更新 `MemoryStore` 类：新增内存索引、`_ensure_initialized`、所有内部方法
6. 实现 `gather_context(cwd)` 替代 `read_with_ancestors()`（两层默认加载逻辑）
7. 实现 `_build_manifest()` 和 `recall()`
8. 更新 agent tool 签名（recall 加 cwd，remember 加 scope/cwd）
9. 实现 Stop hook 入队脚本 + daemon
10. 模块知识积累后，按需执行 `remi init --child` 逐步拆出模块层

---

## 12. 实现分期

### Phase 1：核心重构
- 新目录布局 + `_ensure_initialized`
- 实体 CRUD（完整实现所有内部方法）
- 内存索引（`_build_index` + `_invalidate_index`）
- Frontmatter 解析（`python-frontmatter`）

### Phase 2：Manifest/TOC 上下文组装
- `gather_context(cwd)` + `_project_root`（最高层 `.remi/` 为根）
- `_build_manifest()`（从内存索引读取）
- `recall(cwd)` 支持项目记忆搜索
- 上下文告警阈值 + agent 可见提示

### Phase 3：Background 写入
- Stop hook 入队脚本（< 5s）
- daemon 异步消费队列
- 维护 Agent（Rolling Summary + 最近 10 轮）
- 幂等保护（transcript hash）
- 增强 Scheduler 压缩（实体感知 + 日志归档）

### Phase 4：未来
- 知识图谱（`_graph.json`）
- Embedding 对 Manifest 做相关性排序
- 实体关系类型化（`relations: [{entity, type, since}]`）
- 基于优先级截断的上下文预算
- **记忆溢出处理**：项目根 memory.md 过长时的分层拆分策略；实体过多时的 Manifest 截断（`last_accessed` 字段 + 只展示近期访问实体）；待出现明显瓶颈时设计

---

## 13. 依赖

- `python-frontmatter` — 解析 YAML frontmatter
- `re`、`hashlib`、`datetime` — 标准库，无新依赖
- 无向量数据库、无图数据库

---

## 14. 已解决问题清单

| # | 问题 | 结论 |
|---|------|------|
| 1 | 项目根目录发现 | 最高层 `.remi/` 为根，无隐式推断，用户 `remi init` 显式标记 |
| 2 | Frontmatter schema 校验 | 宽松灵活，必填字段在 `_render_new_entity` 中保证 |
| 3 | 实体命名约定 | slug 最小化处理，frontmatter `name` 字段存原始名做碰撞校验，中文直接保留 |
| 4 | 日志压缩 LLM 成本 | 维护 Agent 只消费最近 10 轮 + Rolling Summary，不消费全量 transcript |
| 5 | Hook 获取对话记录 | Stop hook 写入 `~/.remi/queue/{ts}.jsonl`，daemon 异步消费，幂等 hash 防重复 |
| 6 | `_matches()` 语义 | 先查索引的 name/aliases，命中精确返回；否则正文 substring |
| 7 | `write_project_memory` 全量替换还是 merge | 改为 `patch_project_memory(section, content, mode)`，按章节 patch |
| 8 | `confidence`/`review_after` 字段 | 废弃，从 schema 中删除 |
| 9 | `source` 字段由谁设 | `remember` 固定写 `user-explicit`，维护 Agent 固定写 `agent-inferred` |
| 10 | Hook 超时 | 两段式：hook 仅入队（5s 超时），daemon 无时间限制 |
| 11 | `.versions/` 清理 | 每个实体保留最近 10 个版本，备份时自动清理旧版 |
| 12 | `recall` 缺 cwd | 已加入签名，用于项目记忆搜索 |
| 13 | `aliases` 是否参与检索 | 是，在 `_matches()` 中优先于正文扫描 |
| 14 | `gather_context` 无初始化保护 | `_ensure_initialized()` 幂等，每次调用自动检查 |
| 15 | 多层 memory.md 维护成本高 | 两层为默认（个人全局 + 项目根），模块层按需拆出；维护 Agent 默认只写两层 |
