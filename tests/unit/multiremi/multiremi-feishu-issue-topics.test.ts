import { reportFrame } from "../../fixtures/report-session.js";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { IssueTopicConfigError, readWorkspaceIssueTopicsLenient } from "@multiremi/issue-topics/config.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const JSON_HEADERS = { "Content-Type": "application/json", Authorization: "Bearer MASTER" };
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold(options: { online?: boolean } = {}): {
  store: MultiremiStore;
  revision: number;
} {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_issue_topic_owner",
    feishuUnionId: "on_issue_topic_owner",
    email: owner.email,
    name: owner.name,
  });
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_bot",
    name: "Bot host",
    provider: "codex",
    workspaceId: "local",
    daemonId: "bot-host",
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_bot",
    appId: "cli_issue_topics",
    senderAccessPolicy: "allowlist",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  if (options.online !== false) {
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", {
      appliedRevision: config.revision,
      state: "online",
    });
  }
  return { store, revision: config.revision };
}

function configureTopics(store: MultiremiStore, projectIds?: string[]): void {
  const workspace = store.getWorkspace("local")!;
  store.updateWorkspace("local", {
    settings: {
      ...workspace.settings,
      issueTopics: {
        enabled: true,
        chatId: "oc_issue_topics",
        ...(projectIds ? { projectIds } : {}),
      },
    },
  });
}

