# Remi ACP 迁移 — Phase 1 交接文档

## 一、已完成的工作

### 1. ACP Provider 核心代码（全部完成，type check 通过）

新建文件：
- `src/providers/acp/protocol.ts` — ACP JSON-RPC 消息类型定义
- `src/providers/acp/client.ts` — ACP JSON-RPC 2.0 客户端，管理子进程 stdio 通信
- `src/providers/acp/event-mapper.ts` — ACP session/update 事件 → Remi StreamEvent 映射
- `src/providers/acp/provider.ts` — AcpProvider，实现 Provider 接口，session 池管理
- `src/providers/acp/index.ts` — 导出

### 2. 适配层（支持多 agent）

新建文件：
- `src/providers/acp/adapters/base.ts` — AgentAdapter 接口定义
- `src/providers/acp/adapters/claude.ts` — Claude 专属适配（meta 解析、tool name 解析、input 重建）
- `src/providers/acp/adapters/codex.ts` — Codex 适配 stub（未来实现）
- `src/providers/acp/adapters/index.ts` — createAdapter() 工厂函数

### 3. 集成修改

修改文件：
- `src/core.ts` — `_buildProvider()` 支持 "acp" / "acp:claude" / "acp:codex"，`_getProvider()` 已有 prefix matching（"acp" 匹配 "acp:claude"）
- `~/.remi/remi.toml` — provider name 改为 "acp"
- `src/connectors/feishu/index.ts` — _formatStats 去掉 emoji 前缀、加 cost 显示、token 单数字兼容
- `src/connectors/feishu/streaming.ts` — iconMap 扩展 money_outlined、process panel 纯 thinking 不显示

### 4. Smoke Test 结果

`tests/acp-e2e.ts` 直接调 AcpProvider 已通过：
- ACP 进程启动 ✅
- initialize + session/new ✅
- prompt 发送 + 流式响应接收 ✅
- thinking_delta + content_delta 事件 ✅
- usage_update（cost）✅
- 响应文本正确（"Hello, Jack!"）✅

飞书端对端基本通过（Remi daemon 用 ACP provider 启动成功，收到用户消息并回复），但卡片显示有问题。

---

## 二、已知问题（待修复）

### 问题 1：Tool 步骤没有描述

**现象：** 飞书卡片步骤面板只显示 "Bash (50.7s)"，没有命令内容。旧版显示 "Bash `$ bun run tests/...`"

**根因推测：** ACP 的 tool_call 事件的 rawInput 字段可能为空或格式不符预期。Claude adapter 的 extractToolInput 先检查 rawInput，为空时 fallback 到 title/content/locations 重建。

**已做的修复：**
- claude adapter 的 extractToolInput 现在处理 rawInput 为 string 的情况（JSON.parse）
- 加了 title fallback：Bash 用 title 作为 command，Read 用 locations 的 path，Agent 用 title 作为 description
- 加了 debug 日志：REMI_DEBUG=1 时会打印 tool_call 的 rawInput 和 keys

**待验证：** 跑 `REMI_DEBUG=1 bun run tests/acp-e2e.ts`，看 `[event-mapper] tool_call:` 日志中 rawInput 的实际值。如果 rawInput 有值但没被正确提取，需要调整 adapter；如果 rawInput 确实为空，title fallback 应该已经生效。

### 问题 2：Stats Bar 显示异常

**现象：** 新版显示 "7.7s ⓐ 39962 $0.07"，旧版显示 "19.1s ⓐ 11→352 1 tools"

**根因：**
- ACP 的 usage_update 只给 `used`（总 token 数）和 `size`（context window），没有分开的 inputTokens/outputTokens。所以无法显示 "in→out" 格式
- toolCalls 和 durationMs 之前没填进 AgentResponse

**已做的修复：**
- event-mapper: MapperState 新增 completedTools 数组和 promptStartTime
- provider: buildAgentResponse 现在计算 durationMs 和 toolCalls
- _formatStats: outputTokens 为 0 时只显示总数，不显示 "→?"
- _formatStats: 去掉 emoji 前缀（避免跟 streaming.ts 的 iconMap 冲突）
- streaming.ts: iconMap 扩展第 4 列 "money_outlined" 给 cost

**待验证：** 重启 Remi 后检查 stats bar 是否正确显示 duration、tokens、tool count、cost

### 问题 3：纯 thinking 回复显示空 Process Panel

**现象：** 没有工具调用的简单回复显示 "Show 1 steps"，里面只有 thinking 文本

