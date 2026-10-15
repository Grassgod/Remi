import { describe, expect, it } from "bun:test";
import type { TraceCommandItem, TraceFileChangeItem, TraceItem, TraceSubagentItem, TraceToolItem } from "@multiremi/contracts/trace";
import { parseCommand } from "@shared/command-parse.js";
import {
  STEP_COPY_ZH,
  STEP_SUMMARY_ORDER,
  agentControl,
  describeStep,
  formatStepCopy,
  isHiddenStep,
  stepCategory,
  subagentResolver,
  summarizeSteps,
  type AgentResolver,
} from "@shared/trace-step-copy.js";

const NOW = "2026-10-15T00:00:00.000Z";
const base = { parent_id: null, started_at: NOW, completed_at: NOW } as const;

function shell(script: string, status: TraceItem["status"] = "completed"): TraceCommandItem {
  return {
    ...base, id: `cmd:${script}`, status, type: "command", tool: "Bash", source: "shell", command: script, cwd: null,
    actions: parseCommand(script), output: null, exit_code: status === "completed" ? 0 : null, duration_ms: null,
  };
}

function edit(changes: Array<[string, "add" | "update" | "delete"]>, status: TraceItem["status"] = "completed"): TraceFileChangeItem {
  return {
    ...base, id: `edit:${changes.map(([path]) => path).join(",")}`, status, type: "file_change", tool: "Edit", output: null, duration_ms: null,
    changes: changes.map(([path, kind]) => ({ path, kind, move_path: null, diff: null, added: 0, removed: 0 })),
  };
}

function call(name: string, input: Record<string, unknown> | null, status: TraceItem["status"] = "completed"): TraceToolItem {
  return { ...base, id: `call:${name}`, status, type: "tool", tool: name, server: null, kind: null, title: null, input, output: null, duration_ms: null };
}

function agent(id: string, facts: Partial<TraceSubagentItem> = {}): TraceSubagentItem {
  return { ...base, id, status: "completed", type: "subagent", tool: "Agent", title: null, prompt: null, output: null, duration_ms: null, ...facts };
}

/** Render with the zh table, the way Feishu and the CLI will. */
function zh(item: TraceItem, part?: Parameters<typeof describeStep>[1], resolve?: AgentResolver): string {
  const step = describeStep(item, part, resolve);
  return formatStepCopy(step.key, step.args);
}

