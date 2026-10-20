# ADR 0023: 每轮只给新输入，会话设定写进 provider 的 AGENTS.md

- 状态：已接受（用户决定「Chat 原汁原味，用 AGENTS.md」，终版设计由编排者与用户对齐，2026-10-18）。已实现；本 ADR 不代表已部署，也不代表 daemon 已升级。
- 修订 [ADR 0013](0013-deliverable-is-comment-wakeup-is-doorbell.md)「任务会话输入」一条的 prompt 形状：触发消息、未读范围和读取命令不再拼进带标题的提示词，未读部分只剩一句话（决策 4）。范围记录、`complete` 标记和输入回执规则不变。
- 修订 [ADR 0016](0016-unified-message-inbox-and-turn.md) 决策 3 的「新的轮输入由消息 seq 范围决定」：范围仍是轮的业务输入，此外每个尝试记录实际发出的那段文字和当时的会话设定（决策 7）。
- 继承 [ADR 0020](0020-chat-follow-up-queue-and-native-steering.md) 的插话通道与 [ADR 0022](0022-background-tasks-keep-alive-on-demand.md) 的驻留进程：插话也只是新输入（决策 4）；驻留进程的接手指纹包含会话设定文件（决策 2）。
- 编号：main 上最后一份为 0022，本 ADR 取 0023。

## 背景

在此之前，daemon 每一轮都把一整份提示词交给 provider：`# Bootstrap Prompt` 或 `# Delta Prompt` 标题、`## Current Request`（带 `[seq · 作者 · kind]` 标签的消息）、`## Current Turn`（轮和尝试 id、输入 seq 区间）、工作区与 Runtime 工作区说明、每轮都重复的 Chat 附件契约、bootstrap 时的 Remi Context、项目与仓库说明、Agent instructions、全文内联的 Skill，以及 `## Output`。Issue 模式还在每轮拼上 Issue、执行与升级规则、回复评论的配方等。

这带来三个问题：

1. **Chat 不像直接用 Claude Code 或 Codex。** 用户说「你好」，agent 收到的是一份带标题的任务单，常常先跑 `remi message list` 再回答。
2. **固定内容只在 bootstrap 出现一次。** 它们进入对话历史，压缩后可能丢失；provider 会话重开时又整段重发。delta 轮另有一套「Delta Instructions」，工作区和 Project 各要维护两份提示词。
3. **默认交付契约存在工作区设置里。** 读取时缺省返回代码默认值，设置页保存后默认值被冻结进数据库，以后改代码默认值不再生效。

## 决策

1. **两部分。** 每个尝试由 [buildTaskPromptArtifact](../../packages/daemon/src/agent-runtime/prompts/ephemeral.ts) 产出两样东西：`instructions` 是会话里不变的内容，写进 provider 自己的指令文件；`prompt` 是本轮新输入，也是唯一发给 provider 的文字。Chat 和 Issue 都不再区分 bootstrap 与 delta。provider 会话是新开还是续接只作为事实记录在 prompt 记录的 `mode` 里，不改变内容。

2. **指令文件。** daemon 在每次启动 provider 之前写会话 provider home 里的 `AGENTS.md`：Claude 是 `CLAUDE_CONFIG_DIR`，Codex 是 `CODEX_HOME`，Antigravity 是 `GEMINI_HOME`。
   - Claude 只读配置目录里的 `CLAUDE.md`，单独放 `AGENTS.md` 会被忽略，因此再写一个只有 `@AGENTS.md` 的 `CLAUDE.md`。Antigravity server 不读这个文件，由 adapter 在新建、加载、续接会话时把它追加到系统提示词。
   - 只写 daemon 自己的 provider home，从不写用户的工作目录或本地项目目录。文件先写临时文件再改名替换，内容没变就不写。第一行是 Remi 的标记注释；内容为空时只删除带这个标记的文件，不碰别人的文件；遇到软链接或硬链接一律拒绝写入。
   - 全文上限 48 KiB：Runtime 工作区本地上下文仍限 24 KiB，Remi 的部分最多 32 KiB。超出时先截短用户自己写的部分（Agent instructions、工作区提示词、Issue 描述、Project 说明等），每段截短处写明读取全文的命令。
   - 实测（claude-agent-acp 0.91.0 / Claude Code 2.1.301，codex-acp 2.2.2 / codex 0.163.0）：Claude 在一个进程内固定使用启动时读到的指令，在新进程续接时读到修改。Remi 每轮新开进程续接，所以下一轮就能看到。Codex 每轮都重新读 `$CODEX_HOME/AGENTS.md`，同一进程内和续接后都会读。PR 6 驻留的进程不重读，因此驻留接手的启动指纹包含这份文件的哈希，文件变了就换新进程。

