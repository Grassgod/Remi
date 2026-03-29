# Conversations Module Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Dashboard conversations module by porting Board's proven JSONL parsing logic, extracting shared code, and fixing all identified bugs.

**Architecture:** Extract JSONL parsing into a shared module `src/conversation/parser.ts` that both Board server and Dashboard handler consume. Fix 7 identified bugs in the Dashboard handler. No frontend structural changes needed — only fix null-safety issues in the existing component.

**Tech Stack:** TypeScript, Bun, Hono, SQLite (bun:sqlite), React

---

## Bug Analysis (Board vs Dashboard)

| # | Bug | Board (correct) | Dashboard (broken) |
|---|-----|-----------------|-------------------|
| 1 | **Timestamp not parsed** | `new Date(obj.timestamp).getTime()` → Unix ms | `obj.timestamp ?? 0` → raw ISO string |
| 2 | **Text blocks overwritten** | `currentText += "\n\n" + b.text` (concat all) | `currentText = b.text` (last wins) |
| 3 | **Thinking not merged into tools** | Merges preceding thinking into tool's `thinking` field | Thinking/tools separate, no merge |
| 4 | **Meta matching by index** | `findClosestMeta(pairTs)` with ±30s window | `metaRows[i]` sequential (breaks on mismatch) |
| 5 | **StepItem missing `thinking` field** | `thinking?: string` on interface | Field missing |
| 6 | **Topic is truncated chatId** | N/A (uses mission title) | `chat_id.slice(0, 8)` — meaningless |
| 7 | **No thread_id grouping** | Filters by threadId | `GROUP BY chat_id` only |

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/conversation/parser.ts` | **Create** | Shared JSONL parsing: `parseSessionPairs()`, `findSessionJsonl()`, `stripContextTags()`, `findClosestMeta()`, `buildChatMessages()` |
| `web/handlers/conversations.ts` | **Modify** | Import shared parser, fix list API (topic + thread grouping), fix messages API |
| `web/board/server.ts` | **Modify** | Replace inline JSONL parsing (L133-365) with shared parser import |
| `web/frontend/src/api/types.ts` | **Modify** | Add `thinking?: string` to `StepItem` |
| `web/frontend/src/pages/Conversations.tsx` | **Modify** | Fix null-safety in meta display |

---

### Task 1: Create shared conversation parser module

**Files:**
- Create: `src/conversation/parser.ts`

This extracts Board's proven logic from `web/board/server.ts` L133-365 into a reusable module.

- [ ] **Step 1: Create `src/conversation/parser.ts` with all types and functions**

```typescript
/**
 * Shared conversation parser — reconstructs chat messages from JSONL session files + DB metadata.
 * Used by both Dashboard API and Board API.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionName } from "../connectors/feishu/session-name.js";

// ── Types ──────────────────────────────────────────────

export interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
  thinking?: string;  // merged thinking before tool (if type=tool)
}

export interface ConvPair {
  userText: string;
  remiText: string;
  steps: StepItem[];
  timestamp: number;  // Unix ms
  sessionId: string;
}

export interface ChatMessage {
  id: string;
  type: "text" | "assistant";
  content: string;
  senderType: "user" | "app";
  senderId: string;
  createTime: string;  // Unix ms as string
  steps?: StepItem[];
  sessionName?: string;
  meta?: {
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    duration: number | null;
    toolCount: number;
    sessionId?: string;
  };
}

export interface MetaRow {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  spans: string | null;
  cli_session_id: string | null;
  sender_id: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Strip context/system tags and user name prefix from message text.
 */
export function stripContextTags(text: string): string {
  let t = text;
  t = t.replace(/<context>[\s\S]*?<\/context>/g, "");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  const replyIdx = t.indexOf('[Replying to: "');
  if (replyIdx !== -1) {
    const closeIdx = t.indexOf('"]', replyIdx + 15);
    if (closeIdx !== -1) {
      t = t.slice(0, replyIdx) + t.slice(closeIdx + 2);
    }
  }
  t = t.replace(/^贺华杰:\s*/m, "");
  return t.trim();
}

/**
 * Find the JSONL file for a given CLI session ID across all project directories.
 */