describe("describeStep (zh-CN, Codex wording)", () => {
  it("reads, searches and listings from parsed command actions", () => {
    expect(zh(shell("cat src/app.ts"))).toBe("已读取 app.ts");
    expect(zh(shell("cat src/app.ts", "in_progress"))).toBe("正在读取 app.ts");
    expect(zh(shell("rg -n TODO packages"))).toBe("已在 packages 中搜索“TODO”");
    expect(zh(shell("rg -n TODO packages", "in_progress"))).toBe("正在 packages 中搜索“TODO”");
    expect(zh(shell("rg TODO"))).toBe("已对“TODO”进行搜索");
    expect(zh(shell("rg TODO", "in_progress"))).toBe("正在搜索“TODO”");
    expect(zh(shell("rg --version"))).toBe("已搜索文件");
    expect(zh(shell("rg --version", "in_progress"))).toBe("正在搜索文件");
    expect(zh(shell("ls frontend"))).toBe("已列出 frontend 中的文件");
    expect(zh(shell("ls frontend", "in_progress"))).toBe("正在列出 frontend 中的文件");
    expect(zh(shell("ls"))).toBe("已列出文件");
  });

  it("runs, stops and declines commands; a failed command still reads as run", () => {
    expect(zh(shell("npm test"))).toBe("已运行 npm test");
    expect(zh(shell("npm test", "failed"))).toBe("已运行 npm test");
    expect(describeStep(shell("npm test", "failed")).state).toBe("done");
    expect(zh(shell("npm test", "in_progress"))).toBe("正在运行命令");
    expect(zh(shell("npm test", "stopped"))).toBe("已停止 npm test");
    expect(describeStep(shell("cat a.ts", "declined"))).toEqual({ key: "run_declined", args: { command: "cat a.ts" }, state: "declined" });
    // A stopped read keeps the read copy (Codex has no stopped read template).
    expect(describeStep(shell("cat a.ts", "stopped"))).toMatchObject({ key: "read_done", state: "stopped" });
  });

  it("labels a command the model titled with its title, in every state (spec §13)", () => {
    const titled = (status: TraceItem["status"]) => ({ ...shell("sleep 25; ls -A /w", status), title: "Sleep 25s then list directory" });
    expect(zh(titled("completed"))).toBe("Sleep 25s then list directory");
    expect(zh(titled("in_progress"))).toBe("Sleep 25s then list directory");
    expect(describeStep(titled("in_progress")).state).toBe("active");
    expect(zh(titled("failed"))).toBe("Sleep 25s then list directory");
    expect(zh(titled("stopped"))).toBe("已停止 Sleep 25s then list directory");
    expect(zh(titled("declined"))).toBe("已拒绝运行 Sleep 25s then list directory");
    // The command stays available to the detail; a blank title is no title.
    expect(describeStep(titled("completed")).args.command).toBe("sleep 25; ls -A /w");
    expect(zh({ ...shell("npm test"), title: "  " })).toBe("已运行 npm test");
  });

  it("names a background subagent while it runs (spec §13)", () => {
    const agent = (status: TraceItem["status"], background?: boolean) => ({
      ...base, id: "toolu_agent", status, type: "subagent" as const, tool: "Agent", title: "Count files", prompt: null, output: null,
      duration_ms: null, ...(background === undefined ? {} : { background }),
    });
    expect(zh(agent("in_progress", true))).toBe("后台运行中：Count files");
    expect(zh(agent("in_progress", false))).toBe("正在运行子代理：Count files");
    expect(zh(agent("in_progress"))).toBe("正在运行子代理：Count files");
    expect(zh(agent("completed", true))).toBe("子代理已完成：Count files");
    expect(zh(agent("stopped", true))).toBe("子代理已停止：Count files");
  });

  it("describes one row per action of a multi-action command", () => {
    const item = shell("cat a.ts && rg foo src");
    expect(item.actions).toHaveLength(2);
    expect(item.actions.map((action) => zh(item, action))).toEqual(["已读取 a.ts", "已在 src 中搜索“foo”"]);
    // Without an action, a multi-action command falls back to the command line.
    expect(zh(item)).toBe("已运行 cat a.ts && rg foo src");
  });

  it("uses the item command when a tool read carries no command text", () => {
    const item: TraceCommandItem = { ...shell("x"), source: "tool", tool: "Read", command: null,
      actions: [{ type: "read", command: null, name: "a.ts", path: "/repo/a.ts" }] };
    expect(describeStep(item)).toEqual({ key: "read_done", args: { file: "a.ts", path: "/repo/a.ts", command: "Read" }, state: "done" });
  });

  it("file changes per change, with Codex's rejected and stopped copy", () => {
    const item = edit([["src/a.ts", "update"], ["src/new.ts", "add"], ["old.ts", "delete"]]);
    expect(item.changes.map((change) => zh(item, change))).toEqual(["已编辑 a.ts", "已创建 new.ts", "已删除 old.ts"]);
    expect(zh(edit([["a.ts", "update"]], "in_progress"))).toBe("正在编辑 a.ts");
    expect(zh(edit([["a.ts", "add"]], "in_progress"))).toBe("正在创建 a.ts");
    expect(zh(edit([["a.ts", "update"]], "declined"))).toBe("已拒绝 a.ts");
    expect(zh(edit([["a.ts", "update"]], "failed"))).toBe("已拒绝 a.ts");
    expect(zh(edit([["a.ts", "delete"]], "stopped"))).toBe("已停止删除 a.ts");
  });

  it("web searches, fetches and other tools", () => {
    const web = { ...base, id: "ws", status: "completed", type: "web_search", tool: "WebSearch", action: "search",
      query: "bun lockfile", url: null, output: null, duration_ms: null } as const satisfies TraceItem;
    expect(zh(web)).toBe("已搜索网页：bun lockfile");
    expect(zh({ ...web, status: "in_progress" })).toBe("正在搜索网页：bun lockfile");
    expect(zh({ ...web, query: null })).toBe("已搜索网页");
    expect(zh({ ...web, action: "fetch", query: null, url: "https://example.com" })).toBe("已打开 https://example.com");
    const tool = { ...base, id: "t", status: "completed", type: "tool", tool: "mcp__linear__create_issue", server: "linear",
      kind: null, title: null, input: null, output: null, duration_ms: null } as const satisfies TraceItem;
    expect(zh(tool)).toBe("已调用 mcp__linear__create_issue");
    expect(zh({ ...tool, title: "Create issue", status: "declined" })).toBe("已拒绝调用 Create issue");
  });

  it("non-step items", () => {
    expect(zh({ ...base, id: "r", status: "in_progress", type: "reasoning", text: "…" })).toBe("正在思考");
    expect(zh({ ...base, id: "p", status: "completed", type: "plan", entries: [] })).toBe("已更新计划");
    expect(zh({ ...base, id: "c", status: "failed", type: "compaction", trigger: "automatic", summary: null,
      pre_tokens: null, post_tokens: null, error: "boom" })).toBe("上下文压缩失败");
    const permission = { ...base, id: "perm:1", status: "completed", type: "permission", tool_item_id: "call_1", title: "Run rm -rf build",
      message_id: "msg_1", options: [], decision: { option_id: "allow", name: "Allow", kind: "allow_once" }, outcome: "selected",
      responded_by: "mem_1", reply_message_id: null } as const satisfies TraceItem;
    expect(zh(permission)).toBe("已批准：Run rm -rf build");
    expect(zh({ ...permission, decision: { option_id: "no", name: "Reject", kind: "reject_once" } })).toBe("已拒绝：Run rm -rf build");
    expect(zh({ ...permission, decision: null, outcome: "timeout", status: "stopped" })).toBe("批准已取消：Run rm -rf build");
    expect(zh({ ...permission, status: "in_progress", decision: null, outcome: null })).toBe("正在等待批准：Run rm -rf build");
    expect(describeStep({ ...base, id: "m", status: "completed", type: "agent_message", text: "Hello", phase: "final" }))
      .toEqual({ key: "message", args: { text: "Hello" }, state: "done" });
  });

  it("only returns keys of the zh table, and every key's placeholders get args", () => {
    const thread = "019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
    const resolve = subagentResolver([agent("sa:x", { name: "Explore", thread_id: thread })]);
    const samples: TraceItem[] = [
      shell("cat a.ts"), shell("rg foo src"), shell("rg foo"), shell("rg --version"), shell("ls src"), shell("ls"),
      shell("npm test"), shell("npm test", "stopped"), shell("npm test", "declined"), shell("npm test", "in_progress"),
      edit([["a.ts", "add"]]), edit([["a.ts", "update"]], "stopped"), edit([["a.ts", "delete"]], "declined"),
      call("SendMessage", { to: thread, message: "go" }), call("SendMessage", { to: "a6d91312b45bfd273" }, "in_progress"),
      call("TaskStop", { task_id: thread }), call("ListAgents", {}, "in_progress"), call("wait", {}),
      ...(["interruptAgent", "resumeAgent", "closeAgent", "followupTask"] as const).flatMap((name) => [
        call(name, { receiverThreadIds: [thread] }), call(name, { receiverThreadIds: ["0123456789abcdef"] }, "in_progress"),
      ]),
    ];
    for (const item of samples) {
      const step = describeStep(item, undefined, resolve);
      expect(STEP_COPY_ZH).toHaveProperty(step.key);
      const placeholders = [...STEP_COPY_ZH[step.key].matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!);
      for (const name of placeholders) expect(step.args, `${step.key} needs ${name}`).toHaveProperty(name);
    }
  });
});

