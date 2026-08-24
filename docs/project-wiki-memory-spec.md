# Project Wiki + Memory — Phase 1 实现规格（构建契约）

> 状态：实现中（codex/llm_wiki 分支）
> 编排：Fable（本文档 = 各构建 agent 的唯一契约来源，冲突以本文档为准）
> 范围：Phase 1 = 表 + Store + REST API + agent CLI + task prompt 注入 + 前端 Wiki tab（只读）
> 明确不做（后续阶段）：前端编辑器、project_ref 知识继承、FTS/向量检索、librarian 蒸馏、审核队列、workspace 级 memory

## 0. 概念

一张表承载两种知识：
- `kind='memory'`：agent 运维记忆条目。title = 事实一句话（必填），body = 可选细节。默认 pinned=1（进 prompt 注入索引）。
- `kind='wiki'`：文档页。title + body(markdown)。默认 pinned=0。

每条记录带出处（source_task_id / source_issue_id，软引用无 FK——task 会被 GC，知识不能跟着消失）与作者（author_type: member|agent）。所有写入落 revision，可回滚可审计。

## 0.5 Karpathy LLM-wiki 原则对齐（v2 修订，来源：gist.github.com/karpathy/442a6bf555914893e9891c11519de94f）

| Karpathy 原则 | 本方案落法 |
|---|---|
| 三层：不可变来源 / LLM 拥有的 wiki / schema 约定文档 | 来源层 = multiremi 原生的 issue 讨论、task transcript、代码库（本就不可变）；wiki 层 = project_docs；**schema 层 = 每 project 一个保留 slug `_schema` 的 wiki 文档**（本次新增，见 §3/§6） |
| wiki 内容从来源蒸馏并引用来源 | source_task_id/source_issue_id（自动出处）+ **refs 引用数组**（本次新增：多来源引用 issue/task/comment/url） |
| 整合优于堆积：新信息更新既有页面、矛盾要显式标注，而不是无限追加 | prompt 写回纪律改写（§6）：先 search/get → 能 update 不 create → 矛盾时修订旧条目并注明依据；librarian（phase 2）负责把 memory 快速记录合并进 wiki 页 |
| [[wiki-links]] 页面互链 | 写入约定 + 前端渲染 [[slug]] 内链（本次进 phase 1）；反链图/orphan 检测留 phase 2 lint |
| index.md 目录先读、~100 源内不需要向量检索 | 我们的注入索引由表生成（DB 原生等价物，无需手工维护）；L1 LIKE 检索先行、向量推迟——原方案已对齐 ✓ |
| log.md 追加式日志 | revisions 全表按 created_at 即时间线（DB 原生等价物）✓ |
| lint：矛盾/过时/孤儿页/缺页检查 | phase 2 librarian 的检查清单（见 §10） |
| markdown 为载体、git 为版本 | body 即纯 markdown；revisions 即版本史；DB 替代文件系统的理由不变（多 repo/零 repo、前端浏览、多机 agent、实时推送）；后续可选把 wiki 物化进 task workdir（对齐 skills 物化机制） |

**memory 与 wiki 的关系（叙事修正）**：memory 条目 = 未整合的快速捕获（hot path，对齐老 remi 的 daily），wiki 页 = 整合后的长期知识（对齐长期记忆）；librarian 蒸馏 = compaction。

## 1. DDL（加入 migrations.ts 的启动 DDL 块，跟随现有风格：无 CHECK 约束，验证在 store 层）

```sql
CREATE TABLE IF NOT EXISTS multiremi_project_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  kind TEXT NOT NULL DEFAULT 'wiki',
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  refs TEXT NOT NULL DEFAULT '[]',
  source_task_id TEXT,
  source_issue_id TEXT,
  author_type TEXT,
  author_id TEXT,
  updated_by_type TEXT,
  updated_by_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, slug),
  FOREIGN KEY(project_id) REFERENCES multiremi_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_multiremi_project_docs_project ON multiremi_project_docs(project_id, kind, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_multiremi_project_docs_workspace ON multiremi_project_docs(workspace_id);

CREATE TABLE IF NOT EXISTS multiremi_project_doc_revisions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL DEFAULT '',
  author_type TEXT,
  author_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(doc_id, version),
  FOREIGN KEY(doc_id) REFERENCES multiremi_project_docs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_multiremi_project_doc_revisions_doc ON multiremi_project_doc_revisions(doc_id, version);
```