export function findSessionJsonl(sessionId: string): string | null {
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const p = join(CLAUDE_PROJECTS_DIR, dir, sessionId + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/**
 * Parse a JSONL session file into enqueue→assistant conversation pairs.
 *
 * Algorithm:
 * 1. Scan for "queue-operation" + "enqueue" lines (user messages)
 * 2. Collect subsequent "assistant" blocks (thinking, tool_use, text)
 * 3. Merge preceding thinking into tool steps (matches Feishu card behavior)
 * 4. Flush pair on next enqueue or EOF
 */
export function parseSessionPairs(jsonlPath: string, sessionId: string): ConvPair[] {
  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
  const pairs: ConvPair[] = [];

  let currentEnqueue: { content: string; timestamp: number } | null = null;
  let currentText = "";
  let currentSteps: StepItem[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === "queue-operation" && obj.operation === "enqueue" && obj.content) {
        // Flush previous pair
        if (currentEnqueue && (currentText || currentSteps.length > 0)) {
          pairs.push({
            userText: stripContextTags(currentEnqueue.content),
            remiText: stripContextTags(currentText),
            steps: currentSteps,
            timestamp: currentEnqueue.timestamp,
            sessionId,
          });
        }
        // Parse timestamp to Unix ms (Board's proven approach)
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
        currentEnqueue = { content: obj.content, timestamp: ts };
        currentText = "";
        currentSteps = [];
      }

      if (obj.type === "assistant" && currentEnqueue) {
        for (const b of (obj.message?.content ?? [])) {
          if (b.type === "text" && b.text) {
            // Concatenate all text blocks (Claude emits multiple between tool calls)
            currentText += (currentText ? "\n\n" : "") + b.text;
          } else if (b.type === "thinking" && b.thinking) {
            currentSteps.push({ type: "thinking", content: b.thinking.trim() });
          } else if (b.type === "tool_use") {
            // Merge preceding thinking into tool step (matches Feishu card)
            const lastStep = currentSteps[currentSteps.length - 1];
            if (lastStep?.type === "thinking") {
              currentSteps[currentSteps.length - 1] = {
                type: "tool",
                name: b.name ?? "unknown",
                content: b.input?.description ?? b.input?.command?.slice(0, 80) ?? b.input?.file_path ?? "",
                thinking: lastStep.content,
              };
            } else {
              currentSteps.push({
                type: "tool",
                name: b.name ?? "unknown",
                content: b.input?.description ?? b.input?.command?.slice(0, 80) ?? b.input?.file_path ?? "",
              });
            }
          }
        }
      }
    } catch {}
  }

  // Flush last pair
  if (currentEnqueue && (currentText || currentSteps.length > 0)) {
    pairs.push({
      userText: stripContextTags(currentEnqueue.content),
      remiText: stripContextTags(currentText),
      steps: currentSteps,
      timestamp: currentEnqueue.timestamp,
      sessionId,
    });
  }

  return pairs;
}

/**
 * Find the closest metadata row by timestamp within ±30 second window.
 */
export function findClosestMeta(pairTs: number, metaByTime: Array<MetaRow & { _ts: number }>): (MetaRow & { _ts: number }) | null {
  let best: (MetaRow & { _ts: number }) | null = null;
  let bestDist = Infinity;
  for (const m of metaByTime) {
    const dist = Math.abs(m._ts - pairTs);
    if (dist < bestDist) { bestDist = dist; best = m; }
  }
  return best && bestDist < 30_000 ? best : null;
}

/**
 * Build ChatMessage[] from conversation pairs + database metadata.
 *
 * Complete pipeline:
 * 1. For each sessionId, find JSONL → parse pairs
 * 2. Sort all pairs by timestamp
 * 3. Filter to complete pairs (has remiText)
 * 4. Match each pair to closest DB metadata row (±30s)
 * 5. Build user + assistant message objects
 */
