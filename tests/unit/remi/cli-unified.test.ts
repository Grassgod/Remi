import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { RETIRED_CLI_COMMANDS } from "../../../apps/remi/cli/core/retired-commands.js";
import { RETIRED_CLI_ROUTES } from "../../../packages/server/src/api/retired-cli-routes.js";
import { unifiedCommandSpecs, wakeExplanation } from "../../../apps/remi/cli/commands/unified.js";
import { collaborationCommandSpecs } from "../../../apps/remi/cli/commands/collaboration.js";
import { operationsCommandSpecs } from "../../../apps/remi/cli/commands/operations.js";
import { dispatch, cliCommandInventory } from "../../../apps/remi/cli/index.js";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";
import { issue, issueComment } from "../../../apps/remi/cli/multiremi/commands/issue.js";

const fetchBefore = globalThis.fetch, logBefore = console.log, errorBefore = console.error;
const envNames = ["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN", "MULTIREMI_ISSUE_SESSION_ID", "MULTIREMI_SESSION_ID", "MULTIREMI_CHAT_ID"] as const;
const envBefore = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const specs = unifiedCommandSpecs();
const registry = new CommandRegistry();
for (const spec of specs) registry.register(spec);
let requests: Request[] = [], output: string[] = [], warnings: string[] = [];
function setup(response: unknown = { id: "msg_1", messages: [], turns: [] }) {
  requests = []; output = []; warnings = [];
  process.env.MULTIREMI_SERVER_URL = "http://unified.test";
  process.env.MULTIREMI_WORKSPACE_ID = "local";
  process.env.MULTIREMI_TOKEN = "fixture";
  for (const name of envNames.slice(3)) delete process.env[name];
  console.log = (...values) => output.push(values.join(" "));
  console.error = (...values) => warnings.push(values.join(" "));
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/cli/capabilities") return Response.json({ commands: specs.map((spec) => ({ id: spec.id, allowed: true })) });
    if (url.pathname === "/api/cli/context") return Response.json({ current: { session: { id: "ises_current" } } });
    return Response.json(response);
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = fetchBefore; console.log = logBefore; console.error = errorBefore;
  for (const name of envNames) {
    if (envBefore[name] === undefined) delete process.env[name];
    else process.env[name] = envBefore[name];
  }
});

