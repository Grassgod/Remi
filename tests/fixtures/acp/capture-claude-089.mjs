// Capture claude-agent-acp 0.89.0 session/update frames by driving the bridge's
// own renderer, field tracker, compaction lifecycle and notice helpers with the
// exact clientCapabilities Remi sends (packages/acp/src/client.ts initialize()).
// Usage: bun tests/fixtures/acp/capture-claude-089.mjs <claude-agent-acp@0.89.0 dist> tests/fixtures/acp
// Run it against a private copy of the npm package whose node_modules resolves
// `diff` (dist/diff.js imports it); it writes the claude-089-*.json fixtures and
// claude-089-capability-evidence.json (both committed).
//
// Which frames come from the bridge and which are scripted:
// - From the bridge: every `tool_call` / `tool_call_update` frame is built by
//   its `AcpToolCallRenderer` (toolCall, refinement, result, progress,
//   hookResult) and filtered by its `ToolCallFieldTracker`; the compaction
//   frames come from its `ContextCompactionLifecycle`; the notice from
//   `noticeOrTranscriptUpdate`; the capability evidence from
//   `clientSupportsCompactionUpdates` / `clientSupportsNotices`.
// - Scripted here: the conversation itself (which tools run, their inputs,
//   `tool_result` contents and structured results, and the frame order); every
//   `agent_message_chunk` / `agent_thought_chunk` and `usage_update` frame,
//   written in the shape acp-agent.js streams; and the
//   `_meta.claudeCode.parentToolUseId` stamp on subagent frames, which
//   `push(update, parent)` adds the way acp-agent.js:502-510 does.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dist, out] = process.argv.slice(2);
const { AcpToolCallRenderer } = await import(join(dist, "tool-calls/renderer.js"));
const { ToolCallFieldTracker } = await import(join(dist, "tool-calls/field-tracker.js"));
const { ContextCompactionLifecycle, clientSupportsCompactionUpdates, contextCompactionMetadataFromBoundary } =
  await import(join(dist, "context-compaction.js"));
const { clientSupportsNotices, noticeOrTranscriptUpdate } = await import(join(dist, "session-notices.js"));

/** Remi's clientCapabilities for agentType "claude" (client.ts:518-545). */
const CAPS = {
  _meta: { terminal_output: true, "subagent-transcript": true, jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
  fs: { readTextFile: true, writeTextFile: true },
  session: { compaction: {}, notices: {} },
  elicitation: { form: {} },
};
const SESSION = "sess_claude_089";
const CWD = "/work/repo";

const evidence = {
  clientSupportsCompactionUpdates: clientSupportsCompactionUpdates(CAPS),
  clientSupportsNotices: clientSupportsNotices(CAPS),
  withoutCapability: { compaction: clientSupportsCompactionUpdates({ ...CAPS, session: undefined }), notices: clientSupportsNotices({ ...CAPS, session: undefined }) },
};

function recorder() {
  const frames = [];
  const tracker = new ToolCallFieldTracker();
  const renderer = AcpToolCallRenderer.for(CAPS);
  const push = (update, parent) => {
    const copy = JSON.parse(JSON.stringify(update));
    if (parent) copy._meta = { ...copy._meta, claudeCode: { ...(copy._meta?.claudeCode ?? {}), parentToolUseId: parent } };
    if (copy.sessionUpdate === "tool_call" || copy.sessionUpdate === "tool_call_update") {
      if (!tracker.apply(copy, { replacePinnedContent: true })) return;
    }
    frames.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: copy } });
  };
  const chunk = (kind, messageId, text, parent, meta) => push({ sessionUpdate: kind, content: { type: "text", text }, messageId, ...(meta ? { _meta: meta } : {}) }, parent);
  /** A streamed tool use: start without input (AIR), the complete input, then the result. */
  const tool = (id, name, input, result, structured, parent) => {
    push(renderer.toolCall({ id, name, input: {} }, { cwd: CWD, inputComplete: false }), parent);
    push(renderer.refinement({ id, name, input }, CWD), parent);
    for (const update of renderer.result({ id, name, input }, { type: "tool_result", tool_use_id: id, ...result }, { structured })) push(update, parent);
  };
  return { frames, push, chunk, tool, renderer };
}

