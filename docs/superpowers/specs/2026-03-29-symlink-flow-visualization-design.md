# Symlink 三层同步 + 流向图可视化 设计方案

**Date:** 2026-03-29
**Status:** Draft
**Scope:** 后端 symlink-manager + 前端 Dashboard Symlinks 页面

---

## 一、三层同步架构

### 第一层：项目目录整体同步（已实现）

```
~/.claude/projects/{hash}  →  ~/.remi/projects/{hash}
```

所有 Claude Code 项目数据（sessions、memory、wiki）统一存储到 `~/.remi/projects/`。

### 第二层：Memory 集中化

```
~/.remi/memory/                                    ← 集中式记忆根
├── MEMORY.md, daily/, entities/                   ← 个人记忆内容
└── projects/                                      ← 项目级记忆
    ├── remi/                                      ← 实际数据
    ├── larkparser/
    └── ...

Symlinks:
  ~/.remi/projects/{home-hash}/memory   → ~/.remi/memory                       (home → 根)
  ~/.remi/projects/{proj-hash}/memory   → ~/.remi/memory/projects/{alias}      (项目 → 子目录)
```

### 第三层：Wiki 集中化（与 Memory 完全镜像）

```
~/.remi/wiki/                                      ← 集中式 wiki 根（NEW）
├── README.md, directory-architecture/, jack/       ← 个人 wiki 内容
└── projects/                                      ← 项目级 wiki
    ├── remi/
    ├── larkparser/
    └── ...

Symlinks:
  ~/.remi/projects/{home-hash}/wiki     → ~/.remi/wiki                         (home → 根)
  ~/.remi/projects/{proj-hash}/wiki     → ~/.remi/wiki/projects/{alias}        (项目 → 子目录)
```

### 数据流全景

```
~/.claude/projects/{hash}
        │
        │  第一层：整体同步
        ▼
~/.remi/projects/{hash}/
        ├── *.jsonl (sessions)
        ├── memory/ ───────→  ~/.remi/memory/[projects/{alias}]    第二层
        └── wiki/   ───────→  ~/.remi/wiki/[projects/{alias}]      第三层
```

同一份数据三条访问路径：
1. `~/.claude/projects/{hash}/memory/` — Claude Code 原生
2. `~/.remi/projects/{hash}/memory/` — 第一层跟随
3. `~/.remi/memory/projects/{alias}/` — 集中化入口

---

## 二、Hash → 项目名解析

| Hash | 解析规则 | 显示名 |
|------|---------|--------|
| `-data00-home-hehuajie` | home hash 特殊识别 | `~ (home)` |
| `-home-hehuajie` | home hash 特殊识别 | `~ (home)` |
| `-data00-home-hehuajie-project-remi` | 取 `-project-` 后部分 | `remi` |
| `-data00-home-hehuajie-project-larkparser` | 取 `-project-` 后部分 | `larkparser` |
| `-data00-home-hehuajie-project-remi-agents-memory-audit` | 取 `-project-` 后部分 | `remi-agents-memory-audit` |
| `-data00-home-hehuajie-tasks-lark-parser-openAPI-test` | 无 `-project-`，取 `-tasks-` 后 | `lark-parser-openAPI-test` |

优先用 `remi.toml [projects]` 里的 alias（如 `remi`、`larkparser`），其他按规则解析。

---

## 三、Dashboard 可视化

### 分组结构

```
Symlinks · FILESYSTEM MAPPING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Total: 39]  [OK: 39]  [Broken: 0]  [Not Linked: 0]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▼ Soul
  ~/.claude/CLAUDE.md                    →  ~/.remi/soul.md                              ● OK

▼ Global (Home)
  ~/.claude/projects/-data00-home-hehuajie  →  ~/.remi/projects/-data00-home-hehuajie    ● OK  DIR
  Contains: CLAUDE.md (agents.md), sessions

  ├─ Memory
  │  ~/.remi/projects/…/memory           →  ~/.remi/memory                               ● OK  DIR

  └─ Wiki
     ~/.remi/projects/…/wiki             →  ~/.remi/wiki                                 ● OK  DIR

▼ Projects (12)
  ▶ remi                                                                                        DIR
    ~/.claude/projects/…-remi            →  ~/.remi/projects/…-remi                      ● OK
    ├─ memory → ~/.remi/memory/projects/remi                                             ● OK
    └─ wiki   → ~/.remi/wiki/projects/remi                                               ● OK

  ▶ larkparser                                                                                  DIR
    ~/.claude/projects/…-larkparser      →  ~/.remi/projects/…-larkparser                ● OK
    ├─ memory → ~/.remi/memory/projects/larkparser                                       ● OK
    └─ wiki   → ~/.remi/wiki/projects/larkparser                                         ● OK

  ▶ markone                                                                                     DIR
    ...

  ▶ remi-agents-memory-audit             (no memory, no wiki)                                   DIR
    ~/.claude/projects/…                 →  ~/.remi/projects/…                            ● OK
```