describe("unified CLI wire contracts", () => {
  it("passes structured answers and rejects malformed responses before networking", async () => {
    setup();
    const response = { answers: { "First?": "Yes", "Second?": "No" } };
    await registry.execute(["message", "send", "ises_1", "--reply-to", "hrq_1", "--response", JSON.stringify(response), "--output", "json"]);
    expect((await requests[1]!.json() as any).response).toEqual(response);
    for (const args of [["--reply-to", "hrq_1", "--response", "{"], ["--reply-to", "hrq_1", "--response", "[]"], ["--response", "{}"], ["--reply-to", "hrq_1", "--response", "{}", "--option", "Yes"]]) {
      setup();
      await expect(registry.execute(["message", "send", "ises_1", ...args])).rejects.toThrow();
      expect(requests).toHaveLength(0);
    }
  });
  const cases: Array<{ args: string[]; method: string; path: string; body?: unknown; query?: Record<string, string> }> = [
    { args: ["message", "send", "ises_1", "--content", "Hello", "--to", "parent-owner", "--wake", "next-turn"], method: "POST", path: "/api/sessions/ises_1/messages",
      body: { body_md: "Hello", to: { type: "role", ref: "parent_owner" }, message_kind: "request", wake_requested: "next_turn", reply_to_id: null, dedupe_key: null } },
    { args: ["message", "list", "ises_1", "--unread-by", "agt_1", "--thread", "msg_1", "--after", "3", "--limit", "10"], method: "GET", path: "/api/sessions/ises_1/messages", query: { unread_by: "agt_1", thread: "msg_1", after_seq: "3", limit: "10" } },
    { args: ["message", "get", "msg_1"], method: "GET", path: "/api/messages/msg_1" },
    { args: ["message", "edit", "msg_1", "--content", "Edited"], method: "PATCH", path: "/api/messages/msg_1", body: { body_md: "Edited" } },
    { args: ["message", "delete", "msg_1", "--yes"], method: "DELETE", path: "/api/messages/msg_1" },
    { args: ["message", "resolve", "msg_1", "--no-resolved"], method: "POST", path: "/api/messages/msg_1/resolve", body: { resolved: false } },
    { args: ["message", "react", "msg_1", "--emoji", "ok", "--remove"], method: "POST", path: "/api/messages/msg_1/reactions", body: { emoji: "ok", remove: true } },
    { args: ["inbox", "--limit", "5", "--cursor", "next"], method: "GET", path: "/api/inbox", query: { limit: "5", cursor: "next" } },
    { args: ["inbox", "read", "ises_1", "--to", "7"], method: "POST", path: "/api/inbox/read", body: { session_id: "ises_1", to_seq: 7 } },
    { args: ["inbox", "read-all"], method: "POST", path: "/api/inbox/read", body: { all: true } },
    { args: ["turn", "list", "--issue", "MUL-508", "--agent", "agt_1", "--status", "pending"], method: "GET", path: "/api/turns", query: { issue: "MUL-508", agent: "agt_1", status: "pending" } },
    { args: ["turn", "get", "tsk_root", "--input", "--attempts"], method: "GET", path: "/api/turns/tsk_root", query: { input: "true", attempts: "true" } },
    { args: ["turn", "cancel", "tsk_root", "--yes", "--reason", "Stop"], method: "POST", path: "/api/turns/tsk_root/cancel", body: { reason: "Stop" } },
    { args: ["turn", "wrap-up", "tsk_root", "--reason", "Finish"], method: "POST", path: "/api/turns/tsk_root/wrap-up", body: { reason: "Finish" } },
    { args: ["turn", "retry", "tsk_root", "--cold", "--yes"], method: "POST", path: "/api/turns/tsk_root/retry", body: { cold: true } },
    { args: ["turn", "trace", "read", "tsk_root", "--attempt", "tsk_attempt", "--after", "5", "--limit", "20"], method: "GET", path: "/api/turns/tsk_root/trace", query: { attempt_id: "tsk_attempt", after_seq: "5", limit: "20" } },
  ];
  for (const sample of cases) it(sample.args.slice(0, sample.args[0] === "inbox" ? 2 : sample.args[1] === "trace" ? 3 : 2).join(" "), async () => {
    setup();
    await registry.execute([...sample.args, "--output", "json"]);
    expect(requests.length).toBe(2);
    const request = requests[1]!, url = new URL(request.url);
    expect(request.method).toBe(sample.method);
    expect(url.pathname).toBe(sample.path);
    expect(request.headers.get("X-Workspace-ID")).toBe("local");
    expect(request.headers.get("Authorization")).toBe("Bearer fixture");
    for (const [key, value] of Object.entries(sample.query ?? {})) expect(url.searchParams.get(key)).toBe(value);
    if (sample.body) expect(await request.json()).toEqual(sample.body);
    expect(JSON.parse(output.join("\n"))).toEqual({ id: "msg_1", messages: [], turns: [] });
    expect(warnings).toEqual([]);
  });

  it("uses the claimed Issue conversation without a context request", async () => {
    setup(); process.env.MULTIREMI_ISSUE_SESSION_ID = "ises_env";
    await registry.execute(["message", "send", "--content", "Hi"]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/cli/capabilities", "/api/sessions/ises_env/messages"]);
  });
  it("resolves current conversation and keeps decision options separate from reply selections", async () => {
    setup();
    await registry.execute(["message", "send", "--kind", "decision", "--to", "member:mem_1", "--option", "yes"]);
    expect(new URL(requests[2]!.url).pathname).toBe("/api/sessions/ises_current/messages");
    expect(await requests[2]!.json()).toMatchObject({ to: { type: "member", ref: "mem_1" }, options: [{ label: "yes", value: "yes" }] });
    setup();
    await registry.execute(["message", "send", "ises_1", "--reply-to", "msg_question", "--option", "yes", "--dedupe-key", "click_1"]);
    expect(await requests[1]!.json()).toMatchObject({ message_kind: "reply", reply_to_id: "msg_question", metadata: { selected_options: ["yes"] }, dedupe_key: "click_1" });
  });
  it("renders table and JSONL messages without dropping ids or body", async () => {
    const response = { messages: [{ id: "msg_1", session_id: "ises_1", seq: 7, message_kind: "reply", body_md: "Answer" }] };
    setup(response); await registry.execute(["message", "list", "ises_1"]);
    expect(output.join("\n")).toContain("msg_1"); expect(output.join("\n")).toContain("Answer");
    setup(response); await registry.execute(["message", "list", "ises_1", "--output", "jsonl"]);
    expect(JSON.parse(output[0]!)).toEqual(response.messages[0]);
  });
  for (const mode of ["table", "json", "jsonl"]) it(`reads every range page and rejoins Unicode bodies in ${mode}`, async () => {
    setup();
    const body = "😀正文".repeat(10_000);
    const cursor = '{"seq":1,"offset":32000}';
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.pathname === "/api/cli/capabilities") return fetch(input, init);
      requests.push(request);
      expect(url.pathname).toBe("/api/sessions/ises_1/messages");
      expect(url.searchParams.get("from")).toBe("0");
      expect(url.searchParams.get("to")).toBe("50");
      const continuation = url.searchParams.get("cursor");
      expect(continuation).toBe(requests.length === 2 ? null : cursor);
      return Response.json(continuation
        ? { entries: [{ seq: 1, id: "msg_1", body_md: body.slice(32_000), body_offset: 32_000, body_omitted_chars: 0 },
          { seq: 50, id: "msg_50", body_md: "LAST_ENTRY", body_offset: 0 }], next_cursor: null }
        : { entries: [{ seq: 1, id: "msg_1", body_md: body.slice(0, 32_000), body_offset: 0, body_omitted_chars: body.length - 32_000 }], next_cursor: cursor });
    }) as typeof fetch;
    await registry.execute(["message", "list", "ises_1", "--from", "0", "--to", "50", "--output", mode]);
    expect(requests).toHaveLength(3);
    if (mode === "table") {
      expect(output.join("\n")).toContain(body);
      expect(output.join("\n")).toContain("LAST_ENTRY");
    } else {
      const entries = mode === "json" ? JSON.parse(output.join("\n")) : output.map(line => JSON.parse(line));
      expect(entries).toMatchObject([{ seq: 1, body_md: body, body_omitted_chars: 0 }, { seq: 50, body_md: "LAST_ENTRY" }]);
    }
  });
  it("rejects a range cursor that does not advance", async () => {
    setup({ entries: [], next_cursor: '{"seq":1,"offset":1}' });
    await expect(registry.execute(["message", "list", "ises_1", "--from", "0", "--to", "2"])).rejects.toThrow("cursor did not advance");
    expect(requests).toHaveLength(3);
  });
  it("validates content, choices, wake, confirmations and legacy inbox ids before requests", async () => {
    for (const args of [
      ["message", "send", "ises_1"], ["message", "send", "ises_1", "--content", "Hi", "--kind", "bad"],
      ["message", "send", "ises_1", "--content", "Hi", "--wake", "bad"],
      ["message", "send", "ises_1", "--content", "Hi", "--output", "bad"],
      ["message", "send", "ises_1", "--content", "Hi", "--to-type", "bad"],
      ["message", "send", "ises_1", "--kind", "decision", "--option", "{}"],
      ["message", "delete", "msg_1"], ["turn", "cancel", "tsk_1"], ["turn", "retry", "tsk_1"],
      ["inbox", "read", "inb_old"], ["inbox", "read", "ises_1", "--to", "-1"],
      ...[
        ["--from", "0"], ["--to", "2"], ["--from", "-1", "--to", "2"], ["--from", "2", "--to", "1"],
        ["--from", "0", "--to", "9007199254740992"],
        ...["unread-by", "thread", "kind", "after", "limit", "cursor", "query"].map(flag => ["--from", "0", "--to", "2", `--${flag}`, "1"]),
      ].map(flags => ["message", "list", "ises_1", ...flags]),
    ]) {
      setup(); await expect(registry.execute(args)).rejects.toThrow(); expect(requests).toEqual([]);
    }
  });
  it("uploads the body and each bounded local file in a single mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-cli-"));
    try {
      const path = join(dir, "report.html"); await writeFile(path, "<p>Result</p>");
      setup(); await registry.execute(["message", "send", "ises_1", "--content", "Report", "--attachment", path]);
      const form = await requests[1]!.formData();
      expect(JSON.parse(String(form.get("message"))).body_md).toBe("Report");
      expect(await (form.get("file") as File).text()).toBe("<p>Result</p>");
      await truncate(path, 21 * 1024 * 1024);
      setup(); await expect(registry.execute(["message", "send", "ises_1", "--attachment", path])).rejects.toThrow("20MB");
      expect(requests).toEqual([]);
      await truncate(path, 0);
      setup(); await expect(registry.execute(["message", "send", "ises_1", "--attachment", path])).rejects.toThrow("empty");
      expect(requests).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("prints each wake explanation from actual applied wake values", async () => {
    for (const [applied, reason, expected] of [
      ["next_turn", "agent_pair_not_privileged", "已降为下一轮：对方不是你的组长或父单负责人"],
      ["next_turn", "pair_round_trip_limit", "已降为下一轮：和 agt_1 的来回已达 5 次上限，等人介入"],
      ["inbox_only", "self", "只留言：不能叫醒自己"],
      ["inbox_only", "recipient_unavailable", "只留言：收件人已归档"],
      ["next_turn", "dependencies_unmet", "已降为下一轮：目标单的依赖还没满足"],
      ["inbox_only", "source_side_session", "只留言：旁支会话不能派活"],
    ] as const) {
      setup({ message: { id: "msg_1", to_agent_id: "agt_1" }, wake_applied: applied, wake_reason: reason });
      await registry.execute(["message", "send", "ises_1", "--content", "Hi", "--wake", "now", "--output", "json"]);
      expect(warnings).toEqual([expected]);
      expect(JSON.parse(output[0]!)).toMatchObject({ message: { id: "msg_1" }, wake_applied: applied, wake_reason: reason });
    }
    expect(wakeExplanation({ wake_applied: "now", wake_reason: "human_sender" }, "mem_1")).toBeNull();
  });
  it("keeps a 200 pair-limit send successful without retrying or losing its wake fields", async () => {
    const response = { message: { id: "msg_limited", to_agent_id: "agt_1" }, wake_applied: "next_turn", wake_reason: "pair_round_trip_limit" };
    setup(response);
    await registry.execute(["message", "send", "ises_1", "--to", "agt_1", "--content", "Dispatch", "--output", "json"]);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(response);
    expect(warnings).toEqual(["已降为下一轮：和 agt_1 的来回已达 5 次上限，等人介入"]);
  });
});