// ── Turn: reasoning, commentary, tools of every class, final answer ─────────
{
  const r = recorder();
  // Billing-only frame from Remi's own bridge patch (usage-bridge-patches.ts:53, 94, 153).
  r.push({ sessionUpdate: "usage_update", used: 0, size: 0, _meta: { claudeCode: { usage: { inputTokens: 10 } } } });
  r.chunk("agent_thought_chunk", "msg_01A", "The user wants the failing test fixed. ");
  r.chunk("agent_thought_chunk", "msg_01A", "Let me look at the suite first.");
  r.chunk("agent_message_chunk", "msg_01A", "I'll run the tests ");
  r.chunk("agent_message_chunk", "msg_01A", "to see what fails.");
  r.tool("toolu_bash_1", "Bash", { command: "bun test tests/unit/math.test.ts", description: "Run the math tests" },
    { content: "1 fail\nexpected 4, got 5", is_error: true },
    { stdout: "1 fail\nexpected 4, got 5", stderr: "", interrupted: false });
  r.tool("toolu_read_1", "Read", { file_path: `${CWD}/src/math.ts` },
    { content: [{ type: "text", text: "export const add = (a, b) => a + b + 1;" }] },
    { type: "text", file: { filePath: `${CWD}/src/math.ts`, content: "export const add = (a, b) => a + b + 1;\n", numLines: 1, startLine: 1, totalLines: 1 } });
  r.tool("toolu_grep_1", "Grep", { pattern: "add\\(", path: `${CWD}/src` },
    { content: "src/math.ts\nsrc/index.ts" }, { filenames: ["src/math.ts", "src/index.ts"], numFiles: 2, mode: "files_with_matches" });
  r.tool("toolu_glob_1", "Glob", { pattern: "**/*.test.ts" }, { content: "tests/unit/math.test.ts" }, undefined);
  r.chunk("agent_message_chunk", "msg_01B", "The off-by-one is in `add`. Fixing it.");
  r.tool("toolu_edit_1", "Edit", { file_path: `${CWD}/src/math.ts`, old_string: "a + b + 1", new_string: "a + b" },
    { content: "The file src/math.ts has been updated." }, undefined);
  // PostToolUse hook: the final change of the edit (renderer.js hookResult, file-edit.js:79-97).
  const hook = await r.renderer.hookResult({ id: "toolu_edit_1", name: "Edit", input: {} },
    { filePath: `${CWD}/src/math.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ["-export const add = (a, b) => a + b + 1;", "+export const add = (a, b) => a + b;"] }] }, CWD);
  if (hook) r.push(hook);
  r.tool("toolu_write_1", "Write", { file_path: `${CWD}/notes/fix.md`, content: "# Fix\n\nRemoved the +1.\n" },
    { content: "File created successfully at: notes/fix.md" }, undefined);
  r.tool("toolu_websearch_1", "WebSearch", { query: "bun test expect toBe" },
    { content: "Web search results for query: bun test" }, undefined);
  r.tool("toolu_webfetch_1", "WebFetch", { url: "https://bun.sh/docs/test", prompt: "How does toBe compare?" },
    { content: "toBe uses Object.is" }, undefined);
  r.tool("toolu_mcp_1", "mcp__github__search_issues", { q: "add off by one" },
    { content: [{ type: "text", text: "[]" }] }, undefined);
  r.tool("toolu_bash_2", "Bash", { command: "bun test tests/unit/math.test.ts", description: "Re-run the math tests" },
    { content: "1 pass", is_error: false }, { stdout: "1 pass", stderr: "", interrupted: false });
  r.push({ sessionUpdate: "usage_update", used: 18200, size: 200000, _meta: { claudeCode: { usage: { inputTokens: 18200 } } } });
  r.chunk("agent_message_chunk", "msg_01C", "Fixed `add` in `src/math.ts`; ");
  r.chunk("agent_message_chunk", "msg_01C", "the math tests pass now.");
  r.push({ sessionUpdate: "usage_update", used: 18950, size: 200000 });
  writeFileSync(join(out, "claude-089-turn-notifications.json"), `${JSON.stringify(r.frames, null, 2)}\n`);
}

// ── Subagent: an Agent call whose prose and tools are stamped with its id ───
{
  const r = recorder();
  r.chunk("agent_message_chunk", "msg_02A", "Delegating the search.");
  r.push(r.renderer.toolCall({ id: "toolu_agent_1", name: "Agent", input: {} }, { cwd: CWD, inputComplete: false }));
  r.push(r.renderer.refinement({ id: "toolu_agent_1", name: "Agent", input: { description: "Find add callers", prompt: "List every caller of add()", subagent_type: "Explore" } }, CWD));
  r.chunk("agent_thought_chunk", "msg_02S", "Searching for callers.", "toolu_agent_1");
  r.tool("toolu_sub_grep", "Grep", { pattern: "add\\(" }, { content: "src/index.ts" }, undefined, "toolu_agent_1");
  r.chunk("agent_message_chunk", "msg_02S", "One caller: src/index.ts.", "toolu_agent_1");
  r.push(r.renderer.progress({ toolCallId: "toolu_agent_1", toolName: "Agent", elapsedTimeSeconds: 3, subagentType: "Explore" }));
  for (const update of r.renderer.result({ id: "toolu_agent_1", name: "Agent", input: { description: "Find add callers" } },
    { type: "tool_result", tool_use_id: "toolu_agent_1", content: [{ type: "text", text: "One caller: src/index.ts." }] }, {})) r.push(update);
  // Subagent context usage is ignored by the translator.
  r.push({ sessionUpdate: "usage_update", used: 5000, size: 200000 }, "toolu_agent_1");
  r.chunk("agent_message_chunk", "msg_02B", "Only `src/index.ts` calls `add`.");
  writeFileSync(join(out, "claude-089-subagent-notifications.json"), `${JSON.stringify(r.frames, null, 2)}\n`);
}

// ── Compaction lifecycle and notices ────────────────────────────────────────
{
  const frames = [];
  const send = async (notification) => {
    frames.push({ jsonrpc: "2.0", method: "session/update", params: JSON.parse(JSON.stringify(notification)) });
  };
  const lifecycle = new ContextCompactionLifecycle(send, {
    sessionId: SESSION, airClient: true,
    // Exactly the choice acp-agent.js:2536-2541 makes.
    presentation: clientSupportsCompactionUpdates(CAPS) ? "compaction_update" : "tool_call",
  });
  await send({ sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", messageId: "msg_03A", content: { type: "text", text: "Working on it." } } });
  // SDK `status: compacting` (acp-agent.js:3577-3579), the API compaction block
  // streaming its summary (acp-agent.js:4790-4801), the PostCompact hook, the
  // `compact_result: success` status and the `compact_boundary` facts
  // (acp-agent.js:3580-3607).
  await lifecycle.start("cmp_uuid_1");
  await lifecycle.heartbeat("cmp_uuid_1", "The user is fixing add(). ");
  await lifecycle.heartbeat("cmp_uuid_1", "Tests were failing by one.");
  lifecycle.recordSummary("<summary>\nThe user is fixing add(). Tests were failing by one.\n</summary>");
  await lifecycle.finish("cmp_uuid_1", "completed");
  await lifecycle.finish("cmp_uuid_1", "completed", contextCompactionMetadataFromBoundary({ trigger: "auto", pre_tokens: 190000, post_tokens: 12000, duration_ms: 8000 }), true);
  await lifecycle.reset();
  await send({ sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", messageId: "msg_03B", content: { type: "text", text: "Done after compaction." } } });
  // A failed manual compaction.
  await lifecycle.start("cmp_uuid_2");
  await lifecycle.finish("cmp_uuid_2", "failed", { error: "Conversation too long to compact" });
  await lifecycle.reset();
  // An interrupted compaction: the turn boundary cancels it (context-compaction.js reset()).
  await lifecycle.start("cmp_uuid_3");
  await lifecycle.reset();
  // A notice (session-notices.js noticeOrTranscriptUpdate).
  await send({ sessionId: SESSION, update: noticeOrTranscriptUpdate({ severity: "warning", title: "Hook blocked the tool", description: "PreToolUse hook denied Bash" }, clientSupportsNotices(CAPS)) });
  writeFileSync(join(out, "claude-089-compaction-notifications.json"), `${JSON.stringify(frames, null, 2)}\n`);
}

// ── AskUserQuestion (suppressed; the question item stands for it) and an aborted command ─
{
  const r = recorder();
  r.push(r.renderer.toolCall({ id: "toolu_ask_1", name: "AskUserQuestion", input: {} }, { cwd: CWD, inputComplete: false }));
  r.push(r.renderer.refinement({ id: "toolu_ask_1", name: "AskUserQuestion", input: { questions: [{ question: "Which file?", header: "File", options: [{ label: "a.ts" }, { label: "b.ts" }], multiSelect: false }] } }, CWD));
  for (const update of r.renderer.result({ id: "toolu_ask_1", name: "AskUserQuestion", input: {} },
    { type: "tool_result", tool_use_id: "toolu_ask_1", content: "User answered: a.ts" }, {})) r.push(update);
  r.tool("toolu_bash_3", "Bash", { command: "sleep 100", description: "Wait" },
    { content: "", is_error: true }, { stdout: "", stderr: "", interrupted: true });
  writeFileSync(join(out, "claude-089-interaction-notifications.json"), `${JSON.stringify(r.frames, null, 2)}\n`);
}

writeFileSync(join(out, "claude-089-capability-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