**已做的修复：** streaming.ts buildFinalCard 里，stepCount 为 0 且没有 tools/steps 时跳过 collapsible_panel

**待验证：** 重启后发一条简单问候，确认不再显示 process panel

---

## 三、ACP 协议关键信息

### 协议文档

- 官方站点：https://agentclientprotocol.com
- SDK 类型定义（本地）：`~/.npm-global/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`（完整 TypeScript 类型，39000+ tokens）
- SDK 版本：@agentclientprotocol/claude-agent-acp@0.31.4

### initialize 请求格式

```json
{
  "protocolVersion": 1,
  "clientInfo": { "name": "remi", "version": "0.1.0" },
  "clientCapabilities": {
    "_meta": { "terminal_output": true },
    "fs": { "readTextFile": true, "writeTextFile": true }
  }
}
```

注意：字段是 `protocolVersion`（数字 1）和 `clientCapabilities`（不是 capabilities）。

### session/new 请求格式

```json
{
  "cwd": "/data00/home/hehuajie",
  "mcpServers": []
}
```

`mcpServers` 是必填字段，至少传空数组。

### session/prompt 请求格式

```json
{
  "sessionId": "xxx",
  "prompt": [{ "type": "text", "text": "用户消息" }]
}
```

注意：字段是 `prompt`（ContentBlock 数组），不是 `message: { role, content }`。

### session/update 通知（tool_call）

```json
{
  "sessionId": "xxx",
  "update": {
    "sessionUpdate": "tool_call",
    "toolCallId": "xxx",
    "title": "echo hello",
    "kind": "execute",
    "status": "pending",
    "rawInput": { "command": "echo hello", "description": "..." },
    "content": [{ "type": "terminal", "terminalId": "xxx" }],
    "locations": [],
    "_meta": { "claudeCode": { "toolName": "Bash" } }
  }
}
```

关键字段：
- `_meta.claudeCode.toolName` — Claude 专属，真实工具名
- `rawInput` — 工具原始输入参数（应该有值，但需验证）
- `title` — 人类可读描述（Bash 的 title 是命令内容）
- `content` — 结构化内容（diff、terminal、text）
- `locations` — 文件位置（Read/Edit/Write）

### usage_update 格式

```json
{
  "sessionUpdate": "usage_update",
  "used": 39962,
  "size": 1000000,
  "cost": { "amount": 0.07, "currency": "USD" }
}
```

注意：没有分开的 inputTokens/outputTokens，只有总 `used`。

---

## 四、配置说明

### remi.toml

```toml
[provider]
name = "acp"              # "acp" 或 "acp:claude" 或 "acp:codex"
# executable = ""         # ACP 二进制路径（默认自动检测）
# model = "claude-opus-4-7"
# api_key = "sk-..."      # 用 API Key 认证（不用订阅）
```

### 切回旧 provider

把 `name = "acp"` 改回 `name = "claude_cli"` 即可回退。

---

## 五、调试方法

1. 启动时加 `REMI_DEBUG=1` 查看 ACP 通信日志
2. `tests/acp-e2e.ts` 是独立的 smoke test，不需要飞书连接
3. ACP 子进程的 stderr 会打印 claude-agent-acp 的内部日志
4. event-mapper.ts 在 tool_call 事件时有 debug 日志，会打印 rawInput 和 keys

```bash
# 跑独立测试
cd /data00/home/hehuajie/project/remi && REMI_DEBUG=1 bun run tests/acp-e2e.ts

# 启动 daemon（带 debug）
REMI_DEBUG=1 bun run src/main.ts serve

# 回退到旧 provider
# 编辑 ~/.remi/remi.toml，把 name = "acp" 改为 name = "claude_cli"
```

---

## 六、下一步

1. **跑 debug 测试** — 确认 rawInput 的实际值，修复 tool desc
2. **重启 Remi** — 验证三个修复（stats bar、process panel、tool desc）
3. **完整飞书端对端测试** — 发消息触发工具调用，验证卡片显示与旧版一致
4. **Phase 2** — Session 层统一 + 交互持久化（见原方案文档）

---

## 七、相关文档

- 原方案文档：https://bytedance.larkoffice.com/docx/XFTjdXAd5oxzqNxh6bqcq1VQnVd
- ACP 协议官方文档：https://agentclientprotocol.com
- Claude Agent SDK 文档：https://code.claude.com/docs/en/agent-sdk