describe("retired commands never negotiate capabilities or touch the network", () => {
  it("directs new responsibility questions to native AUQ rather than another decision message", async () => {
    setup();
    const guidance = "原生 AskUserQuestion；先用 remi issue responsibility <issue> 查看责任归属";
    expect(RETIRED_CLI_COMMANDS["issue decision request"]).toBe(guidance);
    expect(RETIRED_CLI_ROUTES["POST /api/issues/:id/decisions"]).toBe(guidance);
    for (const route of ["POST /api/tasks/:id/human-requests/:requestId/respond", "POST /api/multiremi/tasks/:id/human-requests/:requestId/respond"]) {
      expect(RETIRED_CLI_ROUTES[route]).toBe(RETIRED_CLI_COMMANDS["task request respond"]!);
    }
    await expect(dispatch(["issue", "decision", "request", "issue_1"])).rejects.toThrow(guidance);
    expect(requests).toEqual([]);
  });
  for (const [path, replacement] of Object.entries(RETIRED_CLI_COMMANDS)) it(path, async () => {
    setup();
    const args = [...path.split(" "), "legacy_id", "--attachment", "/missing", "--old-option"];
    await expect(dispatch(args)).rejects.toThrow(`已移除：改用 ${replacement}`);
    await expect(runMultiremi(args)).rejects.toThrow(`已移除：改用 ${replacement}`);
    expect(requests).toEqual([]); expect(output).toEqual([]); expect(warnings).toEqual([]);
  });
  it("covers the union of old specs and aliases in the visible dispatcher inventory", () => {
    const inventory = cliCommandInventory();
    for (const spec of [...collaborationCommandSpecs(), ...operationsCommandSpecs()]) {
      if (!(spec.path.join(" ") in RETIRED_CLI_COMMANDS)) continue;
      for (const path of [spec.path, ...(spec.aliases ?? []).map((alias) => alias.path)]) {
        const retired = inventory.find((entry) => entry.path.join(" ") === path.join(" "));
        expect(retired?.retired?.replacement).toBe(RETIRED_CLI_COMMANDS[path.join(" ")]);
        expect(retired?.capability).toBeNull(); expect(retired?.aliases).toEqual([]);
      }
    }
  });
  it("rejects direct Issue legacy exports and an old inbox item before parsing old flags", async () => {
    setup();
    await expect(issue(["runs", "MUL-508"], {})).rejects.toThrow("已移除：");
    await expect(issueComment(["add", "MUL-508"], {})).rejects.toThrow("已移除：");
    await expect(dispatch(["inbox", "read", "inb_old", "--old-flag"])).rejects.toThrow("已移除：");
    expect(requests).toEqual([]);
  });
  it("prints only the removal sentence through the real CLI entry point while offline", async () => {
    const process = Bun.spawn(["bun", "apps/remi/main.ts", "task", "create", "--old-flag"], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...globalThis.process.env, MULTIREMI_SERVER_URL: "invalid-offline-url", MULTIREMI_TOKEN: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await process.exited;
    expect(code).not.toBe(0);
    expect(await new Response(process.stdout).text()).toBe("");
    expect(await new Response(process.stderr).text()).toBe("已移除：改用 remi message send --to <agent> --kind request\n");
  });
});