新表只需加进启动 DDL 块（`CREATE TABLE IF NOT EXISTS` 每次启动执行，老库自动补建）。不需要 addColumnIfMissing。**PG 注意**：不要写参数级 `? IS NULL`（PG 拒绝，见 72453690 教训）；布尔用 INTEGER 0/1；LIKE 大小写行为两方言不同——搜索用 `LOWER(col) LIKE LOWER(?)`。

## 2. Contracts（packages/contracts/src/types.ts）

```ts
export type MultiremiProjectDocKind = "wiki" | "memory";

export interface MultiremiProjectDoc {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: MultiremiProjectDocKind;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  /** 引用的来源。type: issue|task|comment|url|file（宽松校验，未知 type 保留） */
  refs: MultiremiProjectDocRef[];
  sourceTaskId: string | null;
  sourceIssueId: string | null;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  updatedByType: "member" | "agent" | null;
  updatedById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiProjectDocRevision {
  id: string;
  docId: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  createdAt: string;
}

/** Injection index attached to task dispatch. Bodies only for memory entries, trimmed. */
export interface MultiremiProjectDocIndexEntry {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  /** memory 条目带 body（截断至 500 字符）；wiki 条目为 null */
  body: string | null;
  kind: MultiremiProjectDocKind;
  pinned: boolean;
  sourceIssueId: string | null;
  updatedAt: string;
}

export interface MultiremiProjectDocRef {
  type: string;
  value: string;
}

export interface MultiremiProjectDocsIndex {
  memory: MultiremiProjectDocIndexEntry[];
  wiki: MultiremiProjectDocIndexEntry[];
  /** `_schema` 文档 body（截 1500 字符），无则 null。`_schema` 不出现在 wiki[] 里。 */
  schema: string | null;
}
```

契约类型只写 camelCase（snake 双字段只出现在既有请求/响应形状里，新类型不加）。`MultiremiTaskWithAgent` 增加：`projectDocs: MultiremiProjectDocsIndex | null;`

Create/Update 输入类型接受 camel/snake 双写（store 层 `input.x ?? input.x_snake` 兜底，照 CreateProjectResourceInput 抄）。

## 3. Store（packages/server/src/store/store.ts）

方法（全部放在 project resources 方法附近）：

- `listProjectDocs(projectId: string, input?: { kind?: string | null }): MultiremiProjectDoc[]` — 排序 `pinned DESC, updated_at DESC`。project 不存在 → throw `Project not found: <id>`（沿用现有文案）。
- `getProjectDoc(id: string): MultiremiProjectDoc | null`
- `getProjectDocByRef(projectId: string, ref: string): MultiremiProjectDoc | null` — ref 先按 id 查再按 slug 查。
- `createProjectDoc(projectId: string, input: CreateProjectDocInput): MultiremiProjectDoc`
  - kind 必须 wiki|memory，否则 throw `unknown kind: <k>`；title 必填 trim 非空否则 throw `title is required`。
  - id = `createId("pdoc")`；slug = 显式传入或 slugify(title)（小写、非字母数字→`-`、折叠去首尾 `-`；结果为空——如纯中文标题——则用 doc id）。slug 冲突（UNIQUE 违反）由调用方收到 error（API 层映射 409），不自动加后缀。
  - pinned 默认：memory=true，wiki=false。tags 默认 []。summary/body 默认 null/''。
  - 事务内：INSERT doc(version=1) + INSERT revision(v1) + `UPDATE multiremi_projects SET updated_at`（对齐 createProjectResource:5531 的父表 touch）。
- `updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): MultiremiProjectDoc`
  - 可改 title/summary/body/tags/pinned/slug；`expectedVersion?: number` 提供且 ≠ 当前 version → throw `project doc version conflict`（API 映射 409）。
  - 事务内：UPDATE（version+1, updated_at, updated_by_*）+ INSERT revision(新 version) + 父表 touch。
