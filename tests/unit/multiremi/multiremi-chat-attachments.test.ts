import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { uploadedAttachmentPath, uploadRoot } from "@multiremi/api/helpers/uploads.js";
import { FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER } from "@multiremi/contracts/types.js";
import { CHAT_ATTACHMENT_MAX_BYTES, chatAttachmentValidationError, sanitizeChatAttachmentFilename } from "@multiremi/contracts/attachments.js";
import { createLocalStore, db, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  useUploadDir();
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

async function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Attachments", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_files", name: "Files", provider: "codex", workspaceId: "local", daemonId: "files-daemon" });
  store.heartbeatRuntime("rt_files", { supportsFeishuBotConfig: true });
  const token = await store.createAccessToken({ name: "Files", type: "daemon", workspaceId: "local", daemonId: "files-daemon" });
  const config = store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: "rt_files", enabled: true,
    appId: "cli_files", appSecretOp: "set", appSecret: "test-attachment-secret", domain: "feishu" });
  store.reportFeishuBotRuntimeStatus("local", "rt_files", { state: "online", appliedRevision: config.revision });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const scope = { revision: config.revision, externalSessionKey: "ou_sender", externalMessageId: "om_pdf" };
  const submit = (extra = {}) => store.submitFeishuBotMessage("local", "rt_files", {
    ...scope, chatType: "p2p", chatId: "oc_private", senderOpenId: "ou_sender", text: "read attachment", ...extra,
  });
  const upload = (extra: Record<string, string> = {}, file = new File(["PDF"], "报告.pdf")) => {
    const form = new FormData();
    form.set("file", file);
    form.set("revision", String(config.revision));
    form.set("external_session_key", scope.externalSessionKey);
    form.set("external_message_id", scope.externalMessageId);
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return app.request("/api/daemon/runtimes/rt_files/feishu-bot/attachments", {
      method: "POST", headers: { Authorization: `Bearer ${token.token}` }, body: form,
    });
  };
  return { store, agent, token, app, config, scope, submit, upload };
}

function sendForm(files: File[], content = "") {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  form.set("content", content);
  return form;
}

