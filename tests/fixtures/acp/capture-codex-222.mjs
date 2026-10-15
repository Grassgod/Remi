// codex-acp 2.2.2 frames for Remi's AIR client (terminal_output: true, no
// `plan` capability, session.compaction + session.notices).
//
// Which frames come from the bridge and which are scripted:
// - From the bridge: the compaction frames and the notice, made by the
//   bundle's own pure modules (src/CodexSessionCompactions.ts,
//   src/SessionNotice.ts) sliced out of dist/index.js and evaluated in
//   isolation, and the capability evidence (`clientSupportsCompaction` /
//   `clientSupportsNotices` on Remi's capabilities).
// - Scripted here: every other frame (messages, reasoning, tools, plans, usage
//   and the typed session failures), written from the renderer/reporter code
//   paths cited next to each one, because the bundle's renderer cannot run
//   outside a live app-server.
// Usage: bun tests/fixtures/acp/capture-codex-222.mjs <codex-acp@2.2.2 dist/index.js> tests/fixtures/acp
// It writes codex-222-turn-notifications.json and
// codex-222-capability-evidence.json (both committed).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [bundlePath, out] = process.argv.slice(2);
const bundle = readFileSync(bundlePath, "utf8");
const slice = (from, to) => {
  const start = bundle.indexOf(from);
  const end = bundle.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`marker not found: ${from}`);
  return bundle.slice(start, end);
};
const modules = new Function(`${slice("// src/SessionNotice.ts", "// src/SessionIndexMutations.ts")}
${slice("// src/CodexSessionCompactions.ts", "// src/CodexAcpServer.ts")}
return { clientSupportsNotices, createSessionNotice, clientSupportsCompaction, createCompactionUpdate, CodexSessionCompactions };`)();

/** Remi's clientCapabilities for agentType "codex" (client.ts:518-545). */
const CAPS = {
  _meta: { terminal_output: true, jetbrains: { air: { version: 1, capabilities: ["recommendedValue", "sessionFailure"] } } },
  fs: { readTextFile: true, writeTextFile: true },
  session: { compaction: {}, notices: {} },
  elicitation: { form: {} },
};
const supportsCompaction = modules.clientSupportsCompaction(CAPS);
const supportsNotices = modules.clientSupportsNotices(CAPS);
const SESSION = "019fd67e-c843-7071-b5d6-66f42f33234c";
const CWD = "/work/repo";
const frames = [];
const push = (update) => frames.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update } });
// createMessagePhaseMeta / airOnlyMeta (CX:29575-29580, 28076-28078).
const phase = (value) => ({ jetbrains: { air: { version: 1, phase: value } } });
const text = (messageId, value, p) => push({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value }, ...(p ? { _meta: phase(p) } : {}) });
const thought = (messageId, value) => push({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: value } });