- `deleteProjectDoc(projectId: string, ref: string): void` — 不存在 throw `Project doc not found: <ref>`。
- `listProjectDocRevisions(docId: string): MultiremiProjectDocRevision[]` — version DESC。
- `searchProjectDocs(projectId: string, query: string, input?: { kind?: string | null; limit?: number }): MultiremiProjectDoc[]` — `LOWER(title||summary||body||tags) LIKE LOWER('%q%')` 双方言安全写法（各列独立 OR，不做列拼接以免 NULL 传染），limit 默认 20。
- `getProjectDocsIndex(projectId: string): MultiremiProjectDocsIndex` — memory：pinned 优先再按 updated_at DESC，取 ≤50 条，body 截 500 字符；wiki：全部（≤100，**排除 `_schema`**），body=null，summary 截 160；schema：`_schema` 文档 body 截 1500，无则 null。
- **refs**：create/update 接受 `refs?: {type,value}[]`（camel/snake 双写 `refs`），normalize 宽松（type/value 转 string trim，value 空的丢弃，最多 20 条），存 JSON；mapper 容错 parse 为 []。
- **`ensureProjectDocSchema(projectId)`**：createProjectDoc 在创建非 `_schema` 文档时，若该 project 尚无 `_schema`，先在同一事务外播种一篇默认 schema 文档（kind='wiki'、slug='_schema'、title='Wiki Schema'、pinned=false、author_type=null，body = 下方默认模板）。`_schema` 是普通文档：可读可改可有 revision，仅 slug 保留（用户显式创建 slug='_schema' 时不重复播种）。

默认 `_schema` 模板（嵌在 store 代码里的常量，中文）：

```markdown
# Wiki Schema（本项目知识库维护规则）

本文档约束 agent 如何维护本项目的 wiki 与 memory，人和 agent 都可修订本文档。

## 分层
- 原始来源（issue 讨论、task transcript、代码库）不可修改；wiki/memory 是从来源蒸馏出的知识。
- memory 条目 = 未整合的快速记录；wiki 页 = 整合后的长期知识。

## 维护纪律
- 写入前先 `doc search` / `doc get` 查已有条目；能 update 就不要 create。
- 新事实与旧条目矛盾时：更新旧条目并在正文注明变化与依据（引用 issue/task），不要静默并存两个版本。
- 写入时用 --ref 引用来源（issue/task/url）；页面间用 [[slug]] 交叉链接。
- 一次性细节、只对当前 issue 有效的信息不要入库。
```
- `getTaskWithAgent`（store.ts:7201）返回对象增加 `projectDocs: project ? this.getProjectDocsIndex(project.id) : null`。

行映射器 `toProjectDoc(row)` / `toProjectDocRevision(row)`：tags JSON.parse 容错为 []，pinned `Number(row.pinned) === 1`（PG bridge 可能回 boolean —— 用 `row.pinned === true || Number(row.pinned) === 1`）。

## 4. REST API（packages/server/src/api/api.ts，紧邻 project resources 路由块）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/projects/:projectId/docs?kind=&q=&limit= | q 存在走 search，否则 list。→ `{ docs: [...] }` |
| POST | /api/projects/:projectId/docs | → `{ doc }` 201 |
| GET | /api/projects/:projectId/docs/:ref | ref = id 或 slug → `{ doc }` |
| PUT | /api/projects/:projectId/docs/:ref | → `{ doc }` |
| DELETE | /api/projects/:projectId/docs/:ref | → `{ deleted: true }` |
| GET | /api/projects/:projectId/docs/:ref/revisions | → `{ revisions: [...] }` |

- 鉴权：与 project resources 端点完全一致的 helper 组合（workspace 成员 gating + agent/task token 通过既有中间件）。**写操作解析 acting actor**：member → author_type='member'+user id；agent（task token）→ author_type='agent'+agent id。POST body 里 `source_task_id` 仅在 actor 是 agent 时接受；若有 task id 而无 source_issue_id，服务端从 task 反查 issue id 填充。
- POST/PUT 接受 `refs`（{type,value} 数组），序列化响应带 `refs`。
- 序列化：`projectDocCompatibilityResponse(doc)` 全 snake_case（含 tags 数组、pinned boolean）；`projectDocRevisionCompatibilityResponse`。
- 错误映射 `projectDocErrorResponse`：`Project not found`→404、`Project doc not found`→404、`title is required`/`unknown kind`→400、`version conflict`→409、UNIQUE/duplicate key→409（消息 `a doc with this slug already exists`，同时匹配 SQLite `UNIQUE constraint failed` 与 PG `duplicate key value violates unique constraint` 两种文案）。
- WS：`publishWorkspaceEvent(c, store, "project_doc:created"|"project_doc:updated", ws, { doc: <compat>, project_id })`；`project_doc:deleted` → `{ project_id, doc_id }`。照 project_resource 三连（api.ts:6445-6478）抄。
- daemon claim 响应：找到 claim 序列化点，将 `projectDocs` 以 `project_docs` snake 形状带上（entry 字段 snake：source_issue_id/updated_at…）。

