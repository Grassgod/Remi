# 云友（Agent）配置规范

状态：生效（MUL-81 落地）。来源：MUL-73 用户反馈 →「云友之间写的很随意，包括头像、提示词、Skill、Plugin」；MUL-80 审计确认了具体问题。

适用范围：

- **工作区云友**：Multiremi 里通过 UI/API 配置的 Agent（DB 表 `multiremi_agents`），含 Squad 成员。
- **内置模板**：`packages/server/src/api/agent-templates/*.json`。
- **仓库内 Skill**：`.remi/pipeline/skills/*/SKILL.md`、`frontend/.agents/skills/*/SKILL.md`。
- **Plugin**：`packages/plugin-sdk` manifest 与 Multiremi agent plugin。

自动校验：`bun test tests/arch/agent-config-metadata.test.ts`（CI 由 `release-build-check.yml` 的 tests/arch 整目录覆盖）。DB 里的工作区云友无法用仓库测试兜底，靠本规范 + 变更时人工对照。

---

## 1. 分层：哪句话该写在哪里

一个云友运行时看到的提示词由多层拼装。**每层只写自己的内容，禁止跨层重复**——重复的后果是两处漂移后模型无所适从。

| 层 | 载体 | 注入方式 | 该写什么 | 不该写什么 |
|---|---|---|---|---|
| 平台公共底座 | daemon ephemeral prompt（`packages/daemon/src/agent-runtime/prompts/ephemeral.ts`） | 平台在 bootstrap 时自动拼装：workspace/issue/env/身份/权限等区块 | 由平台代码维护，云友配置者不用管 | —— |
| **云友个性** | `multiremi_agents.instructions`（UI「指令」框） | bootstrap 时作为 `## Agent Instructions` 区块注入 | 身份、职责边界、个性化工作方式（见 §2 骨架） | 平台已注入的内容（Issue 流程、workspace 说明）；仓库规则；大段可复用操作手册（应做成 Skill） |
| 仓库规则 | 各仓库 `AGENTS.md` / `CLAUDE.md` | 编码 CLI 按 cwd 自动读取 | 仓库级开发约定 | 云友人设 |
| 飞书 Remi 人格 | `~/.remi/soul.md`（模板 `soul.md.example`） | symlink 到 `~/.claude/CLAUDE.md`，Claude CLI 自动加载 | 飞书聊天 Remi 的人格与 MCP 工具约定 | 与 Multiremi 云友无关，不要混用 |
| 可复用操作知识 | Skill（`SKILL.md`） | 物化到 workdir + bootstrap prompt 注入 | 有触发条件的操作手册（见 §4） | 人设、一次性任务说明 |

## 2. 提示词（instructions）规范

### 2.1 标准骨架（六段）

可复制模板：`docs/templates/agent-prompt.md.example`。按顺序写，允许合并相邻段，但六个问题都要有答案：

1. **身份定位** —— 一句话：你是谁、服务于什么场景。写给模型看，不是简历。
2. **职责边界** —— 负责什么、明确不负责什么；与相邻云友（如执行者 vs 校验者）的分界。
3. **禁止事项** —— 具体的「不得」清单：不碰生产、不泄凭据、不越权合入等。写可判定的行为，不写口号。
4. **工具与 CLI 约定** —— 该用哪些工具/命令、关键参数约定；只写该云友特有的，平台通用工具不用重复。
5. **交付物形态** —— 完成时输出什么：评论格式、必附证据（测试输出、截图、文件路径）、禁止「只说做完了」。
6. **何时停下来问人** —— 哪些情况必须停下（缺信息、要动生产、结果与预期矛盾），以及怎么问。

### 2.2 硬性规则（校验或 review 必查）

- **纯 Markdown 文本**。禁止把 JSON 转义串（带 `\n`、首尾引号）当 instructions 存入——这是 MUL-80 发现的真实事故（Wiki Maintainer）。
- **长度 100–4000 字符**。一句话人设（如「负责生成设计图」）不合格：六段骨架答不全。内置模板的经验区间是 1400–2500。
- **单一主语言**（中文或英文），术语可混用；编号列表必须连续（PM 曾出现两个「1.」的合并草稿事故）。
- `description` 字段（≤255 码点，服务端强制）写「一句话职责」，供列表页和派单判断用；不要与 instructions 第一句逐字重复。
- **model 必填**：不显式选择就写明跟随默认的理由；同一 Squad 内除非有意，不要混用差异过大的模型。
- 不再使用的云友**归档**（archived），不要留空壳（曾有 `codex`、`codex-collab-smoke` 两个空配置残留）。

### 2.3 风格基准

`packages/server/src/api/agent-templates/*.json` 的 26 个内置模板是达标线：首句「You <do X>. Reader: <who>」式定位，随后 Defaults/Format 编号清单，结尾禁止事项。新云友先抄模板再个性化，不要从零白写。

## 3. 头像规范

- **规格**：512×512 PNG，单文件 ≤300KB。方图，圆形裁切（前端 32px 圆形头像）下核心图形仍可辨识；图上不放文字。
- **来源**：上传到 workspace 附件（前端头像组件即此路径），`avatar_url` 只允许站内相对路径 `/api/attachments/<id>/content`。**禁止外链 URL**——服务端不校验该字段，外链等于给所有看到头像的人挂追踪像素。
- **必配**：所有长期云友必须有头像。缺省时前端退化为统一灰底 Bot 图标，多云友场景下不可辨认，属不合格状态。Squad 头像为方形（`rounded-md`），个人为圆形，风格应区分。
- **同一工作区一套风格**：新增云友的头像跟随已有系列（配色/构图一致，角色特征区分）。
- **清空语义（现状 API 行为，写代码时注意）**：`PATCH` 更新时传 `avatar_url: ""` 才能清空，传 `null` 会被当作「保持原值」；从模板创建路径则把 `""` 归一为 `null`。前端组件已封装此差异，脚本直调 API 时须知。

