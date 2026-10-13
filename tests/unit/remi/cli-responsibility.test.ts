import { afterEach, describe, expect, it } from "bun:test";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { responsibilityCommandSpecs } from "../../../apps/remi/cli/commands/responsibility.js";
import { collaborationCommandSpecs } from "../../../apps/remi/cli/commands/collaboration.js";
import { workspaceCommandSpecs } from "../../../apps/remi/cli/commands/workspace.js";
import { issueAssign, issueUpdate } from "../../../apps/remi/cli/multiremi/commands/issue.js";
import { classifyRoute } from "../../../scripts/generate-cli-capabilities.js";
import { RETIRED_CLI_COMMANDS, assertNotRetired } from "../../../apps/remi/cli/core/retired-commands.js";
import { RETIRED_CLI_ROUTES } from "../../../packages/server/src/api/retired-cli-routes.js";
const specs = [...responsibilityCommandSpecs(), ...workspaceCommandSpecs().filter(command => ["workspace.issue-topics.set", "workspace.feishu-bot.set"].includes(command.id))];
const registry = new CommandRegistry();
for (const command of specs) registry.register(command);
const fetchBefore = globalThis.fetch, logBefore = console.log, errorBefore = console.error;
const envNames = ["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN"] as const;
const envBefore = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let requests: Request[] = [];
function setup() {
  requests = [];
  process.env.MULTIREMI_SERVER_URL = "http://responsibility.test";
  process.env.MULTIREMI_WORKSPACE_ID = "local";
  process.env.MULTIREMI_TOKEN = "fixture";
  console.log = () => {}; console.error = () => {};
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (new URL(request.url).pathname === "/api/cli/capabilities") return Response.json({ commands: specs.map(command => ({ id: command.id, allowed: true })) });
    if (new URL(request.url).pathname === "/api/workspaces/local") return Response.json({ id: "local", name: "Synthetic workspace" });
    return Response.json({ question: { id: "q" }, questions: [] });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = fetchBefore; console.log = logBefore; console.error = errorBefore;
  for (const name of envNames) { if (envBefore[name] === undefined) delete process.env[name]; else process.env[name] = envBefore[name]; }
});
/** Each retired command and the HTTP routes it used, sharing one replacement text. */
const retiredPairs: Array<[string, string[]]> = [
  ["issue delivery list", ["GET /api/issues/:id/deliveries"]],
  ["issue delivery submit", ["POST /api/issues/:id/deliveries"]],
  ["issue delivery accept", ["POST /api/issues/:id/deliveries/:deliveryId/respond"]],
  ["issue delivery return", ["POST /api/issues/:id/deliveries/:deliveryId/respond"]],
  ["issue delivery authorize", ["POST /api/issues/:id/deliveries/:deliveryId/authorize"]],
  ["issue responsibility-unassigned list", ["GET /api/workspaces/:workspaceId/issue-responsibility-migration"]],
  ["issue responsibility-unassigned map", ["POST /api/workspaces/:workspaceId/issue-responsibility-migration/map"]],
  ["issue done-grant add", ["POST /api/issues/:id/parent-done-grant", "POST /api/multiremi/issues/:id/parent-done-grant"]],
  ["issue done-grant remove", ["DELETE /api/issues/:id/parent-done-grant", "DELETE /api/multiremi/issues/:id/parent-done-grant"]],
  ["message question transfer", ["POST /api/messages/:id/question/transfer"]],
  ["issue responsible set", []],
  ["autopilot responsible set", []],
];
describe("responsibility CLI", () => {
  it("keeps execution assignment visible in generated help, with no formal acceptance left", () => {
    const issueHelp = new CommandRegistry();
    for (const command of collaborationCommandSpecs().filter(command => ["issue.assign", "issue.update", "issue.status"].includes(command.id))) issueHelp.register(command);
    expect(issueHelp.renderHelp(["issue", "assign"])).toContain("agent|squad");
    expect(issueHelp.renderHelp(["issue", "assign"])).not.toContain("agent|member|squad");
    for (const action of ["update", "status"]) {
      expect(issueHelp.renderHelp(["issue", action])).toContain("Override the unfinished-child and dependency guards as a member");
      expect(issueHelp.renderHelp(["issue", action])).not.toContain("formal delivery");
    }
    expect(registry.renderHelp(["message", "question", "answer"])).toContain("--revision");
    expect(registry.renderHelp(["message", "question", "answer"])).toContain("--answer-revision");
    expect(registry.renderHelp(["message", "question", "escalate"])).toContain("next execution owner");
  });
  it("advertises only the authentication kinds accepted by responsibility APIs", () => {
    for (const [ids, auth] of [[["message.question.continue"], ["human"]], [["message.question.present", "message.question.escalate"], ["task"]],
      [["message.question.answer", "message.question.close", "issue.responsibility", "issue.question.list", "message.question.get"], ["human", "task"]]] as const) {
      for (const id of ids) {
        expect(specs.find(command => command.id === id)?.auth, id).toEqual([...auth]);
        expect(registry.inventory().find(command => command.id === id)?.auth, id).toEqual([...auth]);
      }
    }
    // Designated humans, formal delivery and transfer are gone from the executable commands.
    for (const id of ["issue.responsibility-unassigned.list", "issue.responsibility-unassigned.map", "issue.responsible.set", "autopilot.responsible.set",
      "issue.delivery.list", "issue.delivery.submit", "issue.delivery.accept", "issue.delivery.return", "issue.delivery.authorize", "message.question.transfer"]) {
      expect(specs.find(command => command.id === id), id).toBeUndefined();
    }
  });
  it("maps every live responsibility API to a registered executable command and classifies retired ones", () => {
    const mappings = {
      "GET /api/issues/:id/responsibility": "issue.responsibility",
      "GET /api/issues/:id/questions": "issue.question.list", "GET /api/messages/:id/question": "message.question.get",
      ...Object.fromEntries(["answer", "escalate", "present", "continue", "close"].map(action => [`POST /api/messages/:id/question/${action}`, `message.question.${action}`])),
    };
    expect(Object.keys(mappings)).toHaveLength(8);
    for (const [route, command] of Object.entries(mappings)) {
      expect(classifyRoute(route)).toEqual({ command });
      expect(specs.find(spec => spec.id === command)?.run).toBeFunction();
    }
    for (const route of retiredPairs.flatMap(([, routes]) => routes)) {
      expect(classifyRoute(route), route).toEqual({ cli_exempt: true, category: "retired_route", reason: `已移除：改用 ${RETIRED_CLI_ROUTES[route]}` });
    }
  });
  it("retires delivery, mapping, designated-human, grant and transfer commands with the same replacement as their routes", () => {
    for (const [command, routes] of retiredPairs) {
      expect(RETIRED_CLI_COMMANDS[command], command).toBeString();
      expect(() => assertNotRetired(command.split(" ")), command).toThrow(`已移除：改用 ${RETIRED_CLI_COMMANDS[command]}`);
      for (const route of routes) expect(RETIRED_CLI_ROUTES[route], route).toBe(RETIRED_CLI_COMMANDS[command]!);
    }
  });
  it("reads all question history pages and deduplicates overlapping rows", async () => {
    setup();
    const normalFetch = globalThis.fetch;
    const printed: unknown[] = []; console.log = value => { printed.push(value); };
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (!url.pathname.endsWith("/questions")) return normalFetch(input, init);
      requests.push(request);
      return Response.json(url.searchParams.has("before") ? { questions: [{ id: "recent" }, { id: "older" }], nextCursor: null } : { questions: [{ id: "recent" }], nextCursor: "recent" });
    }) as typeof fetch;
    await registry.execute(["issue", "question", "list", "root", "--output", "json"]);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith("/questions"))).toHaveLength(2);
    expect(new URL(requests.at(-1)!.url).searchParams.get("before")).toBe("recent");
    expect(JSON.stringify(printed)).toContain("older");
  });
  it("rejects new human execution assignment without any request", async () => {
    setup();
    await expect(issueAssign("root", { to: "mem_human" })).rejects.toThrow("Execution assignee must be an Agent or Squad");
    await expect(issueUpdate("root", { assignee: "human", "assignee-type": "member" })).rejects.toThrow("Execution assignee must be an Agent or Squad");
    expect(requests).toHaveLength(0);
  });
  const cases: Array<{ args: string[]; method: string; path: string; body?: unknown }> = [
    // The bot's member handles Chat questions without an Issue.
    { args: ["workspace", "feishu-bot", "set", "local", "--disabled", "--responsible-member", "human"], method: "PUT", path: "/api/workspaces/local/feishu-bot", body: { enabled: false, responsible_member_id: "human" } },
    { args: ["workspace", "feishu-bot", "set", "local", "--disabled", "--clear-responsible"], method: "PUT", path: "/api/workspaces/local/feishu-bot", body: { enabled: false, responsible_member_id: null } },
    // Issue topics designate nobody: the deprecated flags are accepted and send nothing.
    { args: ["workspace", "issue-topics", "set", "local", "--disabled", "--responsible-member", "human"], method: "PUT", path: "/api/workspaces/local/issue-topics", body: { enabled: false } },
    { args: ["workspace", "issue-topics", "set", "local", "--disabled", "--inherit-bot-responsible"], method: "PUT", path: "/api/workspaces/local/issue-topics", body: { enabled: false } },
    { args: ["issue", "responsibility", "root"], method: "GET", path: "/api/issues/root/responsibility" },
    { args: ["issue", "question", "list", "child"], method: "GET", path: "/api/issues/child/questions" },
    { args: ["message", "question", "get", "q"], method: "GET", path: "/api/messages/q/question" },
    { args: ["message", "question", "answer", "q", "--revision", "3", "--data", '{"response":{"answers":{"Why?":"Evidence"}}}'], method: "POST", path: "/api/messages/q/question/answer", body: { expected_route_revision: 3, response: { answers: { "Why?": "Evidence" } } } },
    { args: ["message", "question", "answer", "q", "--revision", "3", "--data", '{"response":{"selected_options":["allow"]}}'], method: "POST", path: "/api/messages/q/question/answer", body: { expected_route_revision: 3, response: { selected_options: ["allow"] } } },
    { args: ["message", "question", "answer", "q", "--revision", "3", "--revise", "--answer-revision", "2", "--reason", "Correction", "--data", '{"response":{"answer":"Revised"}}'], method: "POST", path: "/api/messages/q/question/answer", body: { expected_route_revision: 3, expected_answer_revision: 2, revise: true, reason: "Correction", response: { answer: "Revised" } } },
    ...["escalate", "close"].map(action => ({ args: ["message", "question", action, "q", "--revision", "3", "--reason", "Need parent"], method: "POST", path: `/api/messages/q/question/${action}`, body: { expected_route_revision: 3, reason: "Need parent" } })),
    { args: ["message", "question", "present", "q", "--revision", "3", "--summary", "Separate advice"], method: "POST", path: "/api/messages/q/question/present", body: { expected_route_revision: 3, summary: "Separate advice" } },
    { args: ["message", "question", "continue", "q", "--revision", "3"], method: "POST", path: "/api/messages/q/question/continue", body: { expected_route_revision: 3 } },
  ];
  for (const item of cases) it(item.args.slice(0, 3).join(" ") + (item.args.includes("--revise") ? " --revise" : ""), async () => {
    setup(); await registry.execute([...item.args, "--output", "json"]);
    const request = requests.find(request => new URL(request.url).pathname === item.path)!;
    expect(request).toBeDefined(); expect(request.method).toBe(item.method);
    if (item.body) expect(await request.json()).toEqual(item.body);
  });
  it("rejects missing routing reasons and unauthorized revision shapes without mutation HTTP", async () => {
    for (const args of [
      ["message", "question", "escalate", "q", "--revision", "3"],
      ["message", "question", "answer", "q", "--revision", "3", "--data", '{"response":[]}'],
      ["message", "question", "answer", "q", "--revision", "3", "--revise", "--data", '{"response":{}}'],
      ["message", "question", "answer", "q", "--data", '{"response":{"option_id":"allow"}}'],
    ]) { setup(); await expect(registry.execute(args)).rejects.toThrow(); expect(requests.filter(request => request.method !== "GET")).toHaveLength(0); }
    setup();
    await expect(registry.execute(["message", "question", "answer", "q", "--revision", "3", "--data", '{"answers":{}}'])).rejects.toThrow("answers, selected_options or option_id");
  });
});