## 5. CLI（apps/remi/cli/multiremi.ts）

runMultiremi switch 加 `case "memory"` 和 `case "wiki"`。模板 = issue metadata 块（926-959）+ issueComment 的 content 读取。

```
remi memory list|search <query> [--project <project-id>] [--output json]
remi memory get <slug-or-id> --project <project-id>
remi memory create --project <project-id> --title <t>
remi wiki list|search <query> [--project <project-id>] [--output json]
remi wiki get <slug-or-id> --project <project-id>
remi wiki create --project <project-id> --title <t>
    [--slug <s>] [--summary <s>] [--tags a,b] [--pinned]
    [--ref issue:<id>] [--ref task:<id>] [--ref url:<url>]   # 可重复，冒号前为 type
    [--content <text> | --content-stdin | --content-file <path>]
remi wiki update <slug-or-id> --project <project-id>
    [--title <t>] [--summary <s>] [--tags a,b] [--pinned true|false]
    [--expected-version <n>] [--content <text> | --content-stdin | --content-file <path>]
remi wiki delete|revisions|backlinks <slug-or-id> --project <project-id>
remi memory update|delete|backlinks <slug-or-id> --project <project-id>
    [--content <text> | --content-stdin | --content-file <path>]
```

- `memory create`：kind=memory，**source_task_id 自动取 `process.env.MULTIREMI_TASK_ID`**（有则带）；同样支持 --ref。
- `--ref` 解析：`stringListOption(options, "ref")`，按第一个冒号切 type:value，无冒号视为 url（http 开头）否则报用法错误。update 传 --ref 则整体替换 refs。
- content 读取：create/memory add 用 `readContentBody(options, "doc content")`（必填三选一，multiremi.ts:1265），但 doc create 允许无 content（wiki 骨架页/纯 title memory）→ 用 `readOptionalTextBody(options, "content")`（1127）取可选值。
- 请求走 `multiremiApiRequest(method, path, body, options)`（1424，Bearer token 自动带；in-task 由 daemon 注入的 `MULTIREMI_SERVER_URL`/`MULTIREMI_TOKEN` 生效）。
- list 的 table 输出照 `printAgentCollection`（1473）用 `printTable`+`extractList` 写 `printProjectDocCollection`：列 SLUG/KIND/TITLE/PINNED/VERSION/UPDATED。
- help 文本（~1732-1760 区域）加 memory/wiki 段。
- workspace 级 list/search 不传 `--project`；read/write/delete/history 必须传 `--project`。

## 6. Daemon 注入（packages/daemon/src/…）

- `contracts/types.ts`：`AgentTask` 增加 `projectDocs?: AgentTaskProjectDocsIndex | null; project_docs?: … | null;`（daemon 契约是结构对齐的本地副本，双写 camel/snake 照 sessionProjection 先例）。Entry 结构对齐 §2（snake 双写）。
- `packages/server/src/worker/client.ts` `normalizeDaemonClaimTask`：加 `projectDocs: normalizeDaemonClaimProjectDocs(raw.project_docs ?? raw.projectDocs)`（归一 entry 字段 snake→camel，非数组给 null）。【注：此文件属 Agent B 所有权，B 按本条实现】
- `prompts/ephemeral.ts`：在 `if (task.project)` 块内、资源列表之后追加（保持现有 sections.push 风格）：
  - `## Project Memory`：每条 `- <title>` + 若有 body 首行则 `: <body 首行截 200 字符>`。总字符预算 4000，超出截断并追加一行 `(more entries exist — use search)`。无条目则整段省略。
  - `## Project Wiki`：每条 `- <title> (slug: <slug>)` + summary 截 120；预算 2000，超出截断加提示。无页面省略。
  - `## Project Knowledge Commands`（**project 存在就给**，否则 agent 永远学不会第一条）：
    - 读：`remi memory get <slug> --project <projectId>` / `remi wiki get <slug> --project <projectId>`；搜：`remi memory search "<query>" --project <projectId>`
    - **写回纪律（Karpathy 整合式维护，替代旧版"追加式"指引）**：完成任务若学到跨 issue 复用的持久事实（构建命令、架构决策、坑）——(1) 先 search 查有没有相关条目；(2) 有相关条目 → `memory update` 或 `wiki update` 整合修订；(3) 确属新知识 → `remi memory create`；(4) 沉淀成体系的理解 → `remi wiki create`；(5) 写入时用 --ref 引用来源，页面间用 [[slug]] 互链；(6) 不要记录一次性细节。
    - **schema 注入**：`projectDocs.schema` 存在时，在本段末尾附 `Maintenance rules for this project's wiki (from _schema):` + schema body（已截 1500），并注明可用 `doc update <projectId> _schema` 修订规则。
