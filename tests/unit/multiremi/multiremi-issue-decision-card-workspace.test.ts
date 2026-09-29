import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const sideEffectTables = [
  "multiremi_issue_decisions", "multiremi_issue_activity", "multiremi_inbox_items",
  "multiremi_feishu_bot_outbound_deliveries", "multiremi_tasks", "multiremi_session_events",
] as const;

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(`MUL-476 decision card workspace (${backend})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
    let serial = 0;
    const databaseName = `mul476_cards_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const previousEnv = new Map<string, string | undefined>();

    beforeAll(async () => {
      for (const [key, value] of Object.entries({
        MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
        MULTIREMI_PUBLIC_URL: "https://remi.example.test",
        MULTIREMI_LARK_APP_ID: "cli_mul476_cards",
        MULTIREMI_LARK_APP_SECRET: "mul476-card-fixture-secret",
      })) {
        previousEnv.set(key, process.env[key]);
        process.env[key] = value;
      }
      if (backend === "PostgreSQL") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        db = new PostgresSyncDatabase(url.toString());
      } else db = openSqliteDatabase(":memory:");
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
    });

    afterAll(async () => {
      db?.close();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    async function fixture(reverse: boolean) {
      const tag = `${backend.toLowerCase()}-${++serial}`;
      const a = store.createWorkspace({ id: `card_a_${tag}`, name: `A ${tag}`, slug: `card-a-${tag}` });
      const b = store.createWorkspace({ id: `card_b_${tag}`, name: `B ${tag}`, slug: `card-b-${tag}` });
      const workspaceId = reverse ? b.id : a.id;
      const foreignId = reverse ? a.id : b.id;
      const openId = `ou_card_${tag}`;
      const user = store.getOrCreateUser({ externalId: openId, email: `${tag}@example.test`, name: "Card member" });
      const member = store.createWorkspaceMember({ workspaceId, userId: user.id, name: user.name, role: "member" });
      const pat = await store.createAccessToken({ workspaceId, userId: user.id, name: "Card member", type: "pat" });
      const agent = store.createAgent({ workspaceId, name: "Card bot", provider: "codex" });
      const runtimeId = `rt_card_${tag}`;
      const daemonId = `daemon_card_${tag}`;
      store.registerRuntime({ id: runtimeId, workspaceId, daemonId, name: "Card host", provider: "codex" });
      store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true, supportsIssueDecisionCard: true });
      const config = store.upsertFeishuBotConfig(workspaceId, {
        agentId: agent.id, runtimeId, appId: "cli_mul476_cards", appSecretOp: "set",
        appSecret: "mul476-card-fixture-secret", domain: "feishu", enabled: true,
      });
      store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
      store.updateWorkspace(workspaceId, { settings: {
        ...store.getWorkspace(workspaceId)!.settings,
        issueTopics: { enabled: true, chatId: `oc_${tag}`, notifyMode: "person", notifyOpenId: openId },
      } });
      const parent = store.createIssue({ workspaceId, title: `Target ${tag}` });
      store.prepareFeishuIssueTopicWithinTransaction(parent);
      const root = store.claimFeishuBotOutbound(workspaceId, runtimeId)!;
      expect(root).toBeTruthy();
      store.reportFeishuBotOutbound(workspaceId, runtimeId, root.id, {
        claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${tag}`,
      });
      const child = store.createIssue({ workspaceId, parentIssueId: parent.id, title: `PRIVATE source ${tag}` });
      const decision = store.createIssueDecision(child.id, {
        kind: "production_change", title: `PRIVATE decision ${tag}`, body: `PRIVATE body ${tag}`, options: ["yes", "no"],
      }, { type: "member", id: member.id, taskId: null });
      const delivery = db.query("SELECT id, binding_id FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?")
        .get(decision.id) as { id: string; binding_id: string };
      expect(delivery).toBeTruthy();
      // A same-workspace Issue with no part in the decision, for rows that name the wrong one.
      const other = store.createIssue({ workspaceId, title: `Other ${tag}` });
      const daemon = await store.createAccessToken({ workspaceId, daemonId, type: "daemon", name: "Card host" });
      const app = createMultiremiApp({ store, authToken: "mul476-card-root" });
      const path = `/api/daemon/issues/${parent.id}/decisions/${decision.id}`;
      const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
      return { workspaceId, foreignId, runtimeId, daemonId, member, parent, child, other, decision,
        deliveryId: delivery.id, bindingId: delivery.binding_id, app, path, headers, openId, pat: pat.token };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;

    function inTransaction(fn: () => void) {
      (db as unknown as SqlDatabase).transaction(fn)();
    }

    function snapshot() {
      return sideEffectTables.map(table => db.query(`SELECT * FROM ${table} ORDER BY id`).all());
    }

    function send(f: Fixture) {
      const card = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)!;
      expect(card.id).toBe(f.deliveryId);
      store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, card.id, {
        claimToken: card.claimToken, status: "sent", externalMessageId: `om_${card.id}`, interactionOpenId: f.openId,
      }, new Date(Date.now() - 24 * 60 * 60 * 1000));
      return card;
    }

    function moveIssue(f: Fixture, endpoint: "source" | "target") {
      db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?",
        [f.foreignId, endpoint === "source" ? f.child.id : f.parent.id]);
    }

    function laneRows(f: Fixture, kind: "decision_reminder" | "decision_card_patch") {
      return db.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ? AND kind = ?")
        .all(f.decision.id, kind);
    }

    function degradedActivities(f: Fixture) {
      return db.query(`SELECT issue_id FROM multiremi_issue_activity
        WHERE type = 'decision_card_degraded' AND issue_id IN (?, ?, ?)`).all(f.parent.id, f.child.id, f.other.id);
    }

    async function transport(f: Fixture, path: string, headers: Record<string, string> = f.headers) {
      const read = await f.app.request(path, { headers });
      const answer = await f.app.request(`${path}/answer`, {
        method: "POST", headers, body: JSON.stringify({ answer: "yes", operator_open_id: f.openId }),
      });
      const text = await read.text() + await answer.text();
      expect(text).not.toContain(f.decision.title);
      expect(text).not.toContain(f.decision.body!);
      return [read.status, answer.status];
    }

    // Each breaks exactly one link between the card row, its binding and the
    // decision, leaving every other link intact, so each SQL predicate is the
    // only thing standing between that row and a send.
    const tampers: Record<string, (f: Fixture) => void> = {
      "delivery and binding moved to another workspace": f => {
        db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET workspace_id = ? WHERE id = ?", [f.foreignId, f.deliveryId]);
        db.run("UPDATE multiremi_feishu_bot_chat_bindings SET workspace_id = ? WHERE id = ?", [f.foreignId, f.bindingId]);
      },
      "binding moved to another workspace": f => {
        db.run("UPDATE multiremi_feishu_bot_chat_bindings SET workspace_id = ? WHERE id = ?", [f.foreignId, f.bindingId]);
      },
      "binding on another Issue": f => {
        db.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE id = ?", [f.other.id, f.bindingId]);
      },
      "delivery naming another Issue": f => {
        db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET decision_issue_id = ? WHERE id = ?", [f.other.id, f.deliveryId]);
      },
      "delivery and binding on another Issue": f => {
        db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET decision_issue_id = ? WHERE id = ?", [f.other.id, f.deliveryId]);
        db.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE id = ?", [f.other.id, f.bindingId]);
      },
      "decision, source and target moved away together": f => {
        db.run("UPDATE multiremi_issue_decisions SET workspace_id = ? WHERE id = ?", [f.foreignId, f.decision.id]);
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id IN (?, ?)", [f.foreignId, f.parent.id, f.child.id]);
      },
    };

    for (const reverse of [false, true]) {
      const direction = reverse ? "B -> A" : "A -> B";
      for (const endpoint of ["source", "target"] as const) {
        const move = (f: Fixture) => moveIssue(f, endpoint);

        it.each(["escalated", "answered", "withdrawn"] as const)(`${direction}: foreign ${endpoint} decisions are hidden from card reads and %s callbacks`, async status => {
          const f = await fixture(reverse);
          send(f);
          move(f);
          db.run("UPDATE multiremi_issue_decisions SET status = ? WHERE id = ?", [status, f.decision.id]);
          const before = snapshot();
          const events: unknown[] = [];
          const stops = [
            store.onWorkspaceEvent(event => events.push(event)),
            store.onTaskEnqueued(task => events.push(task)),
          ];
          try {
            expect(store.getIssueDecisionAnywhere(f.decision.id)).toBeNull();
            expect(store.getFeishuIssueDecisionCardContext(f.workspaceId, f.decision.id)).toBeNull();
            expect(await transport(f, f.path)).toEqual([404, 404]);
            const memberRead = await f.app.request(`/api/issues/${f.parent.id}/decisions`, {
              headers: { Authorization: `Bearer ${f.pat}` },
            });
            expect(memberRead.status).toBe(endpoint === "target" ? 404 : 200);
            expect(await memberRead.text()).not.toContain(f.decision.title);
            expect(snapshot()).toEqual(before);
            expect(events).toEqual([]);
          } finally { for (const stop of stops) stop(); }
        });

        it(`${direction}: stale foreign ${endpoint} objects cannot queue a card or terminal patch`, async () => {
          const f = await fixture(reverse);
          send(f);
          move(f);
          const events = createCommitEventQueue();
          // A terminal row whose sent card is still in the outbox, so the
          // stored status cannot mask the patch guard.
          db.run("UPDATE multiremi_issue_decisions SET status = 'answered' WHERE id = ?", [f.decision.id]);
          const before = snapshot();
          inTransaction(() => store.enqueueIssueDecisionCardPatchWithinTransaction({ ...f.decision, status: "answered" }, events));
          expect(snapshot()).toEqual(before);
          expect(events).toEqual(createCommitEventQueue());
          // Escalated again and without the old outbox's idempotency record, so
          // neither can mask the prepare guard.
          db.run("UPDATE multiremi_issue_decisions SET status = 'escalated' WHERE id = ?", [f.decision.id]);
          db.run("DELETE FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?", [f.decision.id]);
          const empty = snapshot();
          inTransaction(() => store.prepareIssueDecisionCardWithinTransaction(f.parent, f.decision, events));
          expect(snapshot()).toEqual(empty);
          expect(events).toEqual(createCommitEventQueue());
        });

        it(`${direction}: foreign ${endpoint} pending, retry and degraded cards cannot be claimed or strand a valid card`, async () => {
          const f = await fixture(reverse);
          move(f);
          for (const state of ["pending", "retry", "degraded"] as const) {
            db.run(`UPDATE multiremi_feishu_bot_outbound_deliveries SET status = ?, leased_until = ?, degraded = ? WHERE id = ?`,
              [state === "retry" ? "sending" : "pending", "2000-01-01T00:00:00.000Z", state === "degraded" ? "no_recipient" : null, f.deliveryId]);
            expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
          }
          let host = f.parent;
          if (endpoint === "target") {
            // The moved target took the only topic with it, so the later card
            // needs a topic of its own. Its seed is queued after the stale card
            // and must still be the next claim.
            store.prepareFeishuIssueTopicWithinTransaction(f.child);
            const seed = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)!;
            expect(seed.id).not.toBe(f.deliveryId);
            expect(seed.decisionId ?? null).toBeNull();
            store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, seed.id, {
              claimToken: seed.claimToken, status: "sent", externalMessageId: `om_child_root_${seed.id}`,
            });
            host = f.child;
          }
          const valid = store.createIssueDecision(host.id, {
            kind: "production_change", title: "Valid later card",
          }, { type: "member", id: f.member.id, taskId: null });
          const card = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)!;
          expect(card.decisionId).toBe(valid.id);
          expect(card.body).not.toContain(f.decision.title);
        });

        it(`${direction}: foreign ${endpoint} sent cards are excluded from recovery and reminders`, async () => {
          const f = await fixture(reverse);
          send(f);
          expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toHaveLength(1);
          move(f);
          expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toEqual([]);
          expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
          expect(db.query("SELECT reminder_sent_at FROM multiremi_issue_decisions WHERE id = ?").get(f.decision.id))
            .toEqual({ reminder_sent_at: null });
          expect(laneRows(f, "decision_reminder")).toEqual([]);
        });

        it(`${direction}: a ${endpoint} moved through the store hides the card like a legacy row`, async () => {
          const f = await fixture(reverse);
          send(f);
          // Relations block a move, so the child leaves its parent first; after
          // that the store lets either Issue go, and the decision row stays put.
          store.updateIssue(f.child.id, { parent_issue_id: null });
          store.updateIssue(endpoint === "source" ? f.child.id : f.parent.id, { workspaceId: f.foreignId });
          expect(store.getIssueDecisionAnywhere(f.decision.id)).toBeNull();
          expect(store.getFeishuIssueDecisionCardContext(f.workspaceId, f.decision.id)).toBeNull();
          expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toEqual([]);
          expect(await transport(f, f.path)).toEqual([404, 404]);
          expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
          expect(laneRows(f, "decision_reminder")).toEqual([]);
        });
      }

      it(`${direction}: a decision row with a stale workspace is hidden`, async () => {
        const f = await fixture(reverse);
        send(f);
        db.run("UPDATE multiremi_issue_decisions SET workspace_id = ? WHERE id = ?", [f.foreignId, f.decision.id]);
        expect(store.getIssueDecisionAnywhere(f.decision.id)).toBeNull();
        expect(store.getFeishuIssueDecisionCardContext(f.workspaceId, f.decision.id)).toBeNull();
        expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toEqual([]);
        expect(await transport(f, f.path)).toEqual([404, 404]);
      });

      it(`${direction}: a foreign delivery cannot receive a valid decision's answer patch or reminder`, async () => {
        const f = await fixture(reverse);
        send(f);
        db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET workspace_id = ? WHERE id = ?", [f.foreignId, f.deliveryId]);
        expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
        expect(db.query("SELECT reminder_sent_at FROM multiremi_issue_decisions WHERE id = ?").get(f.decision.id))
          .toEqual({ reminder_sent_at: null });
        const result = store.answerIssueDecision(f.parent.id, f.decision.id, { answer: "yes", reason: "ok" },
          { type: "member", id: f.member.id, taskId: null });
        expect(result.status).toBe("answered");
        expect(laneRows(f, "decision_card_patch")).toEqual([]);
      });

      it(`${direction}: an intact sent card is recovered, answerable, reminded and patched`, async () => {
        // The positive twin of the tamper cases below: same fixture, same calls.
        const f = await fixture(reverse);
        send(f);
        expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toHaveLength(1);
        expect(store.getFeishuIssueDecisionCardContext(f.workspaceId, f.decision.id)?.decision.id).toBe(f.decision.id);
        expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)?.kind).toBe("decision_reminder");
        expect(laneRows(f, "decision_reminder")).toHaveLength(1);
        db.run("UPDATE multiremi_issue_decisions SET status = 'answered' WHERE id = ?", [f.decision.id]);
        inTransaction(() => store.enqueueIssueDecisionCardPatchWithinTransaction(f.decision, createCommitEventQueue()));
        expect(laneRows(f, "decision_card_patch")).toHaveLength(1);
      });

      it.each(Object.keys(tampers))(`${direction}: a sent card whose %s is not recovered, answerable, reminded or patched`, async name => {
        const f = await fixture(reverse);
        send(f);
        tampers[name]!(f);
        expect(store.listFeishuIssueDecisionCards(f.workspaceId, f.runtimeId)).toEqual([]);
        expect(store.getFeishuIssueDecisionCardContext(f.workspaceId, f.decision.id)).toBeNull();
        expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
        expect(laneRows(f, "decision_reminder")).toEqual([]);
        db.run("UPDATE multiremi_issue_decisions SET status = 'answered' WHERE id = ?", [f.decision.id]);
        inTransaction(() => store.enqueueIssueDecisionCardPatchWithinTransaction(f.decision, createCommitEventQueue()));
        expect(laneRows(f, "decision_card_patch")).toEqual([]);
      });

      it.each(Object.keys(tampers))(`${direction}: a pending card whose %s cannot be claimed`, async name => {
        const f = await fixture(reverse);
        tampers[name]!(f);
        expect(store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)).toBeNull();
      });

      it.each(["intact", "source moved", "target moved", "decision, source and target moved away together", "delivery naming another Issue"])(
        `${direction}: a host-reported degrade of a claimed card records activity only when the card is %s`, async name => {
          const f = await fixture(reverse);
          const card = store.claimFeishuBotOutbound(f.workspaceId, f.runtimeId)!;
          expect(card.id).toBe(f.deliveryId);
          if (name === "source moved" || name === "target moved") moveIssue(f, name === "source moved" ? "source" : "target");
          else if (name !== "intact") tampers[name]!(f);
          expect(store.reportFeishuBotOutbound(f.workspaceId, f.runtimeId, card.id, {
            claimToken: card.claimToken, status: "sent", externalMessageId: "om_text_twin",
            interactionOpenId: null, degraded: "send_failed",
          })).toBe(true);
          expect(degradedActivities(f)).toEqual(name === "intact" ? [{ issue_id: f.parent.id }] : []);
        });

      it(`${direction}: a stale Issue object cannot queue a card in the workspace its decision left`, async () => {
        const f = await fixture(reverse);
        tampers["decision, source and target moved away together"]!(f);
        db.run("DELETE FROM multiremi_feishu_bot_outbound_deliveries WHERE decision_id = ?", [f.decision.id]);
        const before = snapshot();
        inTransaction(() => store.prepareIssueDecisionCardWithinTransaction(f.parent, f.decision, createCommitEventQueue()));
        expect(snapshot()).toEqual(before);
      });

      it(`${direction}: the card transport keeps the 403 for anything but this workspace's decision on that Issue`, async () => {
        const f = await fixture(reverse);
        send(f);
        const foreignDaemon = await store.createAccessToken({
          workspaceId: f.foreignId, daemonId: `${f.daemonId}_foreign`, type: "daemon", name: "Foreign host",
        });
        const foreignHeaders = { Authorization: `Bearer ${foreignDaemon.token}`, "Content-Type": "application/json" };
        // The source left: a daemon of the workspace it went to never had this card.
        moveIssue(f, "source");
        expect(await transport(f, f.path, foreignHeaders)).toEqual([403, 403]);
        expect(await transport(f, f.path)).toEqual([404, 404]);
        // The target left too: only the decision this workspace recorded on it is hidden as 404.
        moveIssue(f, "target");
        expect(await transport(f, f.path)).toEqual([404, 404]);
        // Only the two card verbs get the 404; any other request on that Issue keeps the 403.
        for (const [method, suffix] of [["GET", "/history"], ["POST", "/withdraw"], ["PUT", ""]] as const) {
          const other = await f.app.request(`${f.path}${suffix}`, {
            method, headers: f.headers, body: method === "GET" ? undefined : "{}",
          });
          expect([method, suffix, other.status]).toEqual([method, suffix, 403]);
        }
        expect(await transport(f, `/api/daemon/issues/${f.parent.id}/decisions/dec_missing`)).toEqual([403, 403]);
        const stranger = store.createIssue({ workspaceId: f.foreignId, title: "Stranger" });
        expect(await transport(f, `/api/daemon/issues/${stranger.id}/decisions/${f.decision.id}`)).toEqual([403, 403]);
      });
    }
  });
}
