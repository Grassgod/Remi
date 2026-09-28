import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { decodeDecisionCardBody, questionCardAction, questionCardIdempotencyKey, decisionInteractionMarker, interactionMarker } from "@shared/feishu-task-card.js";
import { handleIssueDecisionInteractionEvent, handleTaskInteractionEvent, registerQuestionCardClient } from "@connectors/feishu/task-interaction.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";
import { sendDecisionLane, sendIssueDecisionLane } from "../../../apps/remi/cli/multiremi.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { nativeHarness, taskEvent, completed } from "../connectors/feishu-native-harness.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const tables = { fr: "multiremi_task_human_requests", fd: "multiremi_issue_decisions" } as const;
const fixtureSecret = "mul487-test-fixture-not-a-real-secret";
let sequence = 0;

for (const backend of ["SQLite", "Postgres"] as const) {
  describe.skipIf(backend === "Postgres" && !pgAdminUrl)(`MUL-487 ${backend}`, () => {
    let db: SqlDatabase;
    let store: MultiremiStore;
    let databaseName: string;
    const environmentKeys = ["MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY", "MULTIREMI_PUBLIC_URL", "MULTIREMI_LARK_APP_ID", "MULTIREMI_LARK_APP_SECRET"] as const;
    let previousEnvironment: (string | undefined)[];

    beforeAll(async () => {
      previousEnvironment = environmentKeys.map(key => process.env[key]);
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
      process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
      process.env.MULTIREMI_LARK_APP_ID = "cli_mul487";
      process.env.MULTIREMI_LARK_APP_SECRET = fixtureSecret;
      if (backend === "SQLite") db = new Database(":memory:");
      else {
        // An explicitly configured but unreachable PG must fail, never skip.
        databaseName = `mul487_tokens_${process.pid}_${Date.now()}`;
        const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
        try { await admin.unsafe(`CREATE DATABASE ${databaseName}`); }
        finally { await admin.end(); }
        const url = new URL(pgAdminUrl!);
        url.pathname = `/${databaseName}`;
        db = new PostgresSyncDatabase(url.toString());
      }
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
    });

    afterAll(async () => {
      db?.close();
      if (databaseName) {
        const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
        try { await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); }
        finally { await admin.end(); }
      }
      environmentKeys.forEach((key, i) => {
        if (previousEnvironment[i] === undefined) delete process.env[key];
        else process.env[key] = previousEnvironment[i];
      });
    });

    async function setup(lane: keyof typeof tables, mode: "person" | "group_owner" = "person") {
      const n = ++sequence;
      const workspace = store.createWorkspace({ name: `MUL487 ${n}`, slug: `mul487-${n}` });
      const workspaceId = workspace.id;
      const recipient = `ou_mul487_${n}`;
      const member = store.listWorkspaceMembers(workspaceId).find(item => item.role === "owner")!;
      const user = store.getOrCreateUser({ externalId: recipient, name: "Token recipient", email: `mul487-${n}@example.com` });
      db.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
      const agent = store.createAgent({ name: "Question bot", provider: "codex", workspaceId });
      const runtimeId = `rt_mul487_${n}`;
      const daemonId = `daemon_mul487_${n}`;
      store.registerRuntime({ id: runtimeId, name: "Question host", provider: "codex", workspaceId, daemonId });
      store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true, supportsDecisionCard: true, supportsIssueDecisionCard: true });
      const config = store.upsertFeishuBotConfig(workspaceId, {
        agentId: agent.id, runtimeId, appId: "cli_mul487", appSecretOp: "set", appSecret: fixtureSecret, domain: "feishu", enabled: true,
      });
      store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
      store.updateWorkspace(workspaceId, { settings: { ...workspace.settings,
        issueTopics: { enabled: true, chatId: `oc_mul487_${n}`, notifyMode: mode, ...(mode === "person" ? { notifyOpenId: recipient } : {}) },
      } });
      const issue = store.createIssue({ title: "Question parent", workspaceId, assigneeType: "agent", assigneeId: agent.id });
      store.prepareFeishuIssueTopicWithinTransaction(issue);
      const root = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
      store.reportFeishuBotOutbound(workspaceId, runtimeId, root.id, { claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${n}` });
      const source = lane === "fd" ? store.createIssue({ title: "Question source", workspaceId, parentIssueId: issue.id,
        assigneeType: "agent", assigneeId: agent.id }) : issue;
      const task = store.createTask({ agentId: agent.id, workspaceId, issueId: source.id, prompt: "Do the work" });
      const request = lane === "fr"
        ? store.createTaskHumanRequest({ taskId: task.id, kind: "question", timeoutMs: 60 * 60_000,
          payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] } })
        : store.createIssueDecision(source.id, { kind: "production_change", title: "Deploy?", options: ["Yes", "No"] },
          { type: "agent", id: agent.id, taskId: task.id });
      const delivery = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
      const token = action(delivery).t as string;
      const access = await store.createAccessToken({ name: daemonId, type: "daemon", workspaceId, daemonId });
      const api = createMultiremiApp({ store, authToken: "MASTER" });
      const path = lane === "fr" ? `/api/daemon/tasks/${task.id}/human-requests/${request.id}/respond`
        : `/api/daemon/issues/${issue.id}/decisions/${request.id}/answer`;
      const respond = (suppliedToken: unknown = token, operator: unknown = recipient) => api.request(path, {
        method: "POST", headers: { Authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ token: suppliedToken, operator_open_id: operator,
          ...(lane === "fr" ? { response: { answers: { "Continue?": "Yes" } } } : { answer: "Yes" }) }),
      });
      const sent = (card = delivery, openId = recipient, now?: Date) => store.reportFeishuBotOutbound(workspaceId, runtimeId, card.id, {
        claimToken: card.claimToken, status: "sent", externalMessageId: `om_card_${n}`, interactionOpenId: openId,
      }, now);
      const row = () => db.query(`SELECT status, token_hash, token_recipient, token_consumed_at FROM ${tables[lane]} WHERE id = ?`).get(request.id);
      return { n, lane, workspaceId, runtimeId, recipient, member, user, issue, task, request, delivery, token, access, api, respond, sent, row };
    }

    function action(delivery: MultiremiFeishuBotOutboundDelivery): Record<string, unknown> {
      const card = decodeDecisionCardBody(delivery.body)?.card;
      const value = card && questionCardAction(card);
      if (!value) throw new Error("fixture card has no credential");
      return value;
    }

    for (const lane of ["fr", "fd"] as const) {
      it(`${lane}: binds person at issuance, stores only SHA256, consumes once and rejects replay`, async () => {
        const f = await setup(lane);
        expect(Buffer.from(f.token, "base64url").length).toBe(32);
        expect(f.row().token_hash === createHash("sha256").update(f.token).digest("hex")).toBe(true);
        expect(f.row().token_hash === f.token).toBe(false);
        expect(f.row().token_recipient).toBe(f.recipient);
        expect(f.row().token_consumed_at).toBeNull();
        f.sent();
        expect((await f.respond()).status).toBe(200);
        expect(typeof f.row().token_consumed_at).toBe("string");
        const replay = await f.respond();
        expect(replay.status).toBe(403);
        expect(await replay.json()).toMatchObject({ code: "token_consumed" });
        if (lane === "fr") expect(store.getTaskHumanRequest(f.request.id)?.respondedBy).toBe(f.recipient);
        else expect(store.getIssueDecision(f.issue.id, f.request.id)?.answeredByMemberId).toBe(f.member.id);
      });

      it(`${lane}: rejects other people and missing or malformed credentials without consuming`, async () => {
        const f = await setup(lane);
        f.sent();
        for (const [token, operator, code] of [
          [f.token, "ou_someone_else", "recipient_mismatch"],
          [f.token, undefined, "recipient_mismatch"],
          [undefined, f.recipient, "token_invalid"],
          [42, f.recipient, "token_invalid"],
          ["not-the-card-token", f.recipient, "token_invalid"],
        ]) {
          // Explicit undefined must not use respond's convenience defaults.
          const response = await f.respond(token === undefined ? null : token, operator === undefined ? null : operator);
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ code });
          expect(f.row().token_consumed_at).toBeNull();
        }
        expect((await f.respond()).status).toBe(200);
      });

      it(`${lane}: binds group owner only on sent and never overwrites the recipient`, async () => {
        const f = await setup(lane, "group_owner");
        expect(f.row().token_recipient).toBeNull();
        const unbound = await f.respond();
        expect(unbound.status).toBe(403);
        expect(await unbound.json()).toMatchObject({ code: "recipient_mismatch" });
        expect(f.sent()).toBe(true);
        expect(f.row().token_recipient).toBe(f.recipient);
        expect(f.sent(f.delivery, "ou_other_owner")).toBe(false);
        expect(f.row().token_recipient).toBe(f.recipient);
        expect((await f.respond()).status).toBe(200);
      });

      it(`${lane}: redelivery rotates token and stale sent reports cannot bind its replacement`, async () => {
        const f = await setup(lane, "group_owner");
        const now = new Date();
        expect(store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, f.delivery.id,
          { claimToken: f.delivery.claimToken, status: "failed", error: "temporary", retryable: true }, now)).toBe(true);
        const retry = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId, new Date(now.getTime() + 6000))!;
        const replacement = action(retry).t as string;
        expect(replacement === f.token).toBe(false);
        expect(questionCardIdempotencyKey(decodeDecisionCardBody(retry.body)!.card, retry.idempotencyKey)
          === questionCardIdempotencyKey(decodeDecisionCardBody(f.delivery.body)!.card, f.delivery.idempotencyKey)).toBe(false);
        expect(f.sent(f.delivery, "ou_stale_owner")).toBe(false);
        expect(f.row().token_recipient).toBeNull();
        f.sent(retry);
        const stale = await f.respond(f.token);
        expect(stale.status).toBe(403);
        expect(await stale.json()).toMatchObject({ code: "token_invalid" });
        expect((await f.respond(replacement)).status).toBe(200);
      });

      it(`${lane}: reminder rotates token, patches the original card, and invalidates its old action`, async () => {
        const f = await setup(lane);
        const sentAt = new Date();
        f.sent(f.delivery, f.recipient, sentAt);
        const due = lane === "fd" ? sentAt.getTime() + 51 * 60_000
          : new Date(store.getTaskHumanRequest(f.request.id)!.expiresAt!).getTime() - 61_000;
        const reminder = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId, new Date(due))!;
        expect(reminder.kind).toBe("decision_reminder");
        expect(reminder.targetMessageId).toBe(`om_card_${f.n}`);
        const replacement = action(reminder).t as string;
        expect(replacement === f.token).toBe(false);
        expect(f.row().token_recipient).toBe(f.recipient);
        const patches: Array<{ id: string; card: Record<string, unknown> }> = [];
        const texts: string[] = [];
        const handle = {
          appId: "cli_mul487", updateProactiveCard: async (id: string, card: Record<string, unknown>) => { patches.push({ id, card }); },
          sendProactiveThreadReply: async (input: { body: string }) => { texts.push(input.body); return { messageId: "om_reminder" }; },
        } as unknown as FeishuChannelHandle;
        await (lane === "fd" ? sendIssueDecisionLane : sendDecisionLane)(handle, reminder);
        expect(patches).toHaveLength(1);
        expect(patches[0]!.id).toBe(`om_card_${f.n}`);
        expect(questionCardAction(patches[0]!.card)?.t === replacement).toBe(true);
        expect(texts).toHaveLength(1);
        expect(texts[0]!.includes(replacement)).toBe(false);
        expect(texts[0]).not.toContain('"card"');
        const stale = await f.respond(f.token);
        expect(stale.status).toBe(403);
        expect(await stale.json()).toMatchObject({ code: "token_invalid" });
        expect((await f.respond(replacement)).status).toBe(200);
      });

      it(`${lane}: simultaneous answers have exactly one winner`, async () => {
        const f = await setup(lane);
        f.sent();
        const responses = await Promise.all([f.respond(), f.respond()]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 403]);
        expect(await responses.find(response => response.status === 403)!.json()).toMatchObject({ code: "token_consumed" });
        if (lane === "fd") expect(store.getIssueDecision(f.issue.id, f.request.id)?.history).toHaveLength(1);
      });

      it(`${lane}: person binding cannot be replaced by a sent report`, async () => {
        const f = await setup(lane);
        f.sent(f.delivery, "ou_wrong_sent_recipient");
        expect(f.row().token_recipient).toBe(f.recipient);
        const result = await f.respond();
        if (lane === "fr") expect(result.status).toBe(200);
        else {
          expect(result.status).toBe(403);
          expect(await result.json()).toMatchObject({ code: "decision_operator_mismatch" });
          expect(f.row().token_consumed_at).toBeNull();
        }
      });

      it(`${lane}: click survives restart with no message registration and ignores chat identity`, async () => {
        const f = await setup(lane);
        f.sent();
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => f.api.fetch(request) });
        const client = new MultiremiDaemonClient(server.url.origin, f.access.token);
        const stop = registerQuestionCardClient("cli_mul487_restart", {
          getRequest: (taskId, requestId) => client.getTaskHumanRequest(taskId, requestId),
          respond: (taskId, requestId, response, credential) => client.respondTaskHumanRequest(taskId, requestId, response, credential),
          getDecision: (issueId, requestId) => client.getFeishuIssueDecision(issueId, requestId),
          answer: (issueId, requestId, answer, credential) => client.answerFeishuIssueDecision(issueId, requestId, { answer, ...credential }),
        });
        try {
          const marker = lane === "fd" ? decisionInteractionMarker(f.issue.id, f.request.id) : interactionMarker(f.task.id, f.request.id);
          const event = { operator: { open_id: f.recipient }, context: { open_message_id: `om_no_registry_${f.n}`, open_chat_id: "oc_not_cached" },
            action: { name: marker, value: action(f.delivery), form_value: lane === "fd" ? { [`${marker}_o0`]: true } : { q0_option0: true } } };
          const result = await (lane === "fd" ? handleIssueDecisionInteractionEvent : handleTaskInteractionEvent)("cli_mul487_restart", event);
          expect(result?.toast).toMatchObject({ type: "success" });
          expect(f.row().token_consumed_at).not.toBeNull();
        } finally { stop(); await server.stop(true); }
      });

      it(`${lane}: plaintext never reaches log spies, activities, comments or failed delivery errors`, async () => {
        const logs = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}),
          spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "info").mockImplementation(() => {}), spyOn(console, "debug").mockImplementation(() => {})];
        const context = (store as unknown as { ctx: StoreContext }).ctx;
        const activity = spyOn(context, "appendIssueActivity");
        const comment = spyOn(store, "createIssueComment");
        try {
          const f = await setup(lane);
          const wrong = await f.respond(f.token, "ou_wrong_person");
          expect(wrong.status).toBe(403);
          store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, f.delivery.id,
            { claimToken: f.delivery.claimToken, status: "failed", error: `transport echoed ${f.token}`, retryable: true });
          const error = db.query("SELECT last_error FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(f.delivery.id);
          expect(JSON.stringify(error).includes(f.token)).toBe(false);
          const retry = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId, new Date(Date.now() + 6000))!;
          const replacement = action(retry).t as string;
          f.sent(retry);
          expect((await f.respond(replacement)).status).toBe(200);
          expect((await f.respond(replacement)).status).toBe(403);
          const publicRows = [
            db.query("SELECT * FROM multiremi_issue_activity WHERE issue_id = ?").all(f.issue.id),
            db.query("SELECT * FROM multiremi_issue_comments WHERE issue_id = ?").all(f.issue.id),
            activity.mock.calls, comment.mock.calls, ...logs.map(log => log.mock.calls),
          ];
          for (const token of [f.token, replacement]) expect(JSON.stringify(publicRows).includes(token)).toBe(false);
        } finally { activity.mockRestore(); comment.mockRestore(); logs.forEach(log => log.mockRestore()); }
      });
    }

    it("fr: native stream issuance and retarget rotate tokens and bind the new person", async () => {
      const f = await setup("fr");
      const path = `/api/daemon/tasks/${f.task.id}/human-requests/${f.request.id}/card`;
      const mint = (recipient: string) => f.api.request(path, { method: "POST",
        headers: { Authorization: `Bearer ${f.access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ recipient_open_id: recipient }) });
      const native = await mint(f.recipient);
      expect(native.status).toBe(200);
      const nativeToken = questionCardAction((await native.json()).card)!.t as string;
      expect(nativeToken === f.token).toBe(false);
      const changedRecipient = "ou_new_addressee";
      const retargeted = await mint(changedRecipient);
      expect(retargeted.status).toBe(200);
      const newToken = questionCardAction((await retargeted.json()).card)!.t as string;
      for (const token of [f.token, nativeToken]) {
        const rejected = await f.respond(token);
        expect(rejected.status).toBe(403);
        expect(await rejected.json()).toMatchObject({ code: "token_invalid" });
      }
      expect(f.row().token_recipient).toBe(changedRecipient);
      expect((await f.respond(newToken, changedRecipient)).status).toBe(200);
    });

    it("fr: native send retries mint a new credential and delivery key without persisting plaintext in checkpoints", async () => {
      const f = await setup("fr");
      const h = nativeHarness();
      const create = h.client.im.message.create;
      const tokens: string[] = [];
      const keys: string[] = [];
      h.client.im.message.create = async input => {
        const credential = questionCardAction(JSON.parse(input.data.content));
        if (credential) {
          tokens.push(String(credential.t));
          keys.push(input.data.uuid);
          if (tokens.length === 1) return { code: 99991400, data: { message_id: "" } };
          expect((await f.respond(credential.t)).status).toBe(200);
        }
        return create(input);
      };
      const presentation = new FeishuTaskPresentation(h.client as any, "oc_mul487", {
        taskId: f.task.id, getHumanRequest: async () => store.getTaskHumanRequest(f.request.id),
        prepareHumanRequestCard: async (id, recipient) => store.prepareTaskStreamQuestionCard(id, recipient)!,
        respondHumanRequest: async (_id, response, credential) => store.respondTaskHumanRequest(f.request.id, { response, cardCredential: credential })!,
      }, { appId: "cli_mul487", idempotencyKey: "native-token-retry", interactionOpenId: f.recipient, save: h.save });
      async function* stream() {
        yield taskEvent(1, "question_request", { input: { request_id: f.request.id } });
        yield completed;
      }
      await presentation.consume(stream());
      expect(tokens).toHaveLength(2);
      expect(tokens[0] === tokens[1]).toBe(false);
      expect(keys[0] === keys[1]).toBe(false);
      for (const token of tokens) expect(JSON.stringify(h.checkpoint).includes(token)).toBe(false);
    });

    it("fd: token check precedes operator mapping and mapping failure does not consume", async () => {
      const f = await setup("fd");
      f.sent();
      const mapping = spyOn(store, "resolveFeishuDecisionOperatorMember");
      try {
        expect((await f.respond("bad-token")).status).toBe(403);
        expect((await f.respond(f.token, "ou_wrong_person")).status).toBe(403);
        expect(mapping).not.toHaveBeenCalled();
        db.run("UPDATE multiremi_workspace_members SET user_id = NULL WHERE id = ?", [f.member.id]);
        const unmapped = await f.respond();
        expect(unmapped.status).toBe(403);
        expect(await unmapped.json()).toMatchObject({ code: "decision_member_unmapped" });
        expect(mapping).toHaveBeenCalledTimes(1);
        expect(f.row().token_consumed_at).toBeNull();
      } finally { mapping.mockRestore(); }
    });

    it("fd: form checker values select options even when action.name is the submit button", async () => {
      for (const checked of [true, "true", { checked: true }, { value: "true" }]) {
        const f = await setup("fd");
        f.sent();
        const marker = decisionInteractionMarker(f.issue.id, f.request.id);
        const stop = registerQuestionCardClient("cli_mul487_checker", {
          getRequest: async () => null, respond: async () => { throw new Error("not a task card"); },
          getDecision: async () => store.getIssueDecision(f.issue.id, f.request.id),
          answer: async (_issueId, _requestId, answer, credential) => store.answerIssueDecision(f.issue.id, f.request.id,
            { answer, reason: "", overturn: "" }, { type: "member", id: f.member.id, taskId: null }, { cardCredential: credential }),
        });
        try {
          const result = await handleIssueDecisionInteractionEvent("cli_mul487_checker", {
            operator: { open_id: f.recipient }, context: { open_message_id: "om_not_registered" },
            action: { name: marker, value: action(f.delivery), form_value: { [`${marker}_o1`]: checked, [`${marker}_answer`]: "after CI" } },
          });
          expect(result?.toast).toMatchObject({ type: "success" });
          expect(store.getIssueDecision(f.issue.id, f.request.id)?.answer?.answer).toBe("No\n自定义回答：after CI");
        } finally { stop(); }
      }
    });

    it("fd: rejects malformed or multiple checked options without consuming the credential", async () => {
      const f = await setup("fd");
      f.sent();
      const marker = decisionInteractionMarker(f.issue.id, f.request.id);
      let submissions = 0;
      const stop = registerQuestionCardClient("cli_mul487_bad_checker", {
        getRequest: async () => null, respond: async () => { throw new Error("not a task card"); },
        getDecision: async () => store.getIssueDecision(f.issue.id, f.request.id),
        answer: async () => { submissions++; throw new Error("must not submit an invalid form"); },
      });
      try {
        for (const form of [{ [`${marker}_o0`]: true, [`${marker}_o1`]: true }, { [`${marker}_o0`]: "invalid-boolean" }]) {
          const result = await handleIssueDecisionInteractionEvent("cli_mul487_bad_checker", { operator: { open_id: f.recipient },
            action: { name: marker, value: action(f.delivery), form_value: form } });
          expect(result?.toast).toMatchObject({ type: "error" });
        }
        expect(submissions).toBe(0);
        expect(f.row().token_consumed_at).toBeNull();
      } finally { stop(); }
    });

    it("fr and fd: member web answers still work without a card credential", async () => {
      const fr = await setup("fr");
      const frResponse = await fr.api.request(`/api/multiremi/tasks/${fr.task.id}/human-requests/${fr.request.id}/respond`, {
        method: "POST", headers: { Authorization: "Bearer MASTER", "content-type": "application/json" },
        body: JSON.stringify({ response: { answers: { "Continue?": "No" } } }),
      });
      expect(frResponse.status).toBe(200);
      const fd = await setup("fd");
      const memberToken = await store.createAccessToken({ name: "Member answer", type: "pat", workspaceId: fd.workspaceId, userId: fd.user.id });
      const fdResponse = await fd.api.request(`/api/issues/${fd.issue.id}/decisions/${fd.request.id}/answer`, {
        method: "POST", headers: { Authorization: `Bearer ${memberToken.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "No" }),
      });
      expect(fdResponse.status).toBe(200);
      expect(fd.row().status).toBe("answered");
      expect(fd.row().token_consumed_at).toBeNull();
    });

    it("migration: upgrades existing rows twice with nullable credential columns and partial indexes", async () => {
      const fr = await setup("fr");
      const fd = await setup("fd");
      for (const table of Object.values(tables)) {
        db.exec(`DROP INDEX idx_${table}_token_hash`);
        for (const column of ["token_hash", "token_recipient", "token_consumed_at"]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
      db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["20260929_human_request_tokens"]);
      store = new MultiremiStore(db);
      store = new MultiremiStore(db);
      for (const f of [fr, fd]) {
        const current = f.row();
        expect(current.status).toBe(f.lane === "fr" ? "pending" : "escalated");
        expect(current.token_hash).toBeNull();
        expect(current.token_recipient).toBeNull();
        expect(current.token_consumed_at).toBeNull();
        const index = backend === "SQLite"
          ? db.query("SELECT sql AS definition FROM sqlite_master WHERE type = 'index' AND name = ?").get(`idx_${tables[f.lane]}_token_hash`)
          : db.query("SELECT indexdef AS definition FROM pg_indexes WHERE indexname = ?").get(`idx_${tables[f.lane]}_token_hash`);
        expect(String(index?.definition).toLowerCase()).toContain("token_hash is not null");
        const refused = await f.respond();
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: "token_invalid" });
      }
      expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_schema_migrations WHERE id = ?")
        .get("20260929_human_request_tokens").n)).toBe(1);
    });
  });
}