describe("agent-control rows (PR 5 §4.1)", () => {
  const thread = "019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
  const claudeId = "a6d91312b45bfd273";
  const items: TraceItem[] = [
    agent("sa:codex", { tool: "spawnAgent", name: "reviewer", thread_id: thread }),
    agent("sa:claude", { name: "Count files", thread_id: claudeId }),
  ];
  const resolve = subagentResolver(items);

  it("derives every Claude row from the tool name and input", () => {
    expect(agentControl(call("SendMessage", { to: claudeId, message: "Also count tests", summary: "x" })))
      .toEqual({ kind: "message", target: claudeId, message: "Also count tests" });
    expect(zh(call("SendMessage", { to: claudeId, message: "m" }), undefined, resolve)).toBe("已发送消息给 Count files");
    expect(zh(call("SendMessage", { to: claudeId, message: "m" }, "in_progress"), undefined, resolve)).toBe("正在发送消息给 Count files");
    expect(agentControl(call("ListAgents", {}))).toEqual({ kind: "list", target: null, message: null });
    expect(zh(call("ListAgents", {}, "in_progress"))).toBe("正在列出子代理");
    expect(zh(call("ListAgents", {}))).toBe("已列出子代理");
    // Monitor stays a plain tool row (PR 6).
    expect(agentControl(call("Monitor", { task_id: claudeId }), resolve)).toBeNull();
    expect(zh(call("Monitor", {}))).toBe("已调用 Monitor");
  });

  it("reads TaskStop as an interrupt only when it stops a subagent of the trace", () => {
    expect(agentControl(call("TaskStop", { task_id: claudeId }), resolve)).toEqual({ kind: "interrupt", target: claudeId, message: null });
    expect(zh(call("TaskStop", { task_id: claudeId }), undefined, resolve)).toBe("已中断 Count files");
    expect(zh(call("TaskStop", { task_id: claudeId }, "in_progress"), undefined, resolve)).toBe("正在中断 Count files");
    // The deprecated `shell_id` names the task too.
    expect(agentControl(call("TaskStop", { shell_id: claudeId }), resolve)?.kind).toBe("interrupt");
    // A background shell, or no resolver at all: a plain tool row.
    expect(agentControl(call("TaskStop", { task_id: "bash_1" }), resolve)).toBeNull();
    expect(agentControl(call("TaskStop", { task_id: claudeId }))).toBeNull();
    expect(zh(call("TaskStop", { task_id: "bash_1" }), undefined, resolve)).toBe("已调用 TaskStop");
    expect(stepCategory(call("TaskStop", { task_id: "bash_1" }), undefined, resolve)).toBe("tool");
    expect(stepCategory(call("TaskStop", { task_id: claudeId }), undefined, resolve)).toBe("agent");
  });

  it("derives every Codex row from receiverThreadIds[0] and prompt", () => {
    for (const name of ["sendInput", "sendMessage", "followupTask"]) {
      expect(agentControl(call(name, { receiverThreadIds: [thread, "other"], prompt: "Check the tests" })))
        .toEqual({ kind: "message", target: thread, message: "Check the tests" });
      expect(zh(call(name, { receiverThreadIds: [thread] }), undefined, resolve)).toBe("已发送消息给 reviewer");
    }
    expect(agentControl(call("interruptAgent", { receiverThreadIds: [thread] })))
      .toEqual({ kind: "interrupt", target: thread, message: null });
    expect(agentControl(call("resumeAgent", { receiverThreadIds: [thread], prompt: "Continue" })))
      .toEqual({ kind: "resume", target: thread, message: "Continue" });
    expect(agentControl(call("closeAgent", { receiverThreadIds: [thread] })))
      .toEqual({ kind: "close", target: thread, message: null });
    expect(agentControl(call("listAgents", {}))).toEqual({ kind: "list", target: null, message: null });
    expect(zh(call("interruptAgent", { receiverThreadIds: [thread] }), undefined, resolve)).toBe("已中断 reviewer");
    expect(zh(call("resumeAgent", { receiverThreadIds: [thread] }, "in_progress"), undefined, resolve)).toBe("正在恢复 reviewer");
    expect(zh(call("resumeAgent", { receiverThreadIds: [thread] }), undefined, resolve)).toBe("已恢复 reviewer");
    expect(zh(call("closeAgent", { receiverThreadIds: [thread] }, "in_progress"), undefined, resolve)).toBe("正在关闭 reviewer");
    expect(zh(call("closeAgent", { receiverThreadIds: [thread] }), undefined, resolve)).toBe("已关闭 reviewer");
    expect(zh(call("listAgents", {}))).toBe("已列出子代理");
  });

  it("hides Codex wait, which never groups and keeps the plain tool copy", () => {
    const wait = call("wait", { receiverThreadIds: [thread], timeoutMs: 30000 });
    expect(agentControl(wait)).toEqual({ kind: "wait", target: null, message: null });
    expect(isHiddenStep(wait)).toBe(true);
    expect(stepCategory(wait)).toBeNull();
    expect(zh(wait)).toBe("已调用 wait");
    expect(summarizeSteps([{ item: wait }, { item: wait }])).toEqual([]);
    for (const item of [call("sendInput", { receiverThreadIds: [thread] }), call("Bash", null), shell("ls"), agent("sa:x")]) {
      expect(isHiddenStep(item)).toBe(false);
    }
  });

  it("only reads tool items: a subagent item is never a control row", () => {
    expect(agentControl(agent("sa:w", { tool: "wait", title: "wait" }))).toBeNull();
    expect(agentControl(shell("ls"))).toBeNull();
    expect(agentControl(call("mcp__x__wait", {}))).toBeNull();
  });

  it("resolves a target by thread_id, then name, then item id; the label is the name, else the title", () => {
    const pool: TraceItem[] = [
      agent("toolu_1", { name: "Explore", thread_id: "t-1" }),
      agent("toolu_2", { name: "Explore", thread_id: "t-2" }),
      agent("toolu_3", { name: "t-1" }),
      agent("toolu_4", { title: "Titled only" }),
      { ...agent("toolu_5", { name: "Nested", thread_id: "t-5" }), parent_id: "toolu_1" },
    ];
    const find = subagentResolver(pool);
    expect(find("t-1")?.id).toBe("toolu_1");
    // A repeated name resolves to the latest agent with it.
    expect(find("Explore")?.id).toBe("toolu_2");
    expect(find(" Explore ")?.id).toBe("toolu_2");
    expect(find("toolu_4")?.id).toBe("toolu_4");
    expect(find("t-5")?.id).toBe("toolu_5");
    expect(find("missing")).toBeNull();
    expect(zh(call("SendMessage", { to: "toolu_4" }), undefined, find)).toBe("已发送消息给 Titled only");
    expect(zh(call("SendMessage", { to: "t-5" }), undefined, find)).toBe("已发送消息给 Nested");
    // Resolved but nameless and untitled: the generic copy.
    expect(zh(call("SendMessage", { to: "sa:bare" }), undefined, subagentResolver([agent("sa:bare")]))).toBe("已发送消息给子代理");
  });

  it("shows an unresolved name as written and an id-like target as 子代理", () => {
    expect(zh(call("SendMessage", { to: "researcher" }))).toBe("已发送消息给 researcher");
    expect(zh(call("SendMessage", { to: "researcher" }), undefined, resolve)).toBe("已发送消息给 researcher");
    expect(zh(call("SendMessage", { to: "a6d91312b45bfd273" }))).toBe("已发送消息给子代理");
    expect(describeStep(call("SendMessage", { to: "a6d91312b45bfd273" })))
      .toEqual({ key: "agent_message_generic_done", args: {}, state: "done" });
    expect(zh(call("sendInput", { receiverThreadIds: ["019a2b3c-0000-0000-0000-000000000000"] }), undefined, resolve)).toBe("已发送消息给子代理");
    expect(zh(call("interruptAgent", { receiverThreadIds: ["0123456789abcdef"] }, "in_progress"))).toBe("正在中断子代理");
    expect(zh(call("resumeAgent", {}))).toBe("已恢复子代理");
    expect(zh(call("closeAgent", { receiverThreadIds: [] }))).toBe("已关闭子代理");
    // Short hex and non-hex ids are names as far as the copy knows.
    expect(zh(call("SendMessage", { to: "abc123" }))).toBe("已发送消息给 abc123");
    expect(zh(call("SendMessage", { to: "agent-12345678901234" }))).toBe("已发送消息给 agent-12345678901234");
  });

  it("keeps done copy for a stopped control call and refused-tool copy for a declined one", () => {
    expect(describeStep(call("SendMessage", { to: claudeId }, "stopped"), undefined, resolve))
      .toEqual({ key: "agent_message_done", args: { agent: "Count files" }, state: "stopped" });
    expect(describeStep(call("SendMessage", { to: claudeId }, "failed"), undefined, resolve).state).toBe("done");
    expect(describeStep(call("SendMessage", { to: claudeId }, "declined"), undefined, resolve))
      .toEqual({ key: "tool_declined", args: { tool: "SendMessage" }, state: "declined" });
  });

  it("summarizes a group: messaged when any row sent a message, else managed", () => {
    const message = call("SendMessage", { to: claudeId });
    const stop = call("TaskStop", { task_id: claudeId });
    const close = call("closeAgent", { receiverThreadIds: [thread] });
    const fragments = (rows: TraceItem[]) => summarizeSteps(rows.map((item) => ({ item })), resolve)
      .map((fragment) => [fragment.key, formatStepCopy(fragment.key, {}, { count: fragment.count })]);
    expect(fragments([stop, message, close])).toEqual([["summary_agent_first", "给子代理发了消息"]]);
    expect(fragments([stop, close, call("listAgents", {})])).toEqual([["summary_agent_control_first", "管理了子代理"]]);
    expect(fragments([close, shell("npm test")])).toEqual([
      ["summary_command_first", "运行了命令"],
      ["summary_agent_control_rest", "管理了子代理"],
    ]);
    expect(fragments([message, call("mcp__x__y", null)])).toEqual([
      ["summary_tool_first", "调用了工具"],
      ["summary_agent_rest", "给子代理发了消息"],
    ]);
    expect(summarizeSteps([{ item: message }, { item: close }], resolve)).toEqual([{ category: "agent", key: "summary_agent_first", count: 2 }]);
    // Without a resolver, TaskStop is an ordinary tool.
    expect(summarizeSteps([{ item: stop }])).toEqual([{ category: "tool", key: "summary_tool_first", count: 1 }]);
  });
});

