import { afterEach, describe, expect, it } from "bun:test";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { responsibilityCommandSpecs } from "../../../apps/remi/cli/commands/responsibility.js";
import { workspaceCommandSpecs } from "../../../apps/remi/cli/commands/workspace.js";
import { issueAssign, issueUpdate } from "../../../apps/remi/cli/multiremi/commands/issue.js";
import { classifyRoute } from "../../../scripts/generate-cli-capabilities.js";
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
    return Response.json({ question: { id: "q" }, questions: [], deliveries: [] });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = fetchBefore; console.log = logBefore; console.error = errorBefore;
  for (const name of envNames) { if (envBefore[name] === undefined) delete process.env[name]; else process.env[name] = envBefore[name]; }
});
describe("responsibility CLI", () => {
  it("advertises only the authentication kinds accepted by responsibility APIs", () => {
    const humanOnly = ["issue.responsibility-unassigned.list", "issue.responsibility-unassigned.map", "issue.responsible.set", "autopilot.responsible.set", "issue.delivery.authorize", "message.question.continue"];
    const taskOnly = ["issue.delivery.submit", "message.question.present", "message.question.escalate"];
    for (const id of humanOnly) expect(specs.find(command => command.id === id)?.auth).toEqual(["human"]);
    for (const id of taskOnly) expect(specs.find(command => command.id === id)?.auth).toEqual(["task"]);
    for (const id of ["message.question.answer", "message.question.transfer", "message.question.close", "issue.delivery.accept", "issue.delivery.return"]) expect(specs.find(command => command.id === id)?.auth).toEqual(["human", "task"]);
  });
  it("maps every new responsibility API to a registered executable command", () => {
    const mappings = {
      "GET /api/issues/:id/responsibility": "issue.responsibility",
      "GET /api/issues/:id/deliveries": "issue.delivery.list", "POST /api/issues/:id/deliveries": "issue.delivery.submit",
      "POST /api/issues/:id/deliveries/:deliveryId/respond": "issue.delivery.accept", "POST /api/issues/:id/deliveries/:deliveryId/authorize": "issue.delivery.authorize",
      "GET /api/issues/:id/questions": "issue.question.list", "GET /api/messages/:id/question": "message.question.get",
      "GET /api/workspaces/:id/issue-responsibility-migration": "issue.responsibility-unassigned.list", "POST /api/workspaces/:id/issue-responsibility-migration/map": "issue.responsibility-unassigned.map",
      ...Object.fromEntries(["answer", "escalate", "transfer", "present", "continue", "close"].map(action => [`POST /api/messages/:id/question/${action}`, `message.question.${action}`])),
    };
    expect(Object.keys(mappings)).toHaveLength(15);
    for (const [route, command] of Object.entries(mappings)) {
      expect(classifyRoute(route)).toEqual({ command });
      expect(specs.find(spec => spec.id === command)?.run).toBeFunction();
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
  it("rejects new human execution assignment while keeping root human configuration independent", async () => {
    setup();
    await expect(issueAssign("root", { to: "mem_human" })).rejects.toThrow("Execution assignee must be an Agent or Squad");
    await expect(issueUpdate("root", { assignee: "human", "assignee-type": "member" })).rejects.toThrow("Execution assignee must be an Agent or Squad");
    expect(requests).toHaveLength(0);
  });
  it("reads an explicit formal delivery history page", async () => {
    setup(); await registry.execute(["issue", "delivery", "list", "root", "--limit", "20", "--cursor", "older", "--output", "json"]);
    const request = requests.find(request => new URL(request.url).pathname === "/api/issues/root/deliveries")!;
    expect(new URL(request.url).searchParams.get("limit")).toBe("20");
    expect(new URL(request.url).searchParams.get("before")).toBe("older");
  });
  const cases: Array<{ args: string[]; method: string; path: string; body?: unknown }> = [
    { args: ["workspace", "feishu-bot", "set", "local", "--disabled", "--responsible-member", "human"], method: "PUT", path: "/api/workspaces/local/feishu-bot", body: { enabled: false, responsible_member_id: "human" } },
    { args: ["workspace", "feishu-bot", "set", "local", "--disabled", "--clear-responsible"], method: "PUT", path: "/api/workspaces/local/feishu-bot", body: { enabled: false, responsible_member_id: null } },
    { args: ["workspace", "issue-topics", "set", "local", "--disabled", "--responsible-member", "human"], method: "PUT", path: "/api/workspaces/local/issue-topics", body: { enabled: false, responsible_member_id: "human" } },
    { args: ["workspace", "issue-topics", "set", "local", "--disabled", "--inherit-bot-responsible"], method: "PUT", path: "/api/workspaces/local/issue-topics", body: { enabled: false, responsible_member_id: null } },
    { args: ["issue", "responsibility-unassigned", "list", "local"], method: "GET", path: "/api/workspaces/local/issue-responsibility-migration" },
    { args: ["issue", "responsibility-unassigned", "map", "local", "--reason", "Confirmed", "--data", '{"mappings":[{"issueId":"root","memberId":"human","revision":"v1"}]}'], method: "POST", path: "/api/workspaces/local/issue-responsibility-migration/map", body: { reason: "Confirmed", mappings: [{ issueId: "root", memberId: "human", revision: "v1" }] } },
    { args: ["autopilot", "responsible", "set", "automation", "--member", "human"], method: "PATCH", path: "/api/autopilots/automation", body: { responsible_member_id: "human" } },
    { args: ["issue", "responsibility", "root"], method: "GET", path: "/api/issues/root/responsibility" },
    { args: ["issue", "responsible", "set", "root", "--member", "member"], method: "PATCH", path: "/api/issues/root", body: { responsible_member_id: "member" } },
    { args: ["issue", "question", "list", "child"], method: "GET", path: "/api/issues/child/questions" },
    { args: ["issue", "delivery", "list", "child"], method: "GET", path: "/api/issues/child/deliveries" },
    { args: ["issue", "delivery", "submit", "child", "--summary", "Evidence", "--session", "source", "--dedupe-key", "one"], method: "POST", path: "/api/issues/child/deliveries", body: { summary: "Evidence", sessionId: "source", dedupeKey: "one" } },
    { args: ["issue", "delivery", "accept", "root", "delivery", "--revision", "v1"], method: "POST", path: "/api/issues/root/deliveries/delivery/respond", body: { action: "accept", revision: "v1" } },
    { args: ["issue", "delivery", "return", "root", "delivery", "--revision", "v1", "--reason", "Fix tests"], method: "POST", path: "/api/issues/root/deliveries/delivery/respond", body: { action: "return", revision: "v1", body: "Fix tests" } },
    { args: ["issue", "delivery", "authorize", "root", "delivery", "--revision", "v1", "--agent", "owner"], method: "POST", path: "/api/issues/root/deliveries/delivery/authorize", body: { agentId: "owner", revision: "v1" } },
    { args: ["issue", "delivery", "authorize", "root", "delivery", "--revision", "v1", "--revoke"], method: "POST", path: "/api/issues/root/deliveries/delivery/authorize", body: { agentId: null, revision: "v1" } },
    { args: ["message", "question", "get", "q"], method: "GET", path: "/api/messages/q/question" },
    { args: ["message", "question", "answer", "q", "--revision", "3", "--data", '{"response":{"answers":{"Why?":"Evidence"}}}'], method: "POST", path: "/api/messages/q/question/answer", body: { expected_route_revision: 3, response: { answers: { "Why?": "Evidence" } } } },
    { args: ["message", "question", "answer", "q", "--revision", "3", "--revise", "--answer-revision", "2", "--reason", "Correction", "--data", '{"response":{"answer":"Revised"}}'], method: "POST", path: "/api/messages/q/question/answer", body: { expected_route_revision: 3, expected_answer_revision: 2, revise: true, reason: "Correction", response: { answer: "Revised" } } },
    ...["escalate", "transfer", "close"].map(action => ({ args: ["message", "question", action, "q", "--revision", "3", "--reason", "Need parent"], method: "POST", path: `/api/messages/q/question/${action}`, body: { expected_route_revision: 3, reason: "Need parent" } })),
    { args: ["message", "question", "present", "q", "--revision", "3", "--summary", "Separate advice"], method: "POST", path: "/api/messages/q/question/present", body: { expected_route_revision: 3, summary: "Separate advice" } },
    { args: ["message", "question", "continue", "q", "--revision", "3"], method: "POST", path: "/api/messages/q/question/continue", body: { expected_route_revision: 3 } },
  ];
  for (const item of cases) it(item.args.slice(0, 3).join(" "), async () => {
    setup(); await registry.execute([...item.args, "--output", "json"]);
    const request = requests.find(request => new URL(request.url).pathname === item.path)!;
    expect(request).toBeDefined(); expect(request.method).toBe(item.method);
    if (item.body) expect(await request.json()).toEqual(item.body);
  });
  it("rejects missing routing reasons, empty return and unauthorized revision shapes without mutation HTTP", async () => {
    for (const args of [
      ["message", "question", "escalate", "q", "--revision", "3"],
      ["message", "question", "answer", "q", "--revision", "3", "--data", '{"response":[]}'],
      ["message", "question", "answer", "q", "--revision", "3", "--revise", "--data", '{"response":{}}'],
      ["issue", "delivery", "return", "root", "delivery", "--revision", "v1"],
      ["issue", "responsibility-unassigned", "map", "local", "--data", '{"mappings":[{"issueId":"root","memberId":"human","revision":"v1"}]}'],
      ["issue", "responsibility-unassigned", "map", "local", "--reason", "Confirmed", "--data", '{"mappings":[{"issueId":"root","memberId":"human"}]}'],
    ]) { setup(); await expect(registry.execute(args)).rejects.toThrow(); expect(requests.filter(request => request.method !== "GET")).toHaveLength(0); }
  });
});