## 4. Skill / Plugin 描述约定

description 是模型决定「何时触发」的唯一依据，写得随意直接导致不触发或误触发。

### 4.1 SKILL.md

- **frontmatter 必须含 `name` 与 `description` 两个 key**，且为**单行 plain scalar**（不用 `|`/`>` 块标量、不用多行折行）。原因：仓库内有三套 frontmatter 解析器（`skill-import.ts` 手写解析、`local-skills.ts` 正则、admin 的 gray-matter），只有「单行 name/description」是三者行为一致的子集。
- `name` = kebab-case，**必须等于所在目录名**。
- `description` 必填，20–1024 字符，结构为：**「做什么」＋「何时触发」**，触发条件写具体：
  - 好：`Contract 验收评估 — 验证实现是否满足用户提交的验收标准。…用于评估交付物是否符合 Contract Case。`（做什么 + 场景）
  - 好：`Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", …`（触发关键词正例）
  - 坏：`处理相关任务`、空 description（daemon 物化时允许 description 缺失，所以必须在源头兜住）。
  - 若存在易混淆的相邻 skill，写「何时**不**用本 skill」反例（参考 lark-plugin 的「唯一入口，不要使用相似 skill」写法）。
- 其余元数据（author/version 等）放 `metadata:` 子块，不新增顶层 key。

### 4.2 Agent 模板 JSON

- `slug` = 文件名 = kebab-case；`name`、`description`、`instructions` 必填。
- `description` ≤255 码点；`instructions` 200–4000 字符，遵循 §2 骨架。
- `category` ∈ {Engineering, Writing, Product, Design, Communication, Productivity, Team}；`accent` ∈ {info, success, warning, primary, secondary}；`icon` 为 lucide-react 图标名。三者必填（模板的视觉区分靠它们）。
- `skills[].cached_name`、`cached_description` 必填，`source_url` 为 https。

### 4.3 Plugin

- `packages/plugin-sdk` manifest 五个必填字段一个不缺：`id`、`name`、`version`、`description`、`capabilities`（运行期只校验 id/main，缺 description 会被静默加载——不要依赖运行期兜底）。
- Multiremi agent plugin（挂到云友上的 claude/codex bundle）：`description` 同样按「做什么 + 何时用」写；同名 plugin 会按 provider 各存一份（claude/codex），属正常现象，描述保持一致。

## 5. 目录分层职责（谁放定义、谁放机制）

| 路径 | 职责 | 放 skill/plugin 定义吗 |
|---|---|---|
| `packages/daemon/src/agent-runtime/skills/` | **机制**：把 DB skill 物化成 workdir 的 SKILL.md；导入 GitHub/skills.sh | ❌ |
| `packages/daemon/src/agent-runtime/plugins/` | **机制**：Remi host 插件 registry（in-tree 表当前为空） | ❌ |
| `packages/daemon/src/agent-runtime/agent-plugins/` | **机制**：云友挂载的 provider 原生 bundle 的拉取/物化（与上一行刻意分离） | ❌ |
| `packages/plugin-sdk/` | Remi host 插件的 manifest 类型与 SDK | ❌（只有类型） |
| `.remi/pipeline/skills/` | 历史 Remi 流水线 skill 定义（intake/rfc/execute 等 7 个）。MUL-80 审计确认读取链路已删（死目录，待清理单处理）；清理前仍按本规范校验 | ✅（存量） |
| `frontend/.agents/skills/` | frontend 仓库开发用 skill | ✅ |
| `packages/server/src/api/agent-templates/*.json` | 云友模板（含内嵌 skill 引用） | ✅ |

新定义只落在打 ✅ 的三处；在机制目录里新增定义文件视为分层违规。

## 6. 自动校验范围

`tests/arch/agent-config-metadata.test.ts` 强制：

- 模板 JSON：slug/文件名一致、必填字段、description/instructions 长度、category/accent 枚举、icon 非空、skills 子字段。
- 仓库内全部 SKILL.md：frontmatter 存在、name=目录名、description 必填 + 单行 + 长度。

**无法自动化、靠 review 的**：DB 中工作区云友的 instructions 质量（六段骨架）、头像是否配置、description 语义是否含触发条件。变更工作区云友时以本文档 §2/§3 为 checklist。

## 7. 已知问题（本规范不强做，留待后续单）

- 服务端对 `instructions`、`avatar_url` 零校验（长度/URL 白名单），是仅有的两个无校验用户可写字段。
- `packages/remi/src/admin/data/skills.ts:24` 的 pipeline scope 路径按 `__dirname` 相对解析，指向不存在的目录，admin UI 的 Pipeline scope 永不可见。
- `multiremi_agents.skills` JSON 列与 `multiremi_agent_skills` 连接表双轨存储，写路径互不同步，靠读时 merge 掩盖。
- skill 正文全量内联进 bootstrap prompt（非按需加载），长 skill 有 token 成本。
- `docs/MULTIREMI_PARITY_MATRIX.md` 与 `docs/ARCHITECTURE.md` 存在对 pipeline/skills 现状的过时描述。