- 读取顺序不动其他 section，将新段放在 Project Context 与 Available Repositories 之间。

## 7. 前端（frontend/，只读消费）

- `packages/core/api/schemas.ts`：`projectDocSchema`（snake_case 字段 + `parseWithFallback` 惯例，tags 容错 []、pinned 容错 false）；schemas.test.ts 加畸形样本测试（缺字段/错类型/null 数组——CLAUDE.md 硬要求）。
- `packages/core/api/client.ts`：`listProjectDocs(projectId, {kind?, q?})`、`getProjectDoc(projectId, ref)`、`listProjectDocRevisions(projectId, ref)`。
- 新域 `packages/core/project-docs/`：`queries.ts`（key 带 wsId：`["project-docs", wsId, projectId, …]`）+ `index.ts` barrel + queries.test.ts；package.json exports 若需照 chat/issues 先例补。
- `packages/core/realtime/use-realtime-sync.ts`：`project_doc:created|updated|deleted` → invalidate `["project-docs", wsId, project_id]`（照 project_resource/issue 事件先例；有事件名 union/schema 一并扩）。
- `packages/views/projects/components/wiki/`：
  - `project-wiki-section.tsx` — 入口：project-detail 内容区顶部加轻量切换（照库内已有 tab 先例；若无合适 tab 原语，用本地 state 的分段控件），Issues | Wiki 两态，默认 Issues，**不改路由**。
  - 左列列表：顶部固定「Agent Memory」节点 + 下方 wiki 页列表（title，按 updated_at DESC）。
  - 右区：wiki 页 → 只读 markdown（复用 issue 描述/评论的现成渲染组件）+ 页脚「最后更新 by <ActorAvatar+名字> · 时间 · v<version>」；Memory 节点 → 卡片流：title、body、作者、pinned 徽标、出处（source_issue_id 存在 → 链到 issue，用现有 issue 链接 helper）。
  - **refs 徽章**：doc 的 refs 渲染成小徽章行——type=issue/task 链到对应详情页（用现有 path helper；task 无独立页则链所属 issue 或仅展示 id），type=url 外链，其余纯文本。
  - **[[slug]] 内链**：渲染前把 body 中的 `[[slug]]` 转成指向同项目 wiki 页的内链（渲染器不便扩展时允许降级为高亮 chip + onClick 切换选中页，写进组件测试）。
  - `_schema` 页当普通 wiki 页展示（标题 Wiki Schema），无特殊 UI。
  - 空状态：现有 empty-state 模式 + 文案「还没有知识条目——把项目交给 agent 干活，或用 CLI 写入第一条」。CTA 按钮不做（Phase 2）。
- locales：en/ja/ko/zh-Hans 四语齐补，放 projects 命名空间（`wiki.*` 键）。
- 组件测试：照 project-resources-section.test.tsx 的 mock/QueryClient 装置写 wiki section 渲染测试（列表、memory 卡、空态）。

## 8. 文件所有权（并行安全边界，越界 = 违规）