function prepareReport(store: MultiremiStore) {
  const agent = store.getFeishuBotConfig("local")!.agentId;
  const issue = store.createIssue({ title: "Review requested", workspaceId: "local", assigneeType: "agent", assigneeId: agent });
  store.prepareFeishuIssueTopicWithinTransaction(issue);
  const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
  expect(root.bodyOrigin).toBe("issue");
  expect(root.mention).toBeUndefined();
  store.reportFeishuBotOutbound("local", "rt_bot", root.id, { claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${issue.id}` });
  const leader = store.createTask({ agentId: agent, issueId: issue.id, prompt: "Work on Issue" });
  const wake = store.prepareFeishuIssueRoundPushes({ issue, leaderTask: leader });
  expect(wake).toHaveLength(1);
  return wake[0]!;
}

describe("Feishu Issue topics", () => {
  describe("MUL-531 terminal reports from commented Issues", () => {
    function issueWithTopic(store: MultiremiStore, agentId: string, title: string) {
      const issue = store.createIssue({ title, workspaceId: "local", assigneeType: "agent", assigneeId: agentId });
      store.prepareFeishuIssueTopicWithinTransaction(issue);
      const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
      store.reportFeishuBotOutbound("local", "rt_bot", root.id, {
        claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${issue.id}`,
      });
      return issue;
    }

    for (const scenario of ["bound", "standalone", "cross-issue", "active", "chat"] as const) {
      it(`${scenario}: reports each eligible topic once, with the existing relay dedupe key`, () => {
        const { store } = scaffold();
        configureTopics(store);
        const worker = store.createAgent({ name: "Leader", provider: "codex", workspaceId: "local" });
        const issue = issueWithTopic(store, worker.id, "Review X");
        const second = scenario === "standalone" || scenario === "cross-issue"
          ? issueWithTopic(store, worker.id, "Review Y") : null;
        const third = scenario === "cross-issue" ? issueWithTopic(store, worker.id, "Review Z") : null;
        const boundIssue = scenario === "bound" || scenario === "cross-issue" ? issue : null;
        const chat = scenario === "chat" ? store.createChatSession({ agentId: worker.id }) : null;
        const task = store.createTask({ agentId: worker.id, workspaceId: "local", prompt: "Review work",
          ...(boundIssue ? { issueId: boundIssue.id } : {}),
          ...(chat ? { chatSessionId: chat.id } : {}),
        });
        db!.run("UPDATE multiremi_tasks SET status = 'running', runtime_id = 'rt_bot' WHERE id = ?", [task.id]);
        const targets = [issue, ...(second ? [second] : []), ...(third ? [third] : [])];
        for (const target of targets) {
          // Two comments on one Issue must still produce one report. In the
          // bound case they must not duplicate the existing terminal path.
          for (let i = 0; i < 2; i++) store.createIssueComment(target.id, {
            authorType: "agent", authorId: worker.id, taskId: task.id, body: "## 待合入确认\n请确认 PR。",
          });
        }
        const active = scenario === "active"
          ? store.createTask({ agentId: worker.id, issueId: issue.id, prompt: "Still working" }) : null;
        if (active) db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [active.id]);
        const output = "## 待合入确认\n请确认 PR。";
        const authority = { runtimeId: "rt_bot", workspaceId: "local", daemonId: "bot-host" };
        store.completeTaskFromDaemon(task.id, { output }, authority);
        // The daemon may replay its terminal report after losing the ACK.
        store.completeTaskFromDaemon(task.id, { output }, authority);
        const pushes = db!.query(
          "SELECT issue_id, wake_task_id FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ?",
        ).all(task.id) as { issue_id: string; wake_task_id: string }[];
        const eligible = scenario !== "active" && scenario !== "chat";
        expect(pushes).toHaveLength(eligible ? targets.length : 0);
        for (const target of targets) {
          const topic = store.listChatSessions("local").find(row => store.getFeishuIssueIdForChatSession(row.id) === target.id)!;
          const reports = store.listConversationLogShown(topic.id).filter(entry =>
            entry.metadata.envelope?.dedupeKey === `relay:${target.id}:${task.id}`);
          expect(reports).toHaveLength(eligible ? 1 : 0);
          if (eligible) {
            expect(reports[0].metadata.envelope?.source).toMatchObject({ issueId: target.id, taskId: task.id });
            const push = pushes.find(row => row.issue_id === target.id)!;
            expect(store.getTask(push.wake_task_id)?.chatSessionId).toBe(topic.id);
            expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ?")
              .get(push.wake_task_id)).toEqual({ n: 1 });
          }
        }
        if (active) expect(store.getTask(active.id)?.status).toBe("running");
      });
    }

    for (const status of ["queued", "dispatched", "running", "awaiting_human"] as const) {
      it(`blocks only the Issue with a ${status} task, then its final task reports normally`, () => {
        const { store } = scaffold();
        configureTopics(store);
        const worker = store.createAgent({ name: "Leader", provider: "codex", workspaceId: "local" });
        const blocked = issueWithTopic(store, worker.id, "Still working");
        const ready = issueWithTopic(store, worker.id, "Ready for review");
        const source = store.createTask({ agentId: worker.id, prompt: "Scheduled review" });
        db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [source.id]);
        for (const target of [blocked, ready]) store.createIssueComment(target.id, {
          authorType: "agent", authorId: worker.id, taskId: source.id, body: "## 待合入确认",
        });
        const active = store.createTask({ agentId: worker.id, issueId: blocked.id, prompt: "Continue work" });
        db!.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, active.id]);
        const previousStatus = store.getIssue(ready.id)!.status;
        const events: boolean[] = [];
        const unsubscribe = store.onWorkspaceEvent(() => events.push(db!.inTransaction));
        try { store.completeTask(source.id, { output: "Review both" }); }
        finally { unsubscribe(); }
        expect(events.length).toBeGreaterThan(0);
        expect(events.every(inTransaction => !inTransaction)).toBe(true);
        expect(store.getIssue(ready.id)?.status).toBe(previousStatus);
        expect(db!.query("SELECT issue_id FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ?")
          .all(source.id)).toEqual([{ issue_id: ready.id }]);
        db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [active.id]);
        store.completeTask(active.id, { output: "## 待合入确认" });
        expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes WHERE issue_id = ?")
          .get(blocked.id)).toEqual({ n: 1 });
        expect(store.listConversationLogShown(store.getOrCreateDefaultIssueSession(blocked.id).id)
          .some(entry => entry.body_md === "## 待合入确认")).toBe(true);
      });
    }

    it("ignores comments belonging to another task or a person regardless of their body", () => {
      const { store } = scaffold();
      configureTopics(store);
      const worker = store.createAgent({ name: "Leader", provider: "codex", workspaceId: "local" });
      const issue = issueWithTopic(store, worker.id, "Unrelated review");
      const source = store.createTask({ agentId: worker.id, prompt: `Review ${issue.key}: 待合入确认` });
      const other = store.createTask({ agentId: worker.id, prompt: "Other review" });
      store.createIssueComment(issue.id, { authorType: "agent", authorId: worker.id, taskId: other.id, body: "## 待合入确认" });
      store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: `## 待合入确认\n${source.id}` });
      db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [source.id]);
      store.completeTask(source.id, { output: `## 待合入确认\n${issue.key}` });
      expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ?")
        .get(source.id)).toEqual({ n: 0 });
    });

    it("rolls back reports for every commented Issue and publishes no events if the second topic fails", () => {
      const { store } = scaffold();
      configureTopics(store);
      const worker = store.createAgent({ name: "Scheduled leader", provider: "codex", workspaceId: "local" });
      const issue = issueWithTopic(store, worker.id, "Review X");
      const second = issueWithTopic(store, worker.id, "Review Y");
      const task = store.createTask({ agentId: worker.id, prompt: "Scheduled review" });
      db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [task.id]);
      store.createIssueComment(issue.id, { authorType: "agent", authorId: worker.id, taskId: task.id, body: "## 待合入确认" });
      store.createIssueComment(second.id, { authorType: "agent", authorId: worker.id, taskId: task.id, body: "## 待合入确认" });
      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
      const database = db!;
      const originalRun = database.run;
      let prepared = 0;
      database.run = function (sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (sql.includes("INSERT INTO multiremi_feishu_bot_round_pushes") && ++prepared === 2) {
          throw new Error("MUL-531 rollback injection");
        }
        return result;
      };
      try {
        expect(() => store.completeTask(task.id, { output: "## 待合入确认" })).toThrow("MUL-531 rollback injection");
      } finally {
        database.run = originalRun;
        unsubscribe();
      }
      expect(store.getTask(task.id)?.status).toBe("running");
      expect(prepared).toBe(2);
      expect(events).toEqual([]);
      expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ?")
        .get(task.id)).toEqual({ n: 0 });
      for (const target of [issue, second]) {
        const topic = store.listChatSessions("local").find(row => store.getFeishuIssueIdForChatSession(row.id) === target.id)!;
        expect(store.listConversationLogShown(topic.id).filter(entry =>
          entry.metadata.envelope?.dedupeKey === `relay:${target.id}:${task.id}`)).toHaveLength(0);
      }
    });
  });

  describe("unexpected configuration errors", () => {
    it("propagates an ordinary Error from the settings getter unchanged", () => {
      const failure = new Error("Unexpected settings getter failure");
      const settings = { get issueTopics(): unknown { throw failure; } };
      const onInvalid = spyOn({ report: () => {} }, "report");
      let caught: unknown;
      try {
        readWorkspaceIssueTopicsLenient(settings, onInvalid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(onInvalid).not.toHaveBeenCalled();
    });

    it("propagates an ordinary Error from the invalid callback unchanged", () => {
      const failure = new Error("Unexpected invalid callback failure");
      const onInvalid = spyOn({ report: (_error: IssueTopicConfigError) => { throw failure; } }, "report");
      let caught: unknown;
      try {
        readWorkspaceIssueTopicsLenient({ issueTopics: null }, onInvalid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(onInvalid.mock.calls[0]?.[0]).toBeInstanceOf(IssueTopicConfigError);
    });
  });

  const invalidValue = "invalid-private-config-value";
  const invalidConfigs: {
    name: string;
    raw: unknown;
    enabled: boolean;
    chatId: string;
    message: string;
  }[] = [
    {
      name: "unknown notification mode",
      raw: { enabled: true, chatId: "oc_issue_topics", notifyMode: invalidValue },
      enabled: true, chatId: "oc_issue_topics",
      message: "issueTopics.notifyMode must be group_owner, person, or none",
    },
    {
      name: "non-array project IDs",
      raw: { enabled: true, chatId: "oc_issue_topics", projectIds: invalidValue },
      enabled: true, chatId: "oc_issue_topics",
      message: "issueTopics.projectIds must be an array",
    },
    {
      name: "empty project ID",
      raw: { enabled: true, chatId: "oc_issue_topics", projectIds: ["", invalidValue] },
      enabled: true, chatId: "oc_issue_topics",
      message: "issueTopics.projectIds[0] must be a non-empty string",
    },
    {
      name: "non-boolean enabled",
      raw: { enabled: "true", chatId: "oc_issue_topics" },
      enabled: false, chatId: "oc_issue_topics",
      message: "issueTopics.enabled must be a boolean",
    },
    {
      name: "enabled without chat ID",
      raw: { enabled: true },
      enabled: true, chatId: "",
      message: "issueTopics.chatId is required when enabled",
    },
    {
      name: "string config", raw: invalidValue,
      enabled: false, chatId: "", message: "issueTopics must be an object",
    },
    {
      name: "array config", raw: [],
      enabled: false, chatId: "", message: "issueTopics must be an object",
    },
    {
      name: "null config", raw: null,
      enabled: false, chatId: "", message: "issueTopics must be an object",
    },
  ];

  for (const scenario of invalidConfigs) {
    for (const matching of [true, false]) {
      it(`accepts inbound messages with ${scenario.name} (${matching ? "matching" : "other"} group)`, () => {
        const { store, revision } = scaffold();
        store.submitFeishuBotMessage("local", "rt_bot", {
          revision, externalSessionKey: "oc_discovery", externalMessageId: "om_discovery",
          senderOpenId: "ou_issue_topic_owner", text: "Hello",
        });
        store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
        store.updateWorkspace("local", { settings: { issueTopics: scenario.raw } });
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          const chatId = matching ? "oc_issue_topics" : "oc_other";
          const result = store.submitFeishuBotMessage("local", "rt_bot", {
            revision, chatType: "group", chatId,
            externalSessionKey: `${chatId}:thread:om_invalid_config`, externalMessageId: "om_invalid_config",
            senderOpenId: "ou_issue_topic_owner", text: "Accept this group message",
          });
          expect(result.senderAllowed).toBe(true);
          expect(store.getTask(result.taskId)).not.toBeNull();
          const issueId = store.getFeishuIssueIdForChatSession(result.chatSessionId);
          const createsIssue = matching && scenario.enabled && scenario.chatId === "oc_issue_topics";
          expect(Boolean(issueId)).toBe(createsIssue);
          expect(store.listIssues({ workspaceId: "local" })).toHaveLength(createsIssue ? 1 : 0);
          if (createsIssue) {
            expect(store.getIssue(issueId!)?.projectId).toBeNull();
            expect(store.getTask(result.taskId)?.issueId).toBe(issueId);
          }
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0]?.[0]).toContain("invalid issueTopics config for local");
          expect(JSON.stringify(warn.mock.calls)).not.toContain(invalidValue);
          expect(store.getWorkspace("local")?.settings.issueTopics).toEqual(scenario.raw);
        } finally {
          warn.mockRestore();
        }
      });
    }

    it(`returns recovered settings and a static reason for ${scenario.name}`, async () => {
      const { store } = scaffold();
      store.updateWorkspace("local", { settings: { issueTopics: scenario.raw } });
      const app = createMultiremiApp({ store, authToken: "MASTER" });
      const response = await app.request("/api/workspaces/local/issue-topics", { headers: JSON_HEADERS });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspace_id: "local",
        config: {
          enabled: scenario.enabled, chat_id: scenario.chatId,
          project_ids: null, notify_mode: "group_owner", notify_open_id: null,
        },
        invalid: { code: "issue_topic_config_invalid", message: scenario.message },
      });
      expect(store.getWorkspace("local")?.settings.issueTopics).toEqual(scenario.raw);
    });

    it(`repairs ${scenario.name} with valid replacement settings`, async () => {
      const { store } = scaffold();
      store.updateWorkspace("local", { settings: { preserved: "setting", issueTopics: scenario.raw } });
      const app = createMultiremiApp({ store, authToken: "MASTER" });
      const path = "/api/workspaces/local/issue-topics";
      const response = await app.request(path, {
        method: "PUT", headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true, chat_id: "oc_repaired", project_ids: null, notify_mode: "none" }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        workspace_id: "local",
        config: { enabled: true, chat_id: "oc_repaired", project_ids: null, notify_mode: "none", notify_open_id: null },
      });
      expect(store.getWorkspace("local")?.settings).toEqual({
        preserved: "setting", issueTopics: { enabled: true, chatId: "oc_repaired", notifyMode: "none" },
      });
      expect(await (await app.request(path, { headers: JSON_HEADERS })).json()).toEqual(body);
    });
  }

  for (const scenario of ["missing recipient", "invalid recipient", "invalid projects", "different chat"] as const) {
    it(`accepts inbound messages with an invalid person config (${scenario})`, () => {
      const { store, revision } = scaffold();
      store.submitFeishuBotMessage("local", "rt_bot", {
        revision, externalSessionKey: "oc_discovery", externalMessageId: "om_discovery",
        senderOpenId: "ou_issue_topic_owner", text: "Hello",
      });
      store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
      const project = store.createProject({ title: "Topic project", workspaceId: "local" });
      const issueTopics = {
        enabled: true, chatId: "oc_issue_topics", notifyMode: "person",
        ...(scenario === "missing recipient" ? {} : { notifyOpenId: "invalid-private-recipient" }),
        projectIds: scenario === "invalid projects" ? [42] : [project.id],
      };
      store.updateWorkspace("local", { settings: { issueTopics } });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = store.submitFeishuBotMessage("local", "rt_bot", {
          revision, chatType: "group", chatId: scenario === "different chat" ? "oc_other" : "oc_issue_topics",
          externalSessionKey: "oc_issue_topics:thread:om_invalid_config", externalMessageId: "om_invalid_config",
          senderOpenId: "ou_issue_topic_owner", text: "Accept this group message",
        });
        expect(result.senderAllowed).toBe(true);
        expect(store.getTask(result.taskId)).not.toBeNull();
        const issueId = store.getFeishuIssueIdForChatSession(result.chatSessionId);
        if (scenario === "different chat") {
          expect(issueId).toBeNull();
          expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
        } else {
          expect(store.getIssue(issueId!)?.projectId).toBe(scenario === "invalid projects" ? null : project.id);
          expect(store.getTask(result.taskId)?.issueId).toBe(issueId);
          expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
        }
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("invalid issueTopics config for local");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("invalid-private-recipient");
        expect(store.getWorkspace("local")?.settings.issueTopics).toEqual(issueTopics);
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("returns recovered settings and static validation details for an invalid stored config", async () => {
    const { store } = scaffold();
    const issueTopics = {
      enabled: true, chatId: "oc_issue_topics", notifyMode: "person", notifyOpenId: "invalid-private-recipient",
    };
    store.updateWorkspace("local", { settings: { issueTopics } });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request("/api/workspaces/local/issue-topics", { headers: JSON_HEADERS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace_id: "local",
      config: { enabled: true, chat_id: "oc_issue_topics", project_ids: null, notify_mode: "person", notify_open_id: null },
      invalid: {
        code: "issue_topic_config_invalid",
        message: "issueTopics.notifyOpenId must be a bot-scoped open_id when notifyMode is person",
      },
    });
    expect(store.getWorkspace("local")?.settings.issueTopics).toEqual(issueTopics);
  });

  it("keeps the full response unchanged for valid stored settings", async () => {
    const { store } = scaffold();
    const project = store.createProject({ title: "Topic project", workspaceId: "local" });
    store.updateWorkspace("local", { settings: { issueTopics: {
      enabled: true, chatId: "oc_issue_topics", projectIds: [project.id], notifyMode: "person", notifyOpenId: "ou_reviewer",
    } } });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request("/api/workspaces/local/issue-topics", { headers: JSON_HEADERS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace_id: "local",
      config: { enabled: true, chat_id: "oc_issue_topics", project_ids: [project.id], notify_mode: "person", notify_open_id: "ou_reviewer" },
    });
  });

  for (const notifyOpenId of [undefined, "invalid-private-recipient"]) {
    it(`rejects an omitted recipient repair with a static 400 (stored recipient=${notifyOpenId === undefined ? "missing" : "invalid"})`, async () => {
      const { store } = scaffold();
      const issueTopics = { enabled: true, chatId: "oc_issue_topics", notifyMode: "person", notifyOpenId };
      store.updateWorkspace("local", { settings: { issueTopics } });
      const app = createMultiremiApp({ store, authToken: "MASTER" });
      const response = await app.request("/api/workspaces/local/issue-topics", {
        method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ enabled: true, chat_id: "oc_repaired" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "issue_topic_config_invalid",
        error: "issueTopics.notifyOpenId must be a bot-scoped open_id when notifyMode is person",
      });
      expect(store.getWorkspace("local")?.settings.issueTopics).toEqual(JSON.parse(JSON.stringify(issueTopics)));
    });
  }

  for (const repair of [{ notify_mode: "none" }, { notify_open_id: "ou_repaired" }]) {
    it(`repairs an invalid stored person config by replacing ${Object.keys(repair)[0]}`, async () => {
      const { store } = scaffold();
      store.updateWorkspace("local", { settings: { preserved: "setting", issueTopics: {
        enabled: true, chatId: "oc_issue_topics", notifyMode: "person", notifyOpenId: "invalid-private-recipient", projectIds: [42],
      } } });
      const app = createMultiremiApp({ store, authToken: "MASTER" });
      const path = "/api/workspaces/local/issue-topics";
      const response = await app.request(path, {
        method: "PUT", headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true, chat_id: "oc_repaired", ...repair }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty("invalid");
      expect(body.config).toMatchObject({
        chat_id: "oc_repaired", project_ids: null,
        notify_mode: "notify_mode" in repair ? "none" : "person",
        notify_open_id: "notify_open_id" in repair ? "ou_repaired" : null,
      });
      expect(store.getWorkspace("local")?.settings.preserved).toBe("setting");
      expect(JSON.stringify(store.getWorkspace("local")?.settings)).not.toContain("invalid-private-recipient");
      expect(await (await app.request(path, { headers: JSON_HEADERS })).json()).toEqual(body);
    });
  }

  for (const rollback of [false, true]) {
    it(`MUL-465 existing round wake: ${rollback ? "rolls back without publishing" : "persists Chat before terminal events after commit"} on SQLite`, () => {
      const { store } = scaffold();
      configureTopics(store);
      const wake = prepareReport(store);
      const issue = store.getIssue(wake.issueId!)!;
      db!.run("UPDATE multiremi_tasks SET status = 'completed' WHERE issue_id = ? AND chat_session_id IS NULL", [issue.id]);
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const leader = store.createSessionTask(session.id, { agentId: wake.agentId, prompt: "Next round" });
      db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [leader.id]);
      const events: Array<{ type: string; inTransaction: boolean }> = [];
      const terminalActivities: Array<{ index: number; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent(event => {
        events.push({ type: event.type, inTransaction: db!.inTransaction });
        if (event.type === "activity:created"
          && (event.payload.entry as { action?: string } | undefined)?.action === "task_completed") {
          terminalActivities.push({ index: events.length - 1, inTransaction: db!.inTransaction });
        }
      });
      const logEvents: Array<{ id: string; index: number; inTransaction: boolean }> = [];
      store.setConversationLogListener({ onEntry: (sessionId, entry) => {
        if (sessionId === wake.chatSessionId && "kind" in entry && entry.author_type === "system") {
          events.push({ type: "log:wake", inTransaction: db!.inTransaction });
          logEvents.push({ id: entry.id, index: events.length - 1, inTransaction: db!.inTransaction });
        }
      } });
      const database = db!;
      const originalRun = database.run;
      let injected = false;
      if (rollback) database.run = function run(sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (sql.includes("INSERT INTO multiremi_feishu_bot_round_pushes")) {
          injected = true;
          throw new Error("MUL-465 SQLite round rollback injection");
        }
        return result;
      };
      try {
        const complete = () => store.completeTask(leader.id, { output: "Next round result" });
        if (rollback) expect(complete).toThrow("MUL-465 SQLite round rollback injection");
        else expect(complete().status).toBe("completed");
      } finally {
        database.run = originalRun;
        unsubscribe();
        store.setConversationLogListener(null);
      }
      if (rollback) {
        expect(injected).toBe(true);
        expect(store.getTask(leader.id)!.status).toBe("running");
        expect(store.listTaskSteerMessages(wake.id)).toHaveLength(0);
        expect(events).toEqual([]);
        expect(logEvents).toEqual([]);
        expect(terminalActivities).toEqual([]);
      } else {
        expect(store.listTaskSteerMessages(wake.id)).toHaveLength(0);
        expect(logEvents).toHaveLength(1);
        expect(logEvents[0].inTransaction).toBe(false);
        const message = store.getConversationLogEntryById(logEvents[0].id)!;
        expect(message.kind).toBe("message");
        expect(message.author_type).toBe("system");
        expect(message.body_md).toContain(leader.id);
        expect(terminalActivities).toHaveLength(1);
        expect(terminalActivities[0].inTransaction).toBe(false);
        expect(logEvents[0].index).toBeLessThan(terminalActivities[0].index);
        expect(store.listChatMessagesFromLog(wake.chatSessionId!).filter(message => message.role === "system")).toHaveLength(1);
      }
    });
  }

  for (const rollback of [false, true]) {
    it(`publishes group Issue creation ${rollback ? "never on rollback" : "after commit"}`, () => {
      const { store, revision } = scaffold();
      configureTopics(store);
      store.submitFeishuBotMessage("local", "rt_bot", {
        revision, externalSessionKey: "oc_audit_discovery", externalMessageId: "om_audit_discovery",
        senderOpenId: "ou_issue_topic_owner", text: "Hello",
      });
      store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
      const events: boolean[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "issue_created") {
          events.push(db!.inTransaction);
        }
      });
      const original = StoreContext.prototype.appendIssueActivity;
      if (rollback) StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
        original.call(this, issueId, input, queue);
        if (input.type === "issue_created") throw new Error("Feishu group rollback injection");
      };
      try {
        const send = () => store.submitFeishuBotMessage("local", "rt_bot", {
          revision, chatType: "group", chatId: "oc_issue_topics",
          externalSessionKey: "oc_issue_topics:thread:om_audit_root",
          externalMessageId: "om_audit_root", senderOpenId: "ou_issue_topic_owner",
          text: "Audit Feishu group Issue",
        });
        if (rollback) expect(send).toThrow("Feishu group rollback injection");
        else {
          const created = send();
          const issueId = store.getFeishuIssueIdForChatSession(created.chatSessionId)!;
          expect(store.listIssueActivity(issueId).filter((entry) => entry.type === "issue_created")).toHaveLength(1);
        }
      } finally {
        StoreContext.prototype.appendIssueActivity = original;
        unsubscribe();
      }
      expect(events).toEqual(rollback ? [] : [false]);
      if (rollback) expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    });
  }

  for (const kind of ["round", "human-request"] as const) {
    for (const legacyPin of [false, true]) {
      it(`schedules ${kind} notifications on the changed provider (legacy pin=${legacyPin})`, () => {
        const { store } = scaffold();
        configureTopics(store);
        const botAgentId = store.getFeishuBotConfig("local")!.agentId;
        const issue = store.createIssue({ title: "Cross-provider notification", workspaceId: "local" });
        store.prepareFeishuIssueTopicWithinTransaction(issue);
        const root = store.claimFeishuBotOutbound("local", "rt_bot")!;
        store.reportFeishuBotOutbound("local", "rt_bot", root.id, {
          claimToken: root.claimToken, status: "sent", externalMessageId: "om_topic_root",
        });
        const worker = store.createAgent({ name: "Issue worker", provider: "codex", workspaceId: "local" });
        const sourceTask = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: "Issue work" });
        store.registerRuntime({ id: "rt_claude", name: "Claude", provider: "claude", workspaceId: "local" });
        store.updateAgent(botAgentId, { provider: "claude" });
        const wake = kind === "round"
          ? store.prepareFeishuIssueRoundPushes({ issue, leaderTask: sourceTask })[0]!
          : store.prepareFeishuBotHumanRequestPush(store.createTaskHumanRequest({
            taskId: sourceTask.id, kind: "question", payload: { message: "Continue?" },
          }))!;
        expect(wake.runtimeId).toBeNull();
        if (legacyPin) {
          db!.run("UPDATE multiremi_tasks SET runtime_id = 'rt_bot' WHERE id = ?", [wake.id]);
        }
        expect(store.claimTask("rt_claude")?.id).toBe(wake.id);
        expect(store.getTask(wake.id)?.runtimeId).toBe("rt_claude");
        expect(store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)?.taskId).toBe(wake.id);
      });
    }
  }

  it.each(["linked-member-id", "unbound-member-id", "user-id"])("keeps the topic creator's notification member for %s", (creatorKind) => {
    const { store } = scaffold();
    configureTopics(store);
    const user = store.getOrCreateUser({ email: "topic-creator@example.test", name: "Topic creator" });
    const member = store.createWorkspaceMember({
      name: "Topic creator",
      userId: creatorKind === "unbound-member-id" ? null : user.id,
    });
    const createdBy = creatorKind === "user-id" ? user.id : member.id;
    const issue = store.createIssue({ title: "Member-created topic", createdBy });

    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(true);
    const chat = store.getChatSession(`chat_issue_topic_${issue.id}`)!;
    expect(chat.creatorId).toBe(createdBy);
    expect(store.getAgentChatNotificationChannel(chat.id)?.memberId).toBe(member.id);
  });

  it("checkpoints the recipient before send and keeps it after retry and owner changes", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    const first = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(first).toMatchObject({ taskId: wake.id, mention: { mode: "group_owner" } });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, "stale", "ou_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_other", first.id, first.claimToken, "ou_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_owner"))
      .toEqual({ openId: "ou_owner" });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_new_owner"))
      .toEqual({ openId: "ou_owner" });
    store.reportFeishuBotOutbound("local", "rt_bot", first.id, { claimToken: first.claimToken, status: "failed", error: "network" });
    const retry = store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 10000), true)!;
    expect(retry.id).toBe(first.id);
    expect(retry.mention).toEqual({ mode: "group_owner", resolvedOpenId: "ou_owner" });
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_new_owner")).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", retry.id, retry.claimToken, "ou_new_owner"))
      .toEqual({ openId: "ou_owner" });
  });

  it("rejects expired leases and persists a missing-owner outcome", () => {
    const { store } = scaffold();
    configureTopics(store);
    prepareReport(store);
    const first = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, "ou_owner", new Date(Date.now() + 121000))).toBeNull();
    expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", first.id, first.claimToken, null)).toEqual({ openId: null });
    store.reportFeishuBotOutbound("local", "rt_bot", first.id, { claimToken: first.claimToken, status: "failed" });
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 10000), true)?.mention)
      .toEqual({ mode: "group_owner", resolvedOpenId: null });
  });

  for (const mode of ["person", "none"] as const) {
    it(`snapshots ${mode} policy without silently reverting to group_owner`, () => {
      const { store } = scaffold();
      store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_issue_topics",
        notifyMode: mode, ...(mode === "person" ? { notifyOpenId: "ou_reviewer" } : {}) } } });
      prepareReport(store);
      const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
      expect(delivery.mention?.mode).toBe(mode);
      expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", delivery.id, delivery.claimToken, "ou_wrong")).toBeNull();
      configureTopics(store);
      expect(store.prepareFeishuBotOutboundMention("local", "rt_bot", delivery.id, delivery.claimToken, mode === "person" ? "ou_reviewer" : null))
        .toEqual({ openId: mode === "person" ? "ou_reviewer" : null });
    });
  }

  it("does not add a mention to an old card or report in a different group", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET external_message_id = 'om_old_card' WHERE task_id = ?", [wake.id]);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.mention).toEqual({ mode: "group_owner", resolvedOpenId: null });
    store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, { claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_old_card" });
    prepareReport(store);
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_different" } } });
    expect(store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)?.mention).toBeUndefined();
  });

  it("uses the authenticated result frame to prepare the same recipient and signals a lost lease", async () => {
    const { store } = scaffold();
    configureTopics(store);
    prepareReport(store);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    const token = await store.createAccessToken({ name: "bot-host", type: "daemon", workspaceId: "local", daemonId: "bot-host" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const request = (body: object) => reportFrame(store, "feishu.outbound_result", { runtime_id: "rt_bot", request_id: delivery.id, status: "prepared", claim_token: delivery.claimToken, ...body }, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, authToken: "" });
    expect(await request({ mention_open_id: "all" })).toMatchObject({ ok: false, code: "invalid_report", retryable: false });
    expect(await request({ mention_open_id: "ou_owner", claim_token: "stale" })).toEqual({ ok: true, lease_lost: true });
    const response = await request({ mention_open_id: "ou_owner" });
    expect(response).toEqual({ ok: true, mention_open_id: "ou_owner" });
  });
  it("stores explicit notification targets and preserves them for older clients", async () => {
    const { store } = scaffold();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const path = "/api/workspaces/local/issue-topics";
    const save = (body: unknown) => app.request(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect((await (await app.request(path, { headers: JSON_HEADERS })).json()).config.notify_mode).toBe("group_owner");
    const response = await save({ enabled: true, chat_id: "oc_issue_topics", notify_mode: "person", notify_open_id: "ou_reviewer" });
    expect(response.status).toBe(200);
    expect((await response.json()).config).toMatchObject({ notify_mode: "person", notify_open_id: "ou_reviewer" });
    const oldClient = await save({ enabled: true, chat_id: "oc_issue_topics" });
    expect((await oldClient.json()).config).toMatchObject({ notify_mode: "person", notify_open_id: "ou_reviewer" });
    for (const body of [
      { notify_mode: "all" },
      { notify_mode: null },
      { notify_mode: "person", notify_open_id: "all" },
      { notify_mode: "person", notify_open_id: "ou_x><at id=all" },
      { notify_mode: "person", notify_open_id: "" },
    ]) expect((await save({ enabled: true, chat_id: "oc_issue_topics", ...body })).status).toBe(400);
    expect((await (await save({ enabled: true, chat_id: "oc_issue_topics", notify_mode: "none" })).json()).config)
      .toMatchObject({ notify_mode: "none", notify_open_id: null });
  });

  it("refreshes the exact no-mention group in directives without redeploying the bot", () => {
    const { store, revision } = scaffold();
    const directive = () => store.feishuBotDirectiveForRuntime("local", "rt_bot");
    expect(directive()?.no_mention_chat_ids).toEqual([]);
    configureTopics(store);
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: ["oc_issue_topics"] });
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_new" } } });
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: ["oc_new"] });
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: false, chatId: "oc_new" } } });
    expect(directive()).toMatchObject({ revision, no_mention_chat_ids: [] });
  });

  it("creates one root delivery and reconciles its binding for inbound replies", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Ship issue topics", description: "Keep this Issue visible in Feishu." }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    const issue = store.getIssue(body.id)!;

    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(false);
    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(false);
    expect(store.listChatSessions("local").filter((chat) => store.getFeishuIssueIdForChatSession(chat.id) === issue.id)).toHaveLength(1);
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = 'local'",
    ).get()).toEqual({ count: 1 });

    const delivery = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(delivery).toMatchObject({
      chatId: "oc_issue_topics",
      threadId: null,
      replyToMessageId: null,
      body: expect.stringContaining("Ship issue topics"),
      bodyOrigin: "issue",
    });
    expect(store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, {
      claimToken: delivery.claimToken,
      status: "sent",
      externalMessageId: "om_issue_root",
    })).toBe(true);

    const binding = db!.query(
      `SELECT issue_id, external_session_key, thread_id, reply_to_message_id, chat_session_id
       FROM multiremi_feishu_bot_chat_bindings WHERE workspace_id = 'local'`,
    ).get() as Record<string, unknown>;
    expect(binding).toMatchObject({
      issue_id: issue.id,
      external_session_key: "oc_issue_topics:thread:om_issue_root",
      thread_id: "om_issue_root",
      reply_to_message_id: "om_issue_root",
    });

    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      externalSessionKey: "oc_issue_topics:thread:om_issue_root",
      externalMessageId: "om_issue_reply",
      replyToMessageId: "om_issue_reply",
      chatId: "oc_issue_topics",
      threadId: "om_issue_root",
      text: "Continue this Issue.",
    });
    expect(inbound.chatSessionId).toBe(String(binding.chat_session_id));
    expect(store.getFeishuIssueIdForChatSession(inbound.chatSessionId)).toBe(issue.id);
    expect(store.getChatSession(inbound.chatSessionId)).not.toHaveProperty("issueId");
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Verify topic update delivery" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const round = store.createSessionTask(session.id, { agentId: store.getFeishuBotConfig("local")!.agentId, prompt: "Report progress" });
    db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [round.id]);
    store.completeTask(round.id, { output: "Round complete" });
    expect(store.listChatMessages(inbound.chatSessionId).at(-1)?.body).toContain(`会话 ${session.id}`);
    expect(store.listConversationLogShown(session.id).some(entry => entry.body_md === "Verify topic update delivery")).toBe(true);
  });

  it("wakes the bound topic Agent when an Issue task asks a human", () => {
    const { store } = scaffold();
    configureTopics(store);
    const wake = prepareReport(store);
    const roundDelivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    store.reportFeishuBotOutbound("local", "rt_bot", roundDelivery.id, {
      claimToken: roundDelivery.claimToken,
      status: "sent",
      externalMessageId: "om_round_push",
    });
    const sourceTask = store.createTask({ agentId: store.getFeishuBotConfig("local")!.agentId, issueId: store.getTask(wake.id)!.issueId,
      workspaceId: "local", prompt: "Run the Issue" });
    const request = store.createTaskHumanRequest({
      taskId: sourceTask.id,
      kind: "question",
      payload: {
        message: "Should I continue?",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
      },
    });

    const topicWake = store.listTasks().find(task => task.id !== wake.id && task.id !== sourceTask.id);
    expect(topicWake).toMatchObject({ chatSessionId: store.getTask(wake.id)!.chatSessionId, holdsWorkspace: false });
    expect(topicWake?.prompt).toContain(`Human request id: ${request.id}`);
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(delivery.taskId).toBe(topicWake?.id);
    expect(delivery.body).toContain("Should I continue?");

    // Replaying the same request report is idempotent and does not enqueue a
    // second wake Task or outbound delivery.
    expect(store.prepareFeishuBotHumanRequestPush(request)?.id).toBe(topicWake?.id);
    expect(store.listTasks().filter(task => task.prompt.includes(`Human request id: ${request.id}`))).toHaveLength(1);
  });

  it("keeps a private Feishu chat independent when its Agent creates an Issue", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "p2p",
      externalSessionKey: "oc_private",
      externalMessageId: "om_private_message",
      replyToMessageId: "om_private_message",
      chatId: "oc_private",
      senderOpenId: "ou_issue_topic_owner",
      senderUnionId: "on_issue_topic_owner",
      text: "Create an Issue, but keep this private chat independent.",
    });
    store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
    const task = store.getTask(inbound.taskId)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ title: "Created from a private chat" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).not.toHaveProperty("chat_issue_binding");
    expect(store.getFeishuIssueIdForChatSession(inbound.chatSessionId)).toBeNull();

    const delivery = store.claimFeishuBotOutbound("local", "rt_bot");
    expect(delivery).toMatchObject({
      chatId: "oc_issue_topics",
      threadId: null,
      body: expect.stringContaining("Created from a private chat"),
      bodyOrigin: "issue",
    });
    expect(store.listChatSessions("local").filter((chat) => store.getFeishuIssueIdForChatSession(chat.id) === body.id)).toHaveLength(1);
  });

  it("turns a new configured group topic into one Issue and reuses it for replies", () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    store.submitFeishuBotMessage("local", "rt_bot", { revision, externalSessionKey: "oc_discovery",
      externalMessageId: "om_discovery", senderOpenId: "ou_issue_topic_owner", text: "Hello" });
    store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_root",
      replyToMessageId: "om_group_root",
      chatId: "oc_issue_topics",
      senderOpenId: "ou_issue_topic_owner",
      senderUnionId: "on_issue_topic_owner",
      text: "Implement natural Issue creation from this group topic.",
    });

    const chat = store.getChatSession(first.chatSessionId)!;
    const issue = store.getIssue(store.getFeishuIssueIdForChatSession(chat.id)!)!;
    expect(issue).toMatchObject({
      title: "Implement natural Issue creation from this group topic.",
      status: "in_progress",
      assigneeType: "agent",
    });
    expect(store.getTask(first.taskId)?.issueId).toBe(issue.id);
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    const duplicate = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_root",
      replyToMessageId: "om_group_root",
      chatId: "oc_issue_topics",
      senderOpenId: "ou_issue_topic_owner",
      senderUnionId: "on_issue_topic_owner",
      text: "Implement natural Issue creation from this group topic.",
    });
    expect(duplicate).toMatchObject({ duplicate: true, taskId: first.taskId, chatSessionId: first.chatSessionId });

    const reply = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      chatType: "group",
      externalSessionKey: "oc_issue_topics:thread:om_group_root",
      externalMessageId: "om_group_reply",
      replyToMessageId: "om_group_reply",
      chatId: "oc_issue_topics",
      threadId: "om_group_root",
      senderOpenId: "ou_issue_topic_owner",
      senderUnionId: "on_issue_topic_owner",
      text: "Add this detail to the same Issue.",
    });
    expect(reply).toMatchObject({ steered: true, taskId: first.taskId, chatSessionId: first.chatSessionId });
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    expect(store.listTasks().filter((task) => task.chatSessionId === first.chatSessionId)).toHaveLength(1);
  });

  it("requires all group senders and the routed Agent policy before automatically creating an Issue", () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const send = (openId: string, messageId: string) => store.submitFeishuBotMessage("local", "rt_bot", {
      revision, chatType: "group", chatId: "oc_issue_topics",
      externalSessionKey: "oc_issue_topics:thread:approval", externalMessageId: messageId,
      senderOpenId: openId, text: "Create the requested Issue",
    });
    const first = send("ou_first", "om_first");
    const second = send("ou_second", "om_second");
    expect(second.chatSessionId).toBe(first.chatSessionId);
    expect(store.getFeishuIssueIdForChatSession(first.chatSessionId)).toBeNull();
    const senders = store.listFeishuBotSenders("local");
    store.setFeishuBotSenderAllowed("local", senders.find(s => s.open_id === "ou_second")!.id, true, "local");
    send("ou_second", "om_partial_approval");
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    store.setFeishuBotSenderAllowed("local", senders.find(s => s.open_id === "ou_first")!.id, true, "local");
    const agentId = store.getFeishuBotConfig("local")!.agentId;
    store.updateAgent(agentId, { issueCreationRequiresProposal: true });
    send("ou_second", "om_agent_restricted");
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    store.updateAgent(agentId, { issueCreationRequiresProposal: false });
    send("ou_second", "om_approved");
    expect(store.getFeishuIssueIdForChatSession(first.chatSessionId)).toBeTruthy();
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);
  });

  it("creates a dedicated Issue topic without binding the source Feishu conversation", async () => {
    const { store, revision } = scaffold();
    configureTopics(store);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision,
      externalSessionKey: "oc_source:thread:om_source_root",
      chatType: "group",
      externalMessageId: "om_source_message",
      replyToMessageId: "om_source_message",
      chatId: "oc_source",
      threadId: "om_source_root",
      senderOpenId: "ou_issue_topic_owner",
      senderUnionId: "on_issue_topic_owner",
      text: "Create an Issue from this topic.",
    });
    const sender = store.listFeishuBotSenders("local")[0]!;
    store.setFeishuBotSenderAllowed("local", sender.id, true, "local");
    const task = store.getTask(inbound.taskId)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ title: "Created inside Feishu" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).not.toHaveProperty("chat_issue_binding");
    expect(store.getFeishuIssueIdForChatSession(inbound.chatSessionId)).toBeNull();
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toMatchObject({ chatId: "oc_issue_topics", bodyOrigin: "issue" });
    expect(store.listChatSessions("local").filter((chat) => store.getFeishuIssueIdForChatSession(chat.id) === body.id)).toHaveLength(1);
  });

  it("does not affect Issue creation when topics are unconfigured or the bot is offline", async () => {
    const unconfigured = scaffold();
    let app = createMultiremiApp({ store: unconfigured.store, authToken: "MASTER" });
    let response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "No topic configuration" }),
    });
    expect(response.status).toBe(201);
    expect(unconfigured.store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    resetMultiremiTestEnv();
    const offline = scaffold({ online: false });
    configureTopics(offline.store);
    app = createMultiremiApp({ store: offline.store, authToken: "MASTER" });
    response = await app.request("/api/issues", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Offline concierge" }),
    });
    expect(response.status).toBe(201);
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_feishu_bot_outbound_deliveries WHERE workspace_id = 'local'",
    ).get()).toEqual({ count: 0 });
  });

  it("reads and validates project-filtered workspace configuration", async () => {
    const { store } = scaffold();
    const project = store.createProject({ title: "Topic project", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const initial = await app.request("/api/workspaces/local/issue-topics", { headers: JSON_HEADERS });
    expect(await initial.json()).toEqual({
      workspace_id: "local",
      config: { enabled: false, chat_id: "", project_ids: null, notify_mode: "group_owner", notify_open_id: null },
    });
    const updated = await app.request("/api/workspaces/local/issue-topics", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, chat_id: " oc_filtered ", project_ids: [project.id, project.id] }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      workspace_id: "local",
      config: { enabled: true, chat_id: "oc_filtered", project_ids: [project.id], notify_mode: "group_owner", notify_open_id: null },
    });

    const rejected = await app.request("/api/workspaces/local/issue-topics", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: true, chat_id: "oc_filtered", project_ids: ["prj_missing"] }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "issue_topic_config_invalid" });
  });
});