export function buildChatMessages(
  sessionIds: string[],
  metaRows: MetaRow[],
): ChatMessage[] {
  // Step 1: Parse all JSONL files
  const allPairs: ConvPair[] = [];
  for (const sessionId of sessionIds) {
    const jsonlPath = findSessionJsonl(sessionId);
    if (!jsonlPath) continue;
    allPairs.push(...parseSessionPairs(jsonlPath, sessionId));
  }

  // Step 2: Sort by timestamp
  allPairs.sort((a, b) => a.timestamp - b.timestamp);

  // Step 3: Filter to complete pairs
  const completePairs = allPairs.filter(p => p.remiText);

  // Step 4: Build metadata lookup
  const metaByTime = metaRows.map(m => ({
    ...m,
    _ts: new Date(m.created_at + "Z").getTime(), // DB stores UTC without Z
  }));

  // Step 5: Build messages
  const messages: ChatMessage[] = [];

  for (let i = 0; i < completePairs.length; i++) {
    const pair = completePairs[i];
    const meta = findClosestMeta(pair.timestamp, metaByTime);
    const createTimeMs = String(pair.timestamp);

    // User message
    if (pair.userText) {
      messages.push({
        id: `user_${i}`,
        type: "text",
        content: pair.userText,
        senderType: "user",
        senderId: meta?.sender_id ?? "",
        createTime: createTimeMs,
      });
    }

    // Remi response
    const toolSteps = pair.steps.filter(s => s.type === "tool");
    let toolCount = toolSteps.length;
    if (meta?.spans) {
      try {
        const spans = JSON.parse(meta.spans);
        const ps = spans.find((s: any) => s.op === "provider.chat");
        if (ps?.tool_count > toolCount) toolCount = ps.tool_count;
      } catch {}
    }

    messages.push({
      id: `remi_${i}`,
      type: "assistant",
      content: pair.remiText,
      senderType: "app",
      senderId: "remi",
      createTime: String(pair.timestamp + 1),
      steps: pair.steps.length > 0 ? pair.steps : undefined,
      sessionName: getSessionName(pair.sessionId),
      meta: meta ? {
        model: meta.model,
        inputTokens: meta.input_tokens,
        outputTokens: meta.output_tokens,
        cost: meta.cost_usd,
        duration: meta.duration_ms,
        toolCount,
        sessionId: pair.sessionId,
      } : undefined,
    });
  }

  return messages;
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bunx tsc --noEmit src/conversation/parser.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/conversation/parser.ts
git commit -m "feat: extract shared conversation parser from Board's proven implementation"
```

---

### Task 2: Rewrite Dashboard conversations handler to use shared parser

**Files:**
- Modify: `web/handlers/conversations.ts`

Fixes all 7 bugs: timestamp parsing, text concatenation, thinking merge, meta matching, StepItem typing, topic naming, thread_id grouping.

- [ ] **Step 1: Rewrite `web/handlers/conversations.ts`**

```typescript
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb } from "../../src/db/index.js";
import { buildChatMessages } from "../../src/conversation/parser.js";
import type { MetaRow } from "../../src/conversation/parser.js";

// ── Handler Registration ──────────────────────────────