| Agent | 独占文件 |
|---|---|
| A 后端底座 | packages/contracts/src/types.ts、packages/server/src/store/{store.ts,migrations.ts}、tests/unit/multiremi/multiremi-project-docs.test.ts |
| B API+CLI（A 完成后串行） | packages/server/src/api/api.ts、packages/server/src/worker/client.ts、apps/remi/cli/multiremi.ts、tests/unit/multiremi/{multiremi-project-docs-api.test.ts,multiremi-project-docs-cli.test.ts} |
| C daemon（与 A 并行） | packages/daemon/src/contracts/types.ts、packages/daemon/src/agent-runtime/prompts/ephemeral.ts、daemon prompt 测试文件（放 tests/unit/ 下按现有 daemon 测试位置） |
| D 前端（与 A 并行） | frontend/packages/core/{api/schemas.ts,api/schemas.test.ts,api/client.ts,project-docs/**,realtime/use-realtime-sync.ts,realtime/index.ts,types/**}、frontend/packages/views/projects/**、frontend/packages/views/locales/** |

公共约束：树上有**与本特性无关的未提交改动**，只允许 Edit 增量修改自己名下文件，严禁 git checkout/reset/stash/commit，严禁「顺手改」他人文件；发现契约冲突回报编排者，不自行改契约。

## 8.5 已核实的装置与链路事实（构建 agent 直接采用，勿再自行发明）

- **测试装置**（共用装置统一从 `tests/unit/multiremi/helpers.ts` import，范式见 `tests/unit/multiremi/multiremi-api-issues.test.ts`）：`createStore()` 起 `:memory:` 的 `MultiremiStore`；API 测试用 `createMultiremiApp`（`@multiremi/api.js`）+ `app.request()`；member 鉴权用 `signTestJwt(payload)`（HS256，dev secret `multiremi-dev-secret-change-in-production`）；`mockFetch`/`jsonResponse` helper 现成。`buildTaskPrompt` 从 `@multiremi/prompt.js` 导出，已在 `multiremi-project-docs-prompt.test.ts` / `multiremi-issue-sessions.test.ts` 被测——daemon 注入断言可直接加在那里或新建同装置文件。
- **任务内 CLI 鉴权链路**（已核实 packages/daemon/src/agent-runtime/env/injector.ts:29-41）：daemon 给 agent 子进程注入 `MULTIREMI_SERVER_URL` + `MULTIREMI_TOKEN`（task.authToken）+ `MULTIREMI_TASK_ID` + `MULTIREMI_WORKSPACE_ID` + `MULTIREMI_AGENT_NAME` + `MULTIREMI_DAEMON_PORT`。CLI 侧 `multiremiApiConnection` 自动消费 SERVER_URL/TOKEN。**结论：`remi memory/wiki` 子命令零额外鉴权工作。**
- **CLI 帮助文本**：showHelp 在 multiremi.ts:1712-1806，issue metadata 行(1757-1760)之后加 project doc 段。
- **前端 query key 风格**（frontend/packages/core/issues/queries.ts:18-89）：`export const projectDocKeys = { all: (wsId) => ["project-docs", wsId] as const, list: (wsId, projectId) => [...all, projectId] as const, detail: (wsId, projectId, ref) => [...] }`，PREFIX 用于 invalidation / FULL KEY 用于 queryOptions 的注释惯例照抄。
- **claim 归一**：packages/server/src/worker/client.ts:306-375 `normalizeDaemonClaimTask` —— B 在此加 `projectDocs` 归一（照 normalizeDaemonClaimProjectResources:437 的形状写 normalizeDaemonClaimProjectDocs）。
- **daemon 契约**：packages/daemon/src/contracts/types.ts 是结构对齐的本地副本（依赖倒置，L2 不 import L3）；`AgentTask` 加 `projectDocs?/project_docs?` 双写，`AgentTaskProjectDocsIndex`/`AgentTaskProjectDocEntry` 新接口放 AgentTaskProjectResource 附近。

## 9. 验收标准

1. `bun test tests/unit/multiremi/multiremi-project-docs*.test.ts` 全绿（A/B 的新测试）。
2. daemon prompt 测试绿：含「有 memory/wiki 时注入两段 + 指令段」「无 project 不注入」「预算截断」三类断言。
3. `cd frontend && bun run test` 无新增失败（schemas 畸形样本 + queries + wiki section 组件测试绿）。
4. `bun test tests/unit/multiremi/` 全套相对基线无新增失败；前端同理。
5. 手工链路（验收人跑）：store 建 doc → API list/get → CLI create/get → getTaskWithAgent 带出 projectDocs → buildTaskPrompt 出现 Project Memory 段。
6. Karpathy 修订项：首次建 doc 自动播种 `_schema`（且 wiki 索引不含它、schema 字段带它）；refs 全链路（CLI --ref → API → store → 前端徽章）；prompt 含整合式写回纪律 + schema 附文；前端 [[slug]] 内链（或降级 chip）有测试。

## 10. Phase 2 备忘（本期不做）

- **librarian lint**（对齐 Karpathy lint）：矛盾检测（页面间冲突声明）、过时检测（新来源推翻旧条目）、孤儿页（无入链）、缺页（被 [[引用]] 但不存在）、memory→wiki 整合压缩。触发：task 完成后或定时。
- 反链图 / orphan 可视化；wiki 物化进 task workdir（对齐 skills 物化）；project_ref 知识继承；FTS/向量检索（qmd 式混合检索）；审核队列。