3. **`AGENTS.md` 的内容**，按以下顺序：
   - **(a) Agent 的定义**：名字、简介（新增的 offer 字段 `agent.description`）和 instructions。
   - **(b) Remi 的说明**，即原 bootstrap 提示词里所有固定内容：
     - 身份和输入方式，包括标签与未读说明的含义。
     - `remi` CLI：`remi context`、`remi message list <会话>`，以及 Chat 的项目、仓库检出说明。
     - 交付契约：有代码工作时加代码交付契约；附件交付契约 Chat 用 Chat 版，Issue 用 Issue 版。它们原是工作区提示词的默认值，现在是 Remi 的规则。
     - 工作区提示词、工作区背景、会话所有者（Chat 的创建人，否则是 Runtime 的所有者；offer 新增 `session_owner_name` 和 `session_owner_profile_description`）、Runtime 工作区、自动化。
     - Issue 会话加入：Issue 标题、描述、附件和元数据；回复评论的配方（模板，评论 id 由每轮输入给出）；结果分享；历史目录；后续 Issue；执行与升级规则；共享工作区与小队协作。绑定 Issue 的飞书话题、旁支会话（继承范围的读取命令和边界）、只读快照各加对应的段落。
     - Project、知识与仓库的警告，可用仓库。
   - `AGENTS.md` 不放任何 Skill，既没有全文也没有索引；也不放每轮会变的事实（本轮发送人、仓库和知识的可用性、绑定 Issue 的状态），否则驻留的 PR 6 进程会因文件哈希变化被释放。
   - Runtime 工作区的本地上下文（工作区根到工作目录的指令文件、登记的上下文路径、工作区自带的 Skill 目录）只在本机拼在 Remi 部分之后，从不上传服务端。不再读取用户级的 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` 和个人 Skill 目录：Agent 的定义不应取决于在谁的机器上跑。
   - PM 等依赖 Issue 模式的 agent：内容与原来相同，只是从每轮提示词移到了 `AGENTS.md`。

4. **本轮输入**（[turn-input.ts](../../packages/daemon/src/agent-runtime/prompts/turn-input.ts)）只有新东西：
   - **消息正文。** 私有 Chat 只在需要时加标签：多个成员、有其他 agent、或 Remi 自己发的通知（`[Remi]`，例如后台任务门铃）。一对一时就是用户输入的原文。Issue、绑定 Issue 的话题和旁支会话总是带作者标签，例如 `[Alice]`、`[Member <id>]`、`[Agent <id>]`。
   - **未读说明。** 未读部分没有全部内联（有消息只列出没给正文、正文被折叠、来自更早的历史）时，加一句话：`(N earlier unread messages aren't shown here. Read them before you answer: \`remi message list …\`)`。服务端的输入回执要求读过这些消息，所以这一句不能省。
   - **每轮变化的事实，各占一行：**
     - Issue 评论：`(Reply to comment <id>: …)`。
     - 绑定 Issue 的新日志条数、本轮开始时的状态和读取命令。
     - 自动化的触发载荷。
     - 发送人不是会话所有者时（飞书群里的其他成员），消息带发送人标签，需要时再加一行发送人简介 `(About <name>: …)`。
     - 仓库准备失败、缓存过期或用了回退分支时一行 `(Repository warnings, diagnostic only: …)`；知识不可用时一行 `(Knowledge warnings: …)`。
   - **附件。** 每个文件一行，写本地路径或下载命令。图片在 bridge 声明 `promptCapabilities.image` 时另以 ACP image block 随首个 prompt 发送，pinned 的 Claude 与 Codex bridge 都支持。
   - **插话**用同样的规则：只是消息正文和标签，原来的「[Mid-run user steering]…」框架去掉。「立即交付」仍保留它的控制说明。

5. **Skill 只走原生加载。**
   - daemon 每轮把 Agent 的 Skill 同步到 provider 自己会找的目录：
     - daemon 自己的执行目录：Claude 用 `.claude/skills`，Codex 用 `.agents/skills`。
     - 工作目录是用户自己的文件夹时（Runtime 工作区、Project 的 `local_directory`），Skill 写到 provider home：Claude 的 `CLAUDE_CONFIG_DIR/skills`，Codex 的 `CODEX_HOME/skills`，清单也在那里，用户文件夹里不出现任何 Skill 文件。离线核对：codex 0.163 的 app-server `skills/list` 把 `CODEX_HOME/skills` 里 Remi 写的 Skill 列为 user scope、已启用、无错误。
     - Antigravity 保持原来的 `.agents/skills`。
   - 每个 Skill 整体重写；Agent 不再拥有的 Skill 按清单 `.remi-skills.json` 删除。只写入、只删除 Remi 创建并记入清单的目录：目录里原有的同名 Skill（provider 自带、agent 或用户自己的）原样保留，Remi 的同名 Skill 不装。
   - [ADR 0025](0025-chat-slash-commands.md) 决策 7 修订：Remi 生成的 `SKILL.md` 的 `name` 写目录名而不是平台上的显示名，`/目录名`（Codex 是 `$目录名`）就能调用；名字含非 ASCII 字符的 Skill 目录名带上名字的短哈希，原名写在 `description` 开头。
   - Codex 0.163 总会加载用户的 `$HOME/.agents/skills`，没有关闭整个目录的开关。因此会话 `config.toml` 每次启动都按路径为其中每个 Skill 写 `[[skills.config]] enabled = false`，`HOME` 不变。

6. **工作区与 Project 的提示词各合成一份。**
   - **工作区提示词**改存 `settings.prompt_appendix`，只保存工作区自己的文字，上限 16,002 字符：两段原各 8,000 字符，加上合并时中间的空行。旧的 `prompt_bootstrap_appendix` 和 `prompt_delta_appendix` 由迁移 `20261019_merge_prompt_halves` 合并：bootstrap 在前，空一行，再接 delta；以旧默认值开头的 bootstrap 只保留其后的部分。
   - 两个旧键继续保存，内容为「旧默认值 + 自定义文字」和空字符串，供回滚后的旧镜像读取。
   - API `/api/workspaces/:id/prompts` 读写 `{ prompt, revision, updatedAt, updatedBy }`，仍接受旧字段并把它们合并成一份；只发一半时另一半取自存着的旧键。响应同时带旧网页读取的 `bootstrapPrompt`（旧默认值加自定义文字）和空的 `deltaPrompt`，API 先部署时旧网页照常可用。
   - offer 新增 `workspace_prompt`，只含自定义文字，总是发送。旧 daemon 读 `workspace_bootstrap_prompt`，现在它等于旧默认值加自定义文字；不再发送 `workspace_delta_prompt`。新 daemon 遇到不发 `workspace_prompt` 的旧服务端，会合并收到的两份提示词，并去掉旧默认值前缀。
   - **Project**：同一迁移把 `delta_instructions` 追加到 `instructions` 后清空，列本身保留，上限改为 8,002 字符（两段原各 4,000 字符，加上中间的空行），迁移合并出的最长文字仍能编辑保存。写入接口仍接受 `delta_instructions` 并把它追加进去；追加后超过上限时返回 400。

7. **记录实际发出的内容。**
   - `task.prompt` 上报新增 `instructions`，即 Remi 那部分 `AGENTS.md`，Runtime 工作区本地上下文不在其中。它存入 `multiremi_task_prompts.instructions`（迁移 `20261019_task_prompt_instructions`，可空）。
   - `GET /api/turns/:id?input=true[&attempt=<id>]` 的 `input` 新增 `sent_attempt_id`、`sent_prompt`、`instructions`。
   - trace 的输入 `user_message` 和插话 `user_message` 记录 provider 实际收到的文字，不再是带范围记录的正文。
   - 「输入 Prompt」页显示本轮实际发出的内容和期间的插话，并把 `instructions` 放在可展开的「会话设定」里。

8. **清理不再使用的代码。**
   - 服务端为 offer 构建会话投影时只算边界和模式（`boundsOnly`），不再拼出随后会被未读范围记录覆盖的完整历史 JSONL。
   - 删除只为被清空而计算的已发布结果、只在没有 offer 输入时才有用的 `chat_message`，以及会被剥掉的 `response.prompt` 重写。
   - 删除 daemon 里已不可达的完整历史与 Inbox 渲染。
   - 删除过时的「Write the summary from the log」说明。

## 未采用的方案

- **用系统提示词承载会话设定。** 只有 Claude 的桥有这个通道，Codex 没有，只能依赖 `AGENTS.md`。两家走同一个文件，行为才一致。
- **保留 bootstrap 提示词，只把 Chat 改成原文。** 固定内容仍然只出现一次，压缩后可能丢失，Issue 与 Chat 是两套形状，工作区和 Project 仍要维护两份提示词。
- **在用户工作目录写 `AGENTS.md`。** 这会改动用户的仓库或本地文件夹，并发会话之间也会互相覆盖。
- **改 `HOME` 来避开 Codex 的个人 Skill。** 这会改变 agent 运行的所有工具的家目录，按路径禁用影响最小。

## 影响与回滚

- Codex 每轮都重读 `AGENTS.md`，文件越大，每轮占用的上下文越多。所以 Remi 部分限 32 KiB，并优先截短用户自己写的部分。
- 飞书群话题里的不同发送人在会话日志里都是 `member`，sender id 为空或是 owner，没法逐人加名字标签。名字只有本轮请求人那一个，写在 `AGENTS.md` 里。
- Codex 的个人 Skill 只是被禁用：它们仍出现在 `skills/list` 里，状态为 disabled，文件也仍然可读；新增的个人 Skill 要到下一轮配置重建后才被禁用。
- 绑定 Issue 的新日志条数沿用服务端的未读定义，不计 agent 自己写的条目。话题协调者同时是 Issue 执行者时，一轮只有它自己的条目就不会出现这一行；转述通知（`<KEY> 有新日志：…`）仍会到达。
- 升级之前创建的 provider 会话历史里还留着当时的 bootstrap 提示词，内容与 `AGENTS.md` 有重叠，不影响正确性。
- 回滚：撤销实现提交即可。新列可以保留，旧镜像会忽略。工作区的两个旧提示词键一直保持更新，所以旧镜像仍看到原来的值。Project 已合并的说明在旧镜像里只作为 bootstrap 说明出现。
- 回滚后在旧镜像里改过、再升级：工作区设置记下 `prompt_appendix` 是在哪个修订写入的（`prompt_appendix_revision`），旧镜像只会改两个旧键并增加 `prompt_revision`，修订更新时就重新从旧键合并。Project 读取时把旧镜像写下的 `delta_instructions` 并入 `instructions`，下一次保存写成一份并清空它，不计为一次说明修改。

## 实现

- [prompts/ephemeral.ts](../../packages/daemon/src/agent-runtime/prompts/ephemeral.ts)、[prompts/turn-input.ts](../../packages/daemon/src/agent-runtime/prompts/turn-input.ts)
- [workspace/runtime-context.ts](../../packages/daemon/src/agent-runtime/workspace/runtime-context.ts)（`writeProviderInstructions`）、[skills/ephemeral.ts](../../packages/daemon/src/agent-runtime/skills/ephemeral.ts)（`syncAgentSkills`）、[workspace/session-home.ts](../../packages/daemon/src/agent-runtime/workspace/session-home.ts)（Codex 个人 Skill）
- [worker/daemon.ts](../../packages/server/src/worker/daemon.ts)、[worker/steer.ts](../../packages/server/src/worker/steer.ts)、[acp/provider.ts](../../packages/acp/src/provider.ts)（按能力发送图片）
- [contracts/remi-rules.ts](../../packages/contracts/src/remi-rules.ts)、[prompts/workspace-settings.ts](../../packages/server/src/prompts/workspace-settings.ts)、[store/migrations.ts](../../packages/server/src/store/migrations.ts)
- [协议细节](../daemon-protocol-v2.md)