export function registerConversationsHandlers(app: Hono, _data: RemiData) {
  // ── GET /api/v1/conversations — List conversations grouped by chat_id + thread_id ──
  app.get("/api/v1/conversations", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
    const db = getDb();

    const rows = db.query(`
      SELECT
        chat_id,
        thread_id,
        COUNT(*) as msg_count,
        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
        SUM(COALESCE(cost_usd, 0)) as total_cost,
        MAX(created_at) as latest,
        MAX(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as has_active,
        MIN(user_message) as first_message
      FROM conversations
      GROUP BY chat_id, COALESCE(thread_id, '')
      ORDER BY latest DESC
      LIMIT ?
    `).all(limit) as {
      chat_id: string;
      thread_id: string | null;
      msg_count: number;
      total_tokens: number;
      total_cost: number;
      latest: string;
      has_active: number;
      first_message: string | null;
    }[];

    const conversations = rows.map((row) => ({
      id: row.thread_id ? `${row.chat_id}:${row.thread_id}` : row.chat_id,
      chatId: row.chat_id,
      threadId: row.thread_id ?? null,
      topic: row.first_message?.slice(0, 60) || row.chat_id.slice(0, 12),
      messageCount: row.msg_count,
      tokenCount: row.total_tokens ?? 0,
      totalCost: row.total_cost ?? 0,
      updatedAt: row.latest,
      status: row.has_active ? "active" as const : "completed" as const,
    }));

    return c.json(conversations);
  });

  // ── GET /api/v1/conversations/:chatId/messages — Reconstruct from JSONL ──
  app.get("/api/v1/conversations/:chatId/messages", (c) => {
    const chatId = c.req.param("chatId");
    const threadId = c.req.query("threadId") ?? null;
    const db = getDb();

    try {
      // Step 1: Get session IDs
      const sessionSql = threadId
        ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC"
        : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC";

      const sessionRows = (threadId
        ? db.query(sessionSql).all(chatId, threadId)
        : db.query(sessionSql).all(chatId)) as { cli_session_id: string }[];

      const sessionIds = sessionRows.map(r => r.cli_session_id);

      // Step 2: Get conversation metadata
      const metaSql = threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";

      const metaRows = (threadId
        ? db.query(metaSql).all(chatId, threadId)
        : db.query(metaSql).all(chatId)) as MetaRow[];

      // Step 3: Use shared parser
      const messages = buildChatMessages(sessionIds, metaRows);

      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
```

- [ ] **Step 2: Verify the handler compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bunx tsc --noEmit web/handlers/conversations.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/handlers/conversations.ts
git commit -m "fix: rewrite conversations handler using shared parser — fixes 7 bugs"
```

---

### Task 3: Migrate Board server to use shared parser

**Files:**
- Modify: `web/board/server.ts` (replace L133-365 inline code with shared parser import)

- [ ] **Step 1: Replace inline JSONL parsing in `web/board/server.ts`**

Replace lines 131-365 (the entire `/api/missions/:id/messages` handler) with:

```typescript
  // ── Messages API — conversation reconstruction via shared parser ──

  app.get("/api/missions/:id/messages", async (c) => {
    const mission = missionStore.getById(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    if (!mission.chatId) return c.json([]);

    try {
      const { getDb } = await import("../../src/db/index.js");
      const { buildChatMessages } = await import("../../src/conversation/parser.js");
      const db = getDb();

      // Get session IDs for this mission's chat thread
      const queryParams = mission.threadId
        ? { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId, mission.threadId] }
        : { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId] };

      const sessionRows = db.query(queryParams.sql).all(...queryParams.params) as any[];
      const sessionIds = sessionRows.map((r: any) => r.cli_session_id as string);

      // Get metadata
      const metaSql = mission.threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";

      const metaRows = mission.threadId
        ? db.query(metaSql).all(mission.chatId, mission.threadId) as any[]
        : db.query(metaSql).all(mission.chatId) as any[];

      const messages = buildChatMessages(sessionIds, metaRows);
      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

This also removes the now-unused `getSessionName` import from the top of the file (line 18):
```typescript
// Remove this line:
import { getSessionName } from "../../src/connectors/feishu/session-name.js";
```

- [ ] **Step 2: Verify Board still compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bunx tsc --noEmit web/board/server.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/board/server.ts
git commit -m "refactor: Board server uses shared conversation parser (dedup ~230 lines)"
```

---

### Task 4: Fix frontend types and null-safety

**Files:**
- Modify: `web/frontend/src/api/types.ts` (add `thinking` field to `StepItem`)
- Modify: `web/frontend/src/pages/Conversations.tsx` (fix null-safety in meta display)

- [ ] **Step 1: Add `thinking` field to `StepItem` in types.ts**

In `web/frontend/src/api/types.ts`, change the `StepItem` interface (lines 290-294):

```typescript
export interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
  thinking?: string;  // merged thinking before tool (if type=tool)
}
```

- [ ] **Step 2: Fix null-safety in Conversations.tsx meta display**

In `web/frontend/src/pages/Conversations.tsx`, line 198-199 has:
```typescript
<span>{(message.meta.inputTokens + message.meta.outputTokens).toLocaleString()} tok</span>
```

This crashes when `inputTokens` or `outputTokens` is null. Fix to:
```typescript
<span>{((message.meta.inputTokens ?? 0) + (message.meta.outputTokens ?? 0)).toLocaleString()} tok</span>
```

Also fix line 199:
```typescript
{message.meta.duration > 0 && <span>{(message.meta.duration / 1000).toFixed(1)}s</span>}
```
Fix to:
```typescript
{message.meta.duration != null && message.meta.duration > 0 && <span>{(message.meta.duration / 1000).toFixed(1)}s</span>}
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/pages/Conversations.tsx
git commit -m "fix: add StepItem.thinking field + null-safety in meta display"
```

---

### Task 5: Build, deploy, and verify

**Files:**
- No code changes — build + deploy + smoke test

- [ ] **Step 1: Build frontend**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/web/frontend
npm run build
```
Expected: Build succeeds, output in `web/frontend/dist/`

- [ ] **Step 2: Start test server on port 5199**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
REMI_WEB_PORT=5199 bun run web/server.ts &
```
Expected: `[remi-web] Dashboard started on port 5199`

- [ ] **Step 3: Smoke test — list conversations API**

```bash
curl -s http://localhost:5199/api/v1/conversations?limit=5 | python3 -m json.tool | head -30
```
Expected: JSON array with conversations, each having a `topic` from `first_message` (not truncated chatId), and proper `threadId` grouping.

- [ ] **Step 4: Smoke test — messages API**

Pick a `chatId` from step 3 and test:
```bash
curl -s "http://localhost:5199/api/v1/conversations/<chatId>/messages" | python3 -m json.tool | head -50
```
Expected: Alternating user/assistant messages with proper `createTime` (Unix ms), `steps` with merged thinking, and `meta` with timestamp-matched data.

- [ ] **Step 5: Verify in browser**

Open http://10.37.66.8:5199/#/ and navigate to Conversations page. Verify:
- Conversation list shows meaningful topics (not `oc_47c65d`)
- Clicking a conversation loads messages
- Messages display without null errors in meta stats
- Steps panel expands correctly with merged thinking+tool steps

- [ ] **Step 6: Stop test server, commit build**

```bash
kill %1  # stop background server
git add web/frontend/dist/
git commit -m "build: dashboard frontend for conversations fix"
```
