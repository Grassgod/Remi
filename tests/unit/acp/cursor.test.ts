import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProvider, CursorAdapter, createAdapter, ensureCursorAgent, resolveAcpHealthCheckCommand } from "@acp/index.js";
import { cursorPlanResult, cursorQuestionForm, cursorQuestionResult } from "@acp/cursor-interactions.js";
import { AcpClient } from "@acp/client.js";
import { elicitationToQuestions } from "@shared/contracts/acp-elicitation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remi-cursor-")));
  roots.push(root);
  return root;
}

describe("Cursor runtime", () => {
  it.each([
    [{ unexpected: [] }, "invalid model capabilities"],
    [{ models: [] }, "did not advertise any models"],
    [{ models: [{ value: "sonnet", name: "Sonnet" }] }, "invalid model capabilities"],
    [{ models: [{ value: "sonnet", name: "Sonnet", configOptions: [{ id: "effort", type: "select" }] }] }, "invalid model capabilities"],
  ] as const)("rejects an invalid native model catalog %j", async (response, message) => {
    const client = new AcpClient({ agentType: "cursor" });
    const request = spyOn(client as any, "_request").mockResolvedValue(response);
    try {
      await expect(client.listCursorModels()).rejects.toThrow(message);
      expect(request).toHaveBeenCalledWith("cursor/list_available_models", {});
    } finally { request.mockRestore(); }
  });

  it("starts ACP when the Agent's custom argument list is empty", () => {
    const provider = new AcpProvider({ agentType: "cursor", executable: "/fixture/cursor-agent", args: [] });
    expect((provider as any)._resolveLaunch()).toEqual({ executable: "/fixture/cursor-agent", args: ["acp"], pinned: false });
  });
  it("requires a valid managed installation or explicit executable at launch time", () => {
    const home = process.env.REMI_HOME, override = process.env.REMI_CURSOR_AGENT_EXECUTABLE;
    try {
      process.env.REMI_HOME = temporaryDirectory();
      delete process.env.REMI_CURSOR_AGENT_EXECUTABLE;
      const provider = new AcpProvider({ agentType: "cursor" });
      expect(() => (provider as any)._resolveLaunch()).toThrow("cursor_not_installed");
      process.env.REMI_CURSOR_AGENT_EXECUTABLE = join(process.env.REMI_HOME, "missing-agent");
      expect(() => (provider as any)._resolveLaunch()).toThrow("cursor_not_installed");
    } finally {
      if (home === undefined) delete process.env.REMI_HOME; else process.env.REMI_HOME = home;
      if (override === undefined) delete process.env.REMI_CURSOR_AGENT_EXECUTABLE; else process.env.REMI_CURSOR_AGENT_EXECUTABLE = override;
    }
  });
  it.each([
    ["task", "Agent"], ["updateTodos", "TodoWrite"], ["askQuestion", "AskUserQuestion"], ["createPlan", "TodoWrite"],
  ])("recognizes Cursor's %s tool marker", (nativeName, expected) => {
    const adapter = new CursorAdapter();
    const rawInput = { _toolName: nativeName, name: "Refactor the handler", description: "Find the call sites" };
    const update = { sessionUpdate: "tool_call" as const, toolCallId: "tool", kind: "other" as const, title: "Cursor tool", rawInput };
    expect(adapter.resolveToolName(update)).toBe(expected);
    expect(adapter.resolveToolName({ ...update, rawInput: JSON.stringify(rawInput) })).toBe(expected);
    expect(adapter.extractToolInput(update)).toMatchObject(rawInput);
  });

  it("locates an explicit CLI without executing an installer or health command", async () => {
    const executable = join(temporaryDirectory(), "cursor-agent");
    writeFileSync(executable, "#!/bin/sh\nexit 99\n");
    chmodSync(executable, 0o755);
    expect(await ensureCursorAgent({ env: { REMI_CURSOR_AGENT_EXECUTABLE: executable } })).toEqual({ executable, args: ["acp"] });
    expect(resolveAcpHealthCheckCommand("cursor", executable, "cursor-agent")).toEqual({ command: executable });
    await expect(ensureCursorAgent({ env: { REMI_CURSOR_AGENT_EXECUTABLE: `${executable}-missing` } })).rejects.toThrow("cursor_not_installed");
    const adapter = createAdapter("cursor");
    expect(adapter).toBeInstanceOf(CursorAdapter);
    expect(adapter.nativeSubagents).toEqual({ airCapability: false });
    expect(adapter.steering).toBeUndefined();
    expect(adapter.asyncTasks).toBeUndefined();
  });

  it("preserves question labels in Remi and returns Cursor option IDs", () => {
    const params = { title: "Approach", questions: [
      { id: "q-id", prompt: "Which approach?", options: [{ id: "a-id", label: "Small change" }, { id: "b-id", label: "Full rewrite" }] },
      { id: "q-multi", prompt: "Which checks?", allowMultiple: true, options: [{ id: "unit", label: "Unit tests" }, { id: "types", label: "Type check" }] },
    ] };
    const form = cursorQuestionForm("s", params);
    expect(elicitationToQuestions(form)?.map((entry) => entry.question)).toEqual([
      { question: "Which approach?", header: "Approach", options: [{ label: "Small change" }, { label: "Full rewrite" }], multiSelect: false },
      { question: "Which checks?", header: "Approach", options: [{ label: "Unit tests" }, { label: "Type check" }], multiSelect: true },
    ]);
    expect(cursorQuestionResult(params, { action: "accept", content: { question_0: "Small change", question_1: "Unit tests, Type check" } })).toEqual({
      outcome: { outcome: "answered", answers: [{ questionId: "q-id", selectedOptionIds: ["a-id"] }, { questionId: "q-multi", selectedOptionIds: ["unit", "types"] }] },
    });
    expect(cursorQuestionResult(params, { action: "accept", content: { question_0: "Use a staged migration", question_1: "Unit tests, Type check" } })).toEqual({
      outcome: { outcome: "skipped", reason: "The user provided these answers:\n\nWhich approach?\nUse a staged migration\n\nWhich checks?\nUnit tests, Type check" },
    });
    expect(cursorPlanResult({ action: "cancel" })).toEqual({ outcome: { outcome: "cancelled" } });
    expect(cursorPlanResult({ action: "accept", content: { decision: "Reject plan" } })).toEqual({ outcome: { outcome: "rejected" } });
  });

  it("negotiates models, loads history, and routes Cursor questions through the existing handler", async () => {
    const root = temporaryDirectory();
    const home = join(root, "home"), project = join(root, "project");
    mkdirSync(home); mkdirSync(project);
    const log = join(root, "wire.jsonl"), script = join(root, "agent.cjs");
    writeFileSync(script, `
const fs = require("node:fs");
const readline = require("node:readline");
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
const send = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0", ...value}) + "\\n");
log({cwd:process.cwd()});
let prompt, sessionId, questions = false;
let configOptions = [
 {id:"model",name:"Model",category:"model",type:"select",currentValue:"auto",options:[{value:"auto",name:"Auto"},{value:"sonnet",name:"Sonnet"},{value:"default",name:"Provider default"}]},
 {id:"thinking",name:"Thinking",category:"thought_level",type:"select",currentValue:"low",options:[{value:"low",name:"Low"},{value:"high",name:"High"}]}
];
readline.createInterface({input:process.stdin}).on("line", line => {
 const msg = JSON.parse(line); log(msg);
 const ok = result => send({id:msg.id,result});
 if (msg.id === "question") {
   if (msg.result.outcome.outcome === "cancelled") {send({id:prompt,result:{stopReason:"end_turn"}});return;}
   send({id:"plan",method:"cursor/create_plan",params:{toolCallId:"plan-tool",name:"Refactor",overview:"Small refactor",plan:"Update the handler"}}); return;
 }
 if (msg.id === "plan") {send({id:prompt,result:{stopReason:"end_turn"}});return;}
 if (msg.method === "initialize") return ok({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{subagents:{}}}});
 if (msg.method === "session/new" || msg.method === "session/load") {
   sessionId = msg.params.sessionId || "cursor-session";
   return ok({sessionId,configOptions,modes:{currentModeId:"agent",availableModes:[{id:"agent",name:"Agent"},{id:"plan",name:"Plan"}]}});
 }
 if (msg.method === "session/set_mode") return ok({});
 if (msg.method === "cursor/list_available_models") return ok({models:[
   {value:"auto",name:"Auto",configOptions:[]},
   {value:"sonnet",name:"Sonnet",configOptions:[
     {id:"context",name:"Context",category:"model_config",type:"select",currentValue:"200k",options:[{value:"200k",name:"200k"},{value:"1m",name:"1m"}]},
     {id:"thinking",name:"Thinking",category:"thought_level",type:"select",currentValue:"high",options:[{value:"low",name:"Low"},{value:"high",name:"High"}]}
   ]},
   {value:"default",name:"Provider default",configOptions:[]}
 ]});
 if (msg.method === "session/set_config_option") {
   configOptions = configOptions.map(o => o.id === msg.params.configId ? {...o,currentValue:msg.params.value} : o);
   return ok({configOptions});
 }
 if (msg.method === "session/prompt") {
   prompt=msg.id;
   send({id:"question",method:"cursor/ask_question",params:{toolCallId:"ask-tool",questions:[{id:"scope",prompt:"Choose scope",options:[{id:"small",label:"Small"}]}]}});
   if (msg.params.prompt[0].text === "cancel-dialog") setTimeout(() => send({method:"$/cancel_request",params:{requestId:"question"}}),10);
   return;
 }
 if (msg.id != null) send({id:msg.id,error:{code:-32601,message:"Unsupported method"}});
});
`);
    const provider = new AcpProvider({
      agentType: "cursor", executable: process.execPath, args: [script], providerHome: home, cwd: project, nativeSubagentSessions: true,
      getMcpServers: () => [{ name: "remi", command: "/bin/true", args: [], env: [] }],
    });
    const forms: Array<{ sessionId: string; message: string }> = [];
    provider.setElicitationHandler(async (params) => {
      forms.push(params);
      return { action: "accept", content: params.requestedSchema?.properties.decision ? { decision: "Accept plan" } : { question_0: "Small" } };
    });
    try {
      const models = await provider.discoverModelCapabilities();
      expect(models.map((model) => model.id)).toEqual(["auto", "sonnet", "default"]);
      expect(models[0]).toMatchObject({ default: true, effort: { status: "unsupported", supportedLevels: [] } });
      expect(models[1]?.effort?.supportedLevels.map((level) => level.value)).toEqual(["low", "high"]);
      expect(models[1]?.effort?.defaultLevel).toBe("high");
      expect(models[2]).toMatchObject({ default: false, providerDefault: true, effort: { status: "unsupported" } });
      const probeCalls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(probeCalls.filter((record) => record.method === "cursor/list_available_models").map((record) => record.params)).toEqual([{}]);
      expect(probeCalls.some((record) => record.method === "session/set_config_option")).toBe(false);
      await provider.send("continue", { chatId: "chat", sessionId: "previous-session", cwd: project, model: "sonnet", effort: "high" });
      provider.setElicitationHandler(() => new Promise(() => {}));
      await provider.send("cancel-dialog", { chatId: "chat", cwd: project });
      provider.setElicitationHandler(async () => { throw new Error("Question UI closed"); });
      await provider.send("handler-error", { chatId: "chat", cwd: project });
      await expect(provider.send("bad model", { chatId: "chat", cwd: project, model: "missing-model" })).rejects.toThrow("acp_model_unsupported");
    } finally { await provider.close(); }
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ cwd: home });
    const init = records.find((record) => record.method === "initialize");
    expect(init.params.clientCapabilities._meta.parameterizedModelPicker).toBe(true);
    expect(init.params.clientCapabilities.subagents).toEqual({});
    expect(records.find((record) => record.method === "session/new").params.cwd).toBe(project);
    const load = records.find((record) => record.method === "session/load");
    expect(load.params).toMatchObject({ sessionId: "previous-session", cwd: project, mcpServers: [{ name: "remi" }] });
    expect(records.some((record) => ["authenticate", "session/resume", "session/close"].includes(record.method))).toBe(false);
    expect(records.filter((record) => record.method === "session/set_config_option").map((record) => record.params.value).slice(-2)).toEqual(["sonnet", "high"]);
    expect(forms.map((form) => form.sessionId)).toEqual(["previous-session", "previous-session"]);
    expect(records.find((record) => record.id === "question")?.result).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["small"] }] } });
    expect(records.find((record) => record.id === "plan")?.result).toEqual({ outcome: { outcome: "accepted" } });
    expect(records.filter((record) => record.id === "question").slice(-2).map((record) => record.result)).toEqual([
      { outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } },
    ]);
  });
});