describe("Chat attachment transport", () => {
  it("links inbound bytes before claim, serves CJK filenames to only that Chat task, and retains active steer attachments", async () => {
    const f = await fixture();
    const response = await f.upload();
    expect(response.status).toBe(201);
    const { attachment } = await response.json();
    expect((await f.app.request(`/api/attachments/${attachment.id}/download`, { headers: { Authorization: "Bearer MASTER" } })).status).toBe(404);
    const submitted = f.submit({ attachmentIds: [attachment.id] });
    const task = f.store.getTaskWithAgent(submitted.taskId)!;
    const wire = daemonTaskClaimResponse(f.store, task);
    expect(wire.chat_message_attachments).toMatchObject([{ id: attachment.id, filename: "报告.pdf", size_bytes: 3 }]);
    expect(f.store.getAttachment(attachment.id)?.chatSessionId).toBe(submitted.chatSessionId);
    const credential = await f.store.createTaskAccessToken(task, "local");
    const downloaded = await f.app.request(`/api/attachments/${attachment.id}/download`, { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    expect(await downloaded.text()).toBe("PDF");
    const otherChat = f.store.createChatSession({ agentId: f.agent.id, creatorId: "local" });
    const otherTask = f.store.createTask({ agentId: f.agent.id, chatSessionId: otherChat.id, prompt: "other chat" });
    const otherCredential = await f.store.createTaskAccessToken(otherTask, "local");
    expect((await f.app.request(`/api/attachments/${attachment.id}/download`, {
      headers: { Authorization: `Bearer ${otherCredential.token}` },
    })).status).toBe(404);
    const second = await (await f.upload({ external_message_id: "om_image" }, new File(["image"], "screenshot.png"))).json();
    const steered = f.submit({ externalMessageId: "om_image", attachmentIds: [second.attachment.id] });
    expect(steered.steered).toBe(true);
    expect(f.store.listPendingTaskSteerMessages(task.id)).toMatchObject([
      { attachments: [{ id: second.attachment.id, filename: "screenshot.png", contentType: "image/png" }] },
    ]);
    expect(f.submit({ attachmentIds: [attachment.id] }).duplicate).toBe(true);
    expect(f.store.listChatMessages(submitted.chatSessionId).filter(message => message.role === "user")).toHaveLength(2);
  });

  it("rejects stale and foreign inbound scopes without linking an attachment or creating a Chat", async () => {
    const f = await fixture();
    expect((await f.upload({ revision: "999" })).status).toBe(409);
    const { attachment } = await (await f.upload()).json();
    for (const patch of [{ externalMessageId: "om_other" }, { externalSessionKey: "ou_other" }]) {
      expect(() => f.submit({ ...patch, attachmentIds: [attachment.id] })).toThrow("attachment does not belong");
    }
    expect(f.store.listChatSessions("local")).toHaveLength(0);
    const ordinary = f.store.createAttachment({ filename: "ordinary.pdf", url: "/api/attachments/att_unrelated/content" });
    expect(() => f.submit({ attachmentIds: [ordinary.id] })).toThrow("attachment does not belong");
    expect(f.store.getAttachment(attachment.id)?.chatSessionId).toBeNull();
    const wrong = await f.store.createAccessToken({ name: "Wrong daemon", type: "daemon", workspaceId: "local", daemonId: "other-daemon" });
    const response = await f.app.request("/api/daemon/runtimes/rt_files/feishu-bot/attachments", {
      method: "POST", headers: { Authorization: `Bearer ${wrong.token}` }, body: sendForm([new File(["x"], "x.pdf")]),
    });
    expect(response.status).toBe(403);
    expect((await f.upload({}, new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], "large.pdf"))).status).toBe(413);
  });

  it("queues HTML with caption for the Task destination, gates old hosts and guards file bytes by active lease", async () => {
    const f = await fixture();
    const submitted = f.submit();
    const task = f.store.getTask(submitted.taskId)!;
    const credential = await f.store.createTaskAccessToken(task, "local");
    const form = sendForm([new File(["<h1>report</h1>"], "report.html", { type: "image/png" }), new File(["png"], "chart.png")], "Report attached");
    // Request-supplied conversation identities must never override the task.
    form.set("chat_session_id", "chat_victim");
    form.set("chat_id", "oc_victim");
    const response = await f.app.request("/api/chat/attachments/send", { method: "POST", headers: { Authorization: `Bearer ${credential.token}` }, body: form });
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toMatchObject({ chatSessionId: submitted.chatSessionId, contentType: "text/html" });
    expect(result.delivery_ids).toHaveLength(2);
    expect(f.store.claimFeishuBotOutbound("local", "rt_files", undefined, true, true)).toBeNull();
    const delivery = f.store.claimFeishuBotOutbound("local", "rt_files", undefined, true, true, true)!;
    expect(delivery).toMatchObject({ chatId: "oc_private", threadId: null, replyToMessageId: null, bodyOrigin: "agent", body: "Report attached" });
    const bodies = db!.query("SELECT body FROM multiremi_feishu_bot_outbound_deliveries ORDER BY body").all();
    expect(bodies).toEqual([{ body: "" }, { body: "Report attached" }]);
    const id = delivery.attachments![0]!.id;
    const path = `/api/daemon/runtimes/rt_files/feishu-bot/outbound/${delivery.id}/attachments/${id}`;
    const headers = { Authorization: `Bearer ${f.token.token}`, [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: delivery.claimToken };
    expect((await f.app.request(path, { headers })).status).toBe(200);
    expect((await f.app.request(path, { headers: { ...headers, [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: "wrong" } })).status).toBe(404);
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", delivery.id, { claimToken: delivery.claimToken, status: "streaming" })).toBe(true);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET leased_until = ? WHERE id = ?", [new Date(Date.now() - 1).toISOString(), delivery.id]);
    expect((await f.app.request(path, { headers })).status).toBe(404);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET leased_until = ? WHERE id = ?", [new Date(Date.now() + 60_000).toISOString(), delivery.id]);
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", delivery.id, { claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_file" })).toBe(true);
    expect((await f.app.request(path, { headers })).status).toBe(404);
    expect(db!.query("SELECT external_session_key, thread_id FROM multiremi_feishu_bot_chat_bindings").get())
      .toEqual({ external_session_key: "ou_sender", thread_id: null });
  });

  it("rejects the whole outbound batch before any write and requires a current Chat credential", async () => {
    const f = await fixture();
    const submitted = f.submit();
    const credential = await f.store.createTaskAccessToken(f.store.getTask(submitted.taskId)!, "local");
    const send = (files: File[], token = credential.token) => f.app.request("/api/chat/attachments/send", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: sendForm(files),
    });
    const oversized = await send([new File(["ok"], "ok.html"), new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], "large.pdf")]);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toContain("20MB");
    const disallowed = await send([new File(["ok"], "ok.html"), new File(["source"], "repo.ts")]);
    expect(disallowed.status).toBe(400);
    expect((await disallowed.json()).error).toContain("not allowed");
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_attachments").get()).toEqual({ n: 0 });
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get()).toEqual({ n: 0 });
    expect(existsSync(uploadRoot()) ? readdirSync(uploadRoot(), { recursive: true }) : []).toHaveLength(0);
    expect((await send([new File(["x"], "x.html")], "MASTER")).status).toBe(403);
    const nonChat = f.store.createTask({ agentId: f.agent.id, prompt: "issue task" });
    const nonChatToken = await f.store.createTaskAccessToken(nonChat, "local");
    expect((await send([new File(["x"], "x.html")], nonChatToken.token)).status).toBe(403);
  });

  it("rejects an empty file anywhere in an outbound batch before persisting bytes, messages, or deliveries", async () => {
    const f = await fixture();
    const submitted = f.submit();
    const credential = await f.store.createTaskAccessToken(f.store.getTask(submitted.taskId)!, "local");
    for (const filename of ["empty.png", "空 报告.html"]) {
      expect(chatAttachmentValidationError(filename, 0)).toBe(`Attachment ${filename} is empty (0 bytes)`);
      const empty = new File([], filename);
      for (const files of [[empty], [new File(["report"], "valid.html"), empty]]) {
        const response = await f.app.request("/api/chat/attachments/send", {
          method: "POST", headers: { Authorization: `Bearer ${credential.token}` }, body: sendForm(files),
        });
        expect(response.status).toBe(400);
        // Bun 1.3.14's multipart parser drops empty File.name. The API must
        // identify its field number; the CLI still reports the local filename.
        expect((await response.json()).error).toBe(`Attachment file #${files.length} is empty (0 bytes)`);
        expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_attachments").get()).toEqual({ n: 0 });
        expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries").get()).toEqual({ n: 0 });
        expect(f.store.listChatMessages(submitted.chatSessionId).filter(message => message.role === "assistant")).toHaveLength(0);
        expect(existsSync(uploadRoot()) ? readdirSync(uploadRoot(), { recursive: true }) : []).toHaveLength(0);
      }
    }
  });

  it("includes Web Chat attachments even when the selected message has no text and isolates duplicate filenames", async () => {
    const f = await fixture();
    const session = f.store.createChatSession({ agentId: f.agent.id, creatorId: "local" });
    const task = f.store.createTask({ agentId: f.agent.id, chatSessionId: session.id, prompt: "attachment" });
    const message = f.store.appendChatMessageWithinTransaction({ chatSessionId: session.id, taskId: task.id, role: "user", body: "" });
    const attachment = f.store.createAttachment({ filename: "web.pdf", url: "/api/attachments/att_web/content", chatSessionId: session.id, chatMessageId: message.id });
    expect(daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(task.id)!).chat_message_attachments)
      .toMatchObject([{ id: attachment.id, filename: "web.pdf" }]);
    const credential = await f.store.createTaskAccessToken(task, "local");
    const result = await (await f.app.request("/api/chat/attachments/send", {
      method: "POST", headers: { Authorization: `Bearer ${credential.token}` },
      body: sendForm([new File(["1"], "same.pdf"), new File(["2"], "same.pdf")]),
    })).json();
    expect(result.delivery_ids).toEqual([]);
    expect(uploadedAttachmentPath(result.attachments[0])).not.toBe(uploadedAttachmentPath(result.attachments[1]));
  });

  it("bounds Unicode filenames and removes POSIX/Windows path traversal and control characters", () => {
    expect(sanitizeChatAttachmentFilename("../../test.pdf")).toBe("test.pdf");
    expect(sanitizeChatAttachmentFilename("C:\\secret\\报告\u0000.pdf")).toBe("报告.pdf");
    expect(sanitizeChatAttachmentFilename(" .. ")).toBe("attachment.bin");
    const filename = sanitizeChatAttachmentFilename("报".repeat(300) + ".pdf");
    expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(180);
    expect(filename.endsWith(".pdf")).toBe(true);
  });
});
