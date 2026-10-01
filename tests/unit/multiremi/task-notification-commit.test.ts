import { describe, expect, it } from "bun:test";
import type { MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import { StoreContext } from "@multiremi/store/context.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";

describe("task notifications respect the caller's commit", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: state events and Feishu materialization see committed rows; rollback drops both`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Commit worker", provider: "claude" });
        const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "commit" });
        const received: string[] = [];
        const materialized: string[] = [];
        store.materializeFeishuTaskDeliveries = (id) => {
          expect(ctx.db.inTransaction).toBe(false);
          materialized.push(store.getTask(id)!.status);
        };
        store.onTaskEvent(() => { throw new Error("broken subscriber"); });
        store.onTaskEvent(({ type, task: eventTask }) => {
          expect(ctx.db.inTransaction).toBe(false);
          expect(store.getTask(task.id)?.status).toBe(eventTask.status);
          received.push(type);
        });
        const statuses = ["running", "awaiting_human", "completed", "failed", "cancelled"] as const;
        for (const status of statuses) {
          const before = received.length;
          ctx.db.transaction(() => {
            ctx.db.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, task.id]);
            ctx.notifyTaskEvent(`task:${status}`, { ...task, status });
            expect(received).toHaveLength(before);
            expect(materialized).toHaveLength(before);
          })();
          expect(received.at(-1)).toBe(`task:${status}`);
          expect(materialized.at(-1)).toBe(status);
          expect(() => ctx.db.transaction(() => {
            ctx.db.run("UPDATE multiremi_tasks SET status = 'queued' WHERE id = ?", [task.id]);
            ctx.notifyTaskEvent("task:running", { ...task, status: "running" });
            throw new Error("rollback event");
          })()).toThrow("rollback event");
          expect(store.getTask(task.id)?.status).toBe(status);
          expect(received).toHaveLength(before + 1);
          expect(materialized).toHaveLength(before + 1);
        }
        ctx.notifyTaskEvent("task:cancelled", { ...task, status: "cancelled" });
        expect(received).toHaveLength(statuses.length + 1);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: a real materialization SQL failure cannot abort the committed task`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Delivery worker", provider: "claude" });
        const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "delivery" });
        let attempts = 0;
        let received = 0;
        store.materializeFeishuTaskDeliveries = () => {
          attempts += 1;
          expect(ctx.db.inTransaction).toBe(false);
          ctx.db.run("INSERT INTO mul482_missing_delivery_table (id) VALUES (?)", [task.id]);
        };
        store.onTaskEvent(() => { received += 1; });
        expect(() => ctx.db.transaction(() => {
          ctx.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [task.id]);
          ctx.notifyTaskEvent("task:completed", { ...task, status: "completed" });
          expect(attempts).toBe(0);
        })()).not.toThrow();
        expect(store.getTask(task.id)?.status).toBe("completed");
        expect(attempts).toBe(1);
        expect(received).toBe(1);
        // The connection remains usable after the optional SQL failure.
        ctx.db.transaction(() => ctx.db.run("UPDATE multiremi_tasks SET status = 'failed' WHERE id = ?", [task.id]))();
        expect(store.getTask(task.id)?.status).toBe("failed");
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: messages preserve persisted identity and order and do not escape rollback`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Message worker", provider: "claude" });
        const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "messages" });
        const messages = store.appendTaskMessages(task.id, [
          { type: "text", content: "one" }, { type: "text", content: "two" },
        ]);
        const received: MultiremiTaskMessage[][] = [];
        store.onTaskMessages(({ task: eventTask, messages: batch }) => {
          expect(ctx.db.inTransaction).toBe(false);
          expect(eventTask.id).toBe(task.id);
          expect(store.listTaskMessages(task.id)).toEqual(batch);
          received.push(batch);
        });
        ctx.db.transaction(() => {
          ctx.notifyTaskMessages(task, messages);
          expect(received).toHaveLength(0);
        })();
        expect(received).toEqual([messages]);
        expect(() => ctx.db.transaction(() => {
          ctx.db.run("UPDATE multiremi_task_messages SET content = 'rolled back' WHERE id = ?", [messages[0]!.id]);
          ctx.notifyTaskMessages(task, [{ ...messages[0]!, content: "rolled back" }]);
          throw new Error("rollback messages");
        })()).toThrow("rollback messages");
        expect(received).toEqual([messages]);
        expect(store.listTaskMessages(task.id)).toEqual(messages);
        ctx.notifyTaskMessages(task, []);
        expect(received).toHaveLength(1);
        ctx.notifyTaskMessages(task, messages);
        expect(received).toEqual([messages, messages]);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: inbox fanout creates and dispatches deliveries only after commit`, async () => {
      await withConversationLogStore(backend, async (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const member = store.listWorkspaceMembers("local")[0]!;
        store.createNotificationChannel({ workspaceId: "local", kind: "feishu_group", name: "Commit channel",
          target: { chatId: "oc_commit" }, eventTypes: ["*"], minSeverity: "info", createdBy: "local" });
        const dispatched: string[] = [];
        store.dispatchNotificationDelivery = async (id) => {
          expect(ctx.db.inTransaction).toBe(false);
          expect(store.getNotificationDelivery(id)).not.toBeNull();
          dispatched.push(id);
        };
        const create = () => ctx.createInboxItem({ workspaceId: "local", memberId: member.id,
          type: "issue_assigned", title: "Commit notification", body: "body", actorType: "system", actorId: null });
        expect(() => ctx.db.transaction(() => {
          create();
          expect(store.listNotificationDeliveries({ workspaceId: "local" })).toHaveLength(0);
          throw new Error("rollback inbox");
        })()).toThrow("rollback inbox");
        await Bun.sleep(0);
        expect(dispatched).toHaveLength(0);
        expect(store.listNotificationDeliveries({ workspaceId: "local" })).toHaveLength(0);
        ctx.db.transaction(() => { create(); expect(dispatched).toHaveLength(0); })();
        await Bun.sleep(0);
        expect(store.listNotificationDeliveries({ workspaceId: "local" })).toHaveLength(1);
        expect(dispatched).toHaveLength(1);
      });
    }, 30_000);
  }
});