push({ sessionUpdate: "usage_update", used: 14445, size: 258400 });
thought("rs_01", "**Inspecting the helper**\n\n");
thought("rs_01", "The test says add is off by one.");
text("msg_c1", "I'll inspect the math helper ", "commentary");
text("msg_c1", "and run the failing test.", "commentary");
// Unknown (multi-part) command: commandActionFacts "unknown" + terminal (CX:28474-28495, 28105-28150, 28187-28195).
push({ sessionUpdate: "tool_call", toolCallId: "call_cmd1", name: "exec_command", kind: "execute", title: "bun test tests/unit/math.test.ts",
  status: "in_progress", content: [{ type: "terminal", terminalId: "call_cmd1" }],
  rawInput: { command: "/bin/zsh -lc 'bun test tests/unit/math.test.ts'", cwd: CWD },
  _meta: { terminal_info: { cwd: CWD, terminal_id: "call_cmd1" } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_cmd1", _meta: { terminal_output: { data: "1 fail\n", terminal_id: "call_cmd1" } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_cmd1", _meta: { terminal_output: { data: "expected 4, got 5\n", terminal_id: "call_cmd1" } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_cmd1", status: "failed",
  _meta: { terminal_exit: { exit_code: 1, signal: null, terminal_id: "call_cmd1" } } });
// Single-action read: kind read, title + locations, no output (CX:28476-28478, 28496-28506).
push({ sessionUpdate: "tool_call", toolCallId: "call_read1", kind: "read", title: `Read file '${CWD}/src/math.ts'`, status: "in_progress",
  locations: [{ path: `${CWD}/src/math.ts` }] });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_read1", status: "completed" });
// Single-action search: kind search, title from searchTitle, output as rawOutput (CX:28479-28480, 28509-28514).
push({ sessionUpdate: "tool_call", toolCallId: "call_search1", kind: "search", title: "Search for 'add(' in src", status: "in_progress" });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_search1", status: "completed", rawOutput: "src/math.ts:1:export const add\n" });
// Single-action list (CX:28481-28482).
push({ sessionUpdate: "tool_call", toolCallId: "call_list1", kind: "read", title: "List files in 'src'", status: "in_progress" });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_list1", status: "completed", rawOutput: "index.ts\nmath.ts\n" });
// File change: per-hunk diff blocks with `_meta.kind` (CX:29118-29233); the second hunk of the same file and a new file.
push({ sessionUpdate: "tool_call", toolCallId: "call_patch1", title: "Editing files", kind: "edit", status: "in_progress", content: [
  { type: "diff", oldText: "export const add = (a, b) => a + b + 1;\n", newText: "export const add = (a, b) => a + b;\n", path: `${CWD}/src/math.ts`, _meta: { kind: "update" } },
  { type: "diff", oldText: "export const sub = (a, b) => a - b - 1;\n", newText: "export const sub = (a, b) => a - b;\n", path: `${CWD}/src/math.ts`, _meta: { kind: "update" } },
  { type: "diff", oldText: null, newText: "# Fix\n\nRemoved the off-by-one.\n", path: `${CWD}/notes/fix.md`, _meta: { kind: "add" } },
] });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_patch1", status: "completed" });
// Web search and open page: kind search, rawInput {query, action} (CX:29528-29571).
push({ sessionUpdate: "tool_call", toolCallId: "ws_1", title: "Web search: bun test toBe", kind: "search", status: "in_progress",
  rawInput: { query: "bun test toBe", action: { type: "search", query: "bun test toBe" } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "ws_1", title: "Web search: bun test toBe", status: "completed",
  rawInput: { query: "bun test toBe", action: { type: "search", query: "bun test toBe" } } });
push({ sessionUpdate: "tool_call", toolCallId: "ws_2", title: "Open page: https://bun.sh/docs/test", kind: "search", status: "in_progress",
  rawInput: { query: "", action: { type: "openPage", url: "https://bun.sh/docs/test" } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "ws_2", title: "Open page: https://bun.sh/docs/test", status: "completed",
  rawInput: { query: "", action: { type: "openPage", url: "https://bun.sh/docs/test" } } });
// MCP: kind execute, title mcp.<server>.<tool>, is_mcp_tool_call (CX:29493-29521, 28236-28238).
push({ sessionUpdate: "tool_call", toolCallId: "mcp_1", kind: "execute", title: "mcp.github.search_issues", status: "in_progress",
  rawInput: { server: "github", tool: "search_issues", arguments: { q: "add off by one" } }, _meta: { is_mcp_tool_call: true } });
push({ sessionUpdate: "tool_call_update", toolCallId: "mcp_1", status: "completed",
  rawInput: { server: "github", tool: "search_issues", arguments: { q: "add off by one" } },
  rawOutput: { result: { content: [{ type: "text", text: "[]" }] }, error: null } });
// Collaboration spawn: title = tool, AIR subagent flag (CX:29815-29835, 28175-28177).
push({ sessionUpdate: "tool_call", toolCallId: "call_spawn1", title: "spawnAgent", status: "in_progress",
  rawInput: { prompt: "Review the fix", senderThreadId: SESSION, receiverThreadIds: [], agentsStates: {}, model: null, reasoningEffort: null },
  _meta: { jetbrains: { air: { version: 1, subagent: true } } } });
push({ sessionUpdate: "tool_call_update", toolCallId: "call_spawn1", status: "completed",
  rawInput: { prompt: "Review the fix", senderThreadId: SESSION, receiverThreadIds: ["019fd67e-f5d8-7041-87ee-6f1d8d52280f"], agentsStates: {}, model: null, reasoningEffort: null },
  _meta: { jetbrains: { air: { version: 1, subagent: true } } } });
// Todo plan (CX:31712-31723).
push({ sessionUpdate: "plan", entries: [
  { status: "completed", content: "Find the off-by-one", priority: "medium" },
  { status: "in_progress", content: "Fix add and sub", priority: "medium" },
] });
push({ sessionUpdate: "plan", entries: [
  { status: "completed", content: "Find the off-by-one", priority: "medium" },
  { status: "completed", content: "Fix add and sub", priority: "medium" },
] });
// Compaction lifecycle from the bundle's own CodexSessionCompactions (CX:42230-42296).
const compactions = new modules.CodexSessionCompactions();
if (supportsCompaction) {
  push(compactions.start(SESSION, "turn_1", "cmp_item_1"));
  push(compactions.complete(SESSION, "turn_1", "cmp_item_1"));
  // `thread/compacted` without an item (CX:31411-31415).
  push(compactions.completeLegacy(SESSION, "turn_2"));
  push(compactions.start(SESSION, "turn_3", "cmp_item_3"));
  for (const update of compactions.finishTurn(SESSION, "turn_3", "failed", "Codex ended the turn before compaction completed.")) push(update);
}
// Notice (CX:30670-30683, 31504-31508): a config warning.
push(supportsNotices ? modules.createSessionNotice("warning", "Configuration warning", "model_reasoning_effort is ignored for this model")
  : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Config warning: ..." } });
// Typed session failure (AIR sessionFailure, session-failure.ts).
push({ sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { version: 1, sessionFailure: {
  id: "turn_1:retry", revision: 1, category: "provider", severity: "warning", title: "Reconnecting", details: "stream disconnected; retrying 1/5",
} } } } });
push({ sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { version: 1, sessionFailure: {
  id: "turn_1:retry", revision: 2, category: "provider", severity: "warning", title: "Reconnecting", details: "stream disconnected; retrying 2/5",
} } } } });
text("msg_c2", "Fixed `add` and `sub` in `src/math.ts`; ", "final_answer");
text("msg_c2", "both tests pass.", "final_answer");
push({ sessionUpdate: "usage_update", used: 16020, size: 258400 });

writeFileSync(join(out, "codex-222-turn-notifications.json"), `${JSON.stringify(frames, null, 2)}\n`);
const evidence = { supportsCompaction, supportsNotices, withoutCapability: {
  compaction: modules.clientSupportsCompaction({ ...CAPS, session: undefined }),
  notices: modules.clientSupportsNotices({ ...CAPS, session: undefined }),
} };
writeFileSync(join(out, "codex-222-capability-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