### 交互设计

1. **两级折叠**
   - 一级：Global / Projects 分组
   - 二级：Projects 下每个项目可展开看 memory + wiki 子映射

2. **项目名显示**
   - Hash 解析为可读名：`-data00-home-hehuajie-project-remi` → **remi**
   - Home 显示为：**~ (home)**

3. **子映射缩进**
   - Memory 和 Wiki 作为项目的子项，用树形缩进（`├─` `└─`）
   - 没有 memory/wiki 的项目标注 `(no memory, no wiki)`

4. **状态和类型**
   - 状态：● OK（绿）、● Broken（红）、● Not Linked（黄）
   - 类型：`DIR` / `FILE` 小标签，只在项目级显示

5. **Fix 操作**
   - Fix All 按钮：修复所有 broken
   - 单项 Fix：broken 行旁的 Fix 按钮

---

## 四、后端改动

### 4.1 清理

- 删除 13 个 broken wiki.md 自引用 symlink
- 删除 `~/.remi/.claude/skills/agent-browser` broken link

### 4.2 symlink-manager.ts 改动

**新增：`ensureProjectMemoryLinks()`**
- 遍历所有已注册项目
- 创建 `~/.remi/memory/projects/{alias}/`
- 迁移 `~/.remi/projects/{hash}/memory/` 内容到集中目录
- 替换为 symlink：`projects/{hash}/memory → ~/.remi/memory/projects/{alias}`

**新增：`ensureProjectWikiLinks()`**
- 创建 `~/.remi/wiki/` 根目录
- 迁移 home wiki 内容到 `~/.remi/wiki/`（不含 wiki.md）
- 创建 `~/.remi/wiki/projects/{alias}/`
- 迁移各项目 wiki 内容（不含 wiki.md）
- 替换为 symlink：`projects/{hash}/wiki → ~/.remi/wiki/projects/{alias}`

**修复：`_collectKnownMappings()`**
- 删除 wiki.md 的 source===target bug
- 新增 memory 和 wiki 集中化映射的状态上报

**修复：`ensureWikiLinks()`**
- 删除创建 wiki.md symlink 的逻辑

**新增：`hashToAlias(hash)`**
- 从 hash 解析可读项目名
- 优先用 remi.toml alias，fallback 用路径解析

### 4.3 API 变化

`GET /api/v1/symlinks/status` 返回数据新增字段：

```typescript
interface SymlinkMapping {
  source: string;
  target: string;
  type: "dir" | "file";
  status: "ok" | "broken" | "not_linked" | "missing_target";
  category?: "soul" | "global" | "memory" | "wiki" | "project";  // NEW
  projectAlias?: string;  // NEW: 可读项目名
  parentHash?: string;    // NEW: 所属项目 hash（memory/wiki 子映射用）
}
```

---

## 五、前端改动

### 文件清单

| 文件 | 操作 |
|------|------|
| `stores/symlinks.ts` | 重写分组逻辑，支持两级折叠 |
| `pages/Symlinks.tsx` | 重写为树形流向图 |
| `api/types.ts` | 新增 category、projectAlias、parentHash 字段 |
| `App.tsx` | 已完成（路由已恢复） |
| `Sidebar.tsx` | 已完成（入口已添加） |

---

## 六、迁移策略

1. **备份**：迁移前对 `~/.remi/projects/` 做快照
2. **Memory 迁移**：内容 `mv` 到集中目录 → 原位创建 symlink → 验证可读
3. **Wiki 迁移**：同上，跳过 broken wiki.md
4. **幂等**：`ensureOne()` 已有幂等逻辑，重复执行安全
5. **回滚**：如果 symlink 创建失败，保留原目录不删除