describe("summarizeSteps", () => {
  it("emits fragments in the fixed category order, without numbers", () => {
    const rows = [
      { item: shell("npm test") },
      { item: shell("cat a.ts") },
      { item: edit([["a.ts", "update"], ["b.ts", "update"]]) },
      { item: shell("rg foo src") },
      { item: { ...base, id: "ws", status: "completed", type: "web_search", tool: "WebSearch", action: "search",
        query: "x", url: null, output: null, duration_ms: null } as TraceItem },
    ];
    const fragments = summarizeSteps(rows);
    expect(fragments).toEqual([
      { category: "edit", key: "summary_edit_first", count: 2 },
      { category: "explore", key: "summary_explore_rest", count: 2 },
      { category: "command", key: "summary_command_rest", count: 1 },
      { category: "web", key: "summary_web_rest", count: 1 },
    ]);
    expect(fragments.map((fragment) => formatStepCopy(fragment.key, {}, { count: fragment.count })))
      .toEqual(["编辑了文件", "读取文件", "运行了命令", "已搜索网页"]);
    expect(STEP_SUMMARY_ORDER).toEqual(["edit", "explore", "command", "web", "tool", "agent"]);
  });

  it("starts with the first form of whichever category comes first", () => {
    const fragments = summarizeSteps([{ item: shell("cat a.ts") }, { item: shell("npm test") }]);
    expect(fragments.map((fragment) => formatStepCopy(fragment.key, {}, { count: fragment.count }))).toEqual(["已读取文件", "运行了命令"]);
  });

  it("counts edited files once per path and skips rows that never group", () => {
    const item = edit([["a.ts", "update"], ["b.ts", "add"]]);
    const fragments = summarizeSteps([
      { item, part: item.changes[0] },
      { item, part: item.changes[1] },
      { item: edit([["a.ts", "update"]]) },
      { item: { ...base, id: "r", status: "completed", type: "reasoning", text: "…" } },
    ]);
    expect(fragments).toEqual([{ category: "edit", key: "summary_edit_first", count: 2 }]);
    expect(summarizeSteps([])).toEqual([]);
    expect(formatStepCopy("summary_empty")).toBe("已完成");
  });

  it("classifies rows", () => {
    const multi = shell("cat a.ts && npm test");
    expect(stepCategory(multi)).toBe("command");
    expect(stepCategory(shell("cat a.ts"))).toBe("explore");
    expect(stepCategory({ ...base, id: "p", status: "completed", type: "plan", entries: [] })).toBeNull();
  });
});

describe("formatStepCopy", () => {
  it("interpolates and resolves plural forms from another table", () => {
    const en = { summary_command_first_one: "Ran a command", summary_command_first_other: "Ran commands", read_done: "Read {{file}}" };
    expect(formatStepCopy("summary_command_first", {}, { count: 1, copy: en })).toBe("Ran a command");
    expect(formatStepCopy("summary_command_first", {}, { count: 3, copy: en })).toBe("Ran commands");
    expect(formatStepCopy("read_done", { file: "a.ts" }, { copy: en })).toBe("Read a.ts");
    expect(formatStepCopy("read_done")).toBe("已读取 ");
    expect(formatStepCopy("no_such_key")).toBe("no_such_key");
  });
});
