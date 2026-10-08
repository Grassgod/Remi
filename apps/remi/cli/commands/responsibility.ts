import { CliError, type CommandInvocation, type CommandSpec, type CliOptionSpec } from "../core/index.js";
import { INPUT_OPTIONS, PAGE_OPTIONS, clientFor, commandOptions, encodePath, integerOption, positional, renderResource, requestBody, stringOption } from "./resource-common.js";

const ref = (name: string) => ({ name, required: true });
const revision: CliOptionSpec = { name: "revision", type: "integer", required: true, description: "Current question route_revision (stale handlers are rejected)" };
const reason: CliOptionSpec = { name: "reason", type: "string", description: "Reason for routing or answer revision" };
const content: CliOptionSpec = { name: "summary", type: "string", description: "Delivery or Remi summary" };
function spec(path: string[], description: string, mutation: "read" | "write", positionals: CommandSpec["positionals"], options: readonly CliOptionSpec[], run: CommandSpec["run"], humanOnly = false): CommandSpec {
  return { id: path.join("."), path, description, capability: path.join("."), auth: humanOnly ? ["human"] : ["human", "task"], mutation, outputs: ["table", "json", "jsonl"], positionals, options: commandOptions(options, ...(mutation === "read" ? [PAGE_OPTIONS] : [])), run };
}
async function request(i: CommandInvocation, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, collections: string[] = [], query?: { limit?: number; before?: string; offset?: number }) {
  const result = await (await clientFor(i)).request({ method, path, body, query });
  renderResource(i, result.data, collections);
}
const issuePath = (i: CommandInvocation) => `/api/issues/${encodePath(positional(i, 0, "issue"))}`;
const questionPath = (i: CommandInvocation) => `/api/messages/${encodePath(positional(i, 0, "question"))}/question`;
export function responsibilityCommandSpecs(): CommandSpec[] {
  return [
    spec(["issue", "responsibility-unassigned", "list"], "Inspect historical responsibility, original facts and unconfirmed candidates (workspace admin)", "read", [ref("workspace")], [{ name: "offset", type: "integer", description: "Offset returned by nextOffset" }], i => {
      const limit = integerOption(i, "limit") ?? 100, offset = integerOption(i, "offset") ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new CliError("usage", "Use --limit 1..100 and --offset >=0");
      return request(i, "GET", `/api/workspaces/${encodePath(positional(i, 0, "workspace"))}/issue-responsibility-migration`, undefined, ["items"], { limit, offset });
    }, true),
    spec(["issue", "responsibility-unassigned", "map"], "Explicitly map selected historical roots with reason and current responsibility revisions (workspace admin)", "write", [ref("workspace")], [...INPUT_OPTIONS, reason], async i => {
      const body = await requestBody(i, { reason: stringOption(i, "reason") ?? undefined });
      if (typeof body.reason !== "string" || !body.reason.trim() || !Array.isArray(body.mappings) || !body.mappings.length || body.mappings.some((entry: unknown) => !entry || typeof entry !== "object" || Array.isArray(entry) || ["issueId", "memberId", "revision"].some(key => typeof (entry as Record<string, unknown>)[key] !== "string" || !(entry as Record<string, string>)[key]?.trim()))) throw new CliError("usage", "Mapping requires reason and non-empty mappings [{issueId,memberId,revision}]");
      await request(i, "POST", `/api/workspaces/${encodePath(positional(i, 0, "workspace"))}/issue-responsibility-migration/map`, body);
    }, true),
    spec(["autopilot", "responsible", "set"], "Configure the designated human for future automatic root issues", "write", [ref("autopilot")], [{ name: "member", type: "string", required: true }], i => request(i, "PATCH", `/api/autopilots/${encodePath(positional(i, 0, "autopilot"))}`, { responsible_member_id: stringOption(i, "member") }), true),
    spec(["issue", "responsibility"], "Resolve execution, parent reviewer and designated root human", "read", [ref("issue")], [], i => request(i, "GET", `${issuePath(i)}/responsibility`)),
    spec(["issue", "responsible", "set"], "Explicitly assign or transfer the root human; retains audit history", "write", [ref("issue")], [{ name: "member", type: "string", required: true, description: "Workspace member ID" }], i => request(i, "PATCH", issuePath(i), { responsible_member_id: stringOption(i, "member") }), true),
    spec(["issue", "question", "list"], "List all original questions and routing/answer history", "read", [ref("issue")], [], async i => {
      const client = await clientFor(i);
      const questions = new Map<string, unknown>();
      const seen = new Set<string>();
      let before: string | undefined;
      do {
        const result = await client.request<{ questions: Array<{ id: string }>; nextCursor?: string | null }>({ method: "GET", path: `${issuePath(i)}/questions`, query: { limit: 100, before } });
        for (const question of result.data.questions) if (!questions.has(question.id)) questions.set(question.id, question);
        before = result.data.nextCursor ?? undefined;
        if (before && seen.has(before)) throw new CliError("server", "Server repeated a question page cursor");
        if (before) seen.add(before);
      } while (before);
      renderResource(i, { questions: [...questions.values()] }, ["questions"]);
    }),
    spec(["issue", "delivery", "list"], "List formal deliveries; --cursor uses the response nextCursor", "read", [ref("issue")], [], i => {
      const limit = integerOption(i, "limit") ?? undefined;
      if (limit != null && (limit < 1 || limit > 100)) throw new CliError("usage", "delivery list --limit must be between 1 and 100");
      return request(i, "GET", `${issuePath(i)}/deliveries`, undefined, ["deliveries"], { limit, before: stringOption(i, "cursor") ?? undefined });
    }),
    spec(["issue", "delivery", "authorize"], "Designated human explicitly authorizes or revokes Agent acceptance of one delivery", "write", [ref("issue"), ref("delivery")], [{ name: "revision", type: "string", required: true, description: "Delivery responsibilityRevision" }, { name: "agent", type: "string", conflictsWith: ["revoke"], description: "Current execution coordinator Agent ID" }, { name: "revoke", type: "boolean", conflictsWith: ["agent"], description: "Revoke this delivery-specific authorization" }], async i => {
      const agentId = stringOption(i, "agent");
      if (!agentId && i.options.revoke !== true) throw new CliError("usage", "delivery authorize requires --agent or --revoke");
      await request(i, "POST", `${issuePath(i)}/deliveries/${encodePath(positional(i, 1, "delivery"))}/authorize`, { agentId: i.options.revoke === true ? null : agentId, revision: stringOption(i, "revision") });
    }, true),
    spec(["issue", "delivery", "submit"], "Submit a formal delivery as this issue's execution coordinator", "write", [ref("issue")], [content, ...INPUT_OPTIONS, { name: "session", type: "string", description: "Source Issue session" }, { name: "dedupe-key", type: "string", description: "Idempotent delivery key" }], async i => {
      const body = await requestBody(i, { summary: stringOption(i, "summary") ?? undefined, sessionId: stringOption(i, "session") ?? undefined, dedupeKey: stringOption(i, "dedupe-key") ?? undefined });
      if (!body || typeof body.summary !== "string" || !body.summary.trim()) throw new CliError("usage", "delivery submit requires a non-empty --summary or JSON summary");
      await request(i, "POST", `${issuePath(i)}/deliveries`, body);
    }),
    ...(["accept", "return"] as const).map(action => spec(["issue", "delivery", action], action === "accept" ? "Accept this exact formal delivery as its reviewer" : "Return this delivery to its execution coordinator", "write", [ref("issue"), ref("delivery")], [{ name: "revision", type: "string", required: true, description: "Delivery responsibilityRevision" }, reason], async i => {
      const body = stringOption(i, "reason") ?? undefined;
      if (action === "return" && !body?.trim()) throw new CliError("usage", "delivery return requires --reason");
      await request(i, "POST", `${issuePath(i)}/deliveries/${encodePath(positional(i, 1, "delivery"))}/respond`, { action, body, revision: stringOption(i, "revision") });
    })),
    spec(["message", "question", "get"], "Read one original Q, current handler and actual consumption state", "read", [ref("question")], [], i => request(i, "GET", questionPath(i))),
    ...(["answer", "escalate", "transfer", "present", "continue", "close"] as const).map(action => spec(["message", "question", action], {
      answer: "Answer or explicitly revise the original Q", escalate: "Escalate the same Q to the next responsible owner", transfer: "Re-resolve and explicitly transfer the same Q after responsibility changes", present: "Attach a Remi summary without changing the original question", continue: "Authorize a detached question's controlled continuation", close: "Explicitly close a business Q while preserving its original history",
    }[action], "write", [ref("question")], [revision, reason, ...(action === "answer" ? [...INPUT_OPTIONS, { name: "revise", type: "boolean", description: "Explicit human answer revision; does not replay the old call" } as CliOptionSpec, { name: "answer-revision", type: "integer", description: "Current answer_revision; required for --revise" } as CliOptionSpec] : []), ...(action === "present" ? [content] : [])], async i => {
      const routeRevision = integerOption(i, "revision");
      if (routeRevision == null || routeRevision < 1) throw new CliError("usage", "--revision must be the current positive route revision");
      const body = action === "answer" ? await requestBody(i) : {};
      if (action === "answer" && (!body.response || typeof body.response !== "object" || Array.isArray(body.response))) throw new CliError("usage", "question answer JSON requires response object (answers or selected_options)");
      const summary = stringOption(i, "summary");
      const routingReason = stringOption(i, "reason");
      const answerRevision = integerOption(i, "answer-revision");
      if (i.options.revise === true && (answerRevision == null || answerRevision < 0 || !routingReason?.trim())) throw new CliError("usage", "--revise requires --answer-revision and --reason");
      if (["escalate", "transfer", "close"].includes(action) && !routingReason?.trim()) throw new CliError("usage", `question ${action} requires --reason`);
      if (action === "present" && !summary?.trim()) throw new CliError("usage", "question present requires --summary");
      await request(i, "POST", `${questionPath(i)}/${action}`, { ...body, expected_route_revision: routeRevision, reason: routingReason ?? undefined, ...(summary ? { summary } : {}), ...(i.options.revise === true ? { revise: true, expected_answer_revision: answerRevision } : {}) });
    }, action === "continue")),
  ];
}
