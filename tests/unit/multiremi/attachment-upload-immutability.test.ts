import { expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MultiremiAttachment } from "@multiremi/contracts/types.js";
import { attachmentIdsFromText } from "@multiremi/contracts/attachments.js";
import { persistUploadedAttachments, uploadedAttachmentPath, uploadRoot } from "@multiremi/api/helpers/uploads.js";
import { createPr2Harness, type Pr2Harness } from "../../fixtures/multiremi/first-screen-hotspots-pr2-fixture.js";

const collisionUuid = "01234567-89ab-4000-8000-000000000000";
const collisionId = `att_${collisionUuid.replaceAll("-", "")}`;

async function withIds<T>(ids: string[], run: () => Promise<T>) {
  const randomUUID = crypto.randomUUID;
  let calls = 0;
  crypto.randomUUID = () => (ids[calls++] ?? randomUUID.call(crypto)) as ReturnType<typeof crypto.randomUUID>;
  try { return { result: await run(), calls }; }
  finally { crypto.randomUUID = randomUUID; }
}

function diskFiles() {
  return readdirSync(uploadRoot(), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => `${entry.parentPath}/${entry.name}`).sort();
}

function original(h: Pr2Harness, filename = "collision.pdf") {
  const attachment = h.store.createAttachment({ id: collisionId, workspaceId: "local",
    uploaderId: h.fixture.readerUserId, filename, url: `/api/attachments/${collisionId}/content` });
  const path = uploadedAttachmentPath(attachment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "original", { flag: "wx" });
  return attachment;
}

async function writer(h: Pr2Harness, kind: "ordinary" | "task" | "daemon") {
  if (kind === "ordinary") return async () => {
    const form = new FormData();
    form.set("file", new File(["replacement"], "collision.pdf"));
    form.set("workspaceId", "local");
    return h.app.request("/api/upload-file", { method: "POST", headers: h.headers, body: form });
  };
  if (kind === "task") {
    const task = h.store.createTask({ agentId: h.fixture.agentIds[0]!,
      chatSessionId: h.fixture.sessionIds[0]!, prompt: "send an attachment" });
    const credential = await h.store.createTaskAccessToken(task, "local");
    return async () => {
      const form = new FormData();
      form.set("file", new File(["replacement"], "collision.pdf"));
      form.set("message", JSON.stringify({ message_kind: "report", body_md: "replacement" }));
      return h.app.request(`/api/sessions/${task.chatSessionId}/messages`, { method: "POST",
        headers: { Authorization: `Bearer ${credential.token}` }, body: form });
    };
  }
  const runtimeId = h.fixture.runtimeId;
  h.store.registerRuntime({ id: runtimeId, name: "Collision runtime", provider: "codex",
    workspaceId: "local", daemonId: "mul473-collision-daemon" });
  h.store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
  const credential = await h.store.createAccessToken({ name: "Collision daemon", type: "daemon",
    workspaceId: "local", daemonId: "mul473-collision-daemon" });
  const config = h.store.upsertFeishuBotConfig("local", { agentId: h.fixture.agentIds[0]!, runtimeId,
    enabled: true, appId: "cli_collision", appSecretOp: "set", appSecret: "test-collision-secret", domain: "feishu" });
  return async () => {
    const form = new FormData();
    form.set("file", new File(["replacement"], "collision.pdf"));
    form.set("revision", String(config.revision));
    form.set("external_session_key", "ou_collision");
    form.set("external_message_id", "om_collision");
    return h.app.request(`/api/daemon/runtimes/${runtimeId}/feishu-bot/attachments`, {
      method: "POST", headers: { Authorization: `Bearer ${credential.token}` }, body: form });
  };
}

for (const kind of ["ordinary", "task", "daemon"] as const) {
  for (const collision of ["file", "primary key"] as const) {
    it(`${kind} upload retries a ${collision} collision without changing old bytes or leaving files`, async () => {
      const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      const h = await createPr2Harness({ attachmentOnly: true });
      try {
        // A different suffix lets wx succeed, then exercises the real backend's INSERT rejection.
        const existing = original(h, collision === "file" ? "collision.pdf" : "collision.txt");
        const before = await h.app.request(existing.url, { headers: h.headers });
        const etag = before.headers.get("etag")!;
        expect(await before.text()).toBe("original");
        const filesBefore = diskFiles();
        const upload = await writer(h, kind);
        const { result: response, calls } = await withIds([collisionUuid], upload);
        expect(response.status).toBe(kind === "ordinary" || kind === "task" ? 200 : 201);
        const body = await response.json();
        if (kind === "task") expect(body.message.attachments).toHaveLength(1);
        const attachment = (kind === "task" ? body.message.attachments[0] : body.attachment) as MultiremiAttachment;
        expect(calls).toBe(2);
        expect(attachment.id).toMatch(/^att_[0-9a-f]{32}$/);
        expect(attachment.id).not.toBe(existing.id);
        expect(existsSync(uploadedAttachmentPath(existing)), "the original attachment file must survive").toBe(true);
        expect(readFileSync(uploadedAttachmentPath(existing), "utf8")).toBe("original");
        expect(readFileSync(uploadedAttachmentPath(attachment), "utf8")).toBe("replacement");
        expect(diskFiles()).toEqual([...filesBefore, uploadedAttachmentPath(attachment)].sort());
        const after = await h.app.request(existing.url, { headers: h.headers });
        expect(after.headers.get("etag")).toBe(etag);
        expect(await after.text()).toBe("original");
        const conditional = await h.app.request(existing.url, { headers: { ...h.headers, "If-None-Match": etag } });
        expect(conditional.status).toBe(304);
        expect(await conditional.text()).toBe("");
      } finally {
        await h.dispose();
        if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
        else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
      }
    }, 20000);
  }
}

for (const collision of ["file", "primary key"] as const) {
  it(`stops after three ${collision} collisions, preserves the original and leaves no files`, async () => {
    const h = await createPr2Harness({ attachmentOnly: true });
    try {
      const existing = original(h, collision === "file" ? "collision.pdf" : "collision.txt");
      const filesBefore = diskFiles();
      const upload = await writer(h, "ordinary");
      const { result: response, calls } = await withIds([collisionUuid, collisionUuid, collisionUuid], upload);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "attachment id collision after 3 upload attempts" });
      expect(calls).toBe(3);
      expect(readFileSync(uploadedAttachmentPath(existing), "utf8")).toBe("original");
      expect(diskFiles()).toEqual(filesBefore);
      expect(h.store.getAttachment(collisionId)).toEqual(existing);
    } finally { await h.dispose(); }
  }, 20000);
}

it("cleans a real non-collision INSERT failure without retrying or deleting preexisting bytes", async () => {
  const h = await createPr2Harness({ attachmentOnly: true });
  try {
    const existing = original(h);
    const filesBefore = diskFiles();
    h.db.exec("CREATE TABLE mul473_rejected_upload (id TEXT PRIMARY KEY, required_value TEXT NOT NULL)");
    const { calls } = await withIds([], async () => {
      await expect(persistUploadedAttachments("local", [{ filename: "rejected.pdf",
        bytes: new TextEncoder().encode("replacement"), contentType: "application/pdf" }],
      ([input]) => h.db.run("INSERT INTO mul473_rejected_upload (id) VALUES (?)", input!.id))).rejects.toThrow();
    });
    expect(calls).toBe(1);
    expect(diskFiles()).toEqual(filesBefore);
    expect(readFileSync(uploadedAttachmentPath(existing), "utf8")).toBe("original");
  } finally { await h.dispose(); }
}, 20000);

it("rolls back every row and created file when a Chat batch INSERT collides", async () => {
  const h = await createPr2Harness({ attachmentOnly: true });
  try {
    original(h, "collision.txt");
    const filesBefore = diskFiles();
    const task = h.store.createTask({ agentId: h.fixture.agentIds[0]!,
      chatSessionId: h.fixture.sessionIds[0]!, prompt: "send a batch" });
    const messagesBefore = h.store.listChatMessages(task.chatSessionId!).length;
    const firstUuid = "11111111-1111-4111-8111-111111111111";
    const files = ["first.pdf", "collision.pdf"].map(filename => ({ filename,
      bytes: new TextEncoder().encode("replacement"), contentType: "application/pdf" }));
    await withIds([firstUuid, collisionUuid, firstUuid, collisionUuid, firstUuid, collisionUuid], async () => {
      await expect(persistUploadedAttachments("local", files,
        inputs => h.store.sendChatAttachments(task.id, inputs))).rejects.toThrow("attachment id collision after 3 upload attempts");
    });
    expect(diskFiles()).toEqual(filesBefore);
    expect(h.store.getAttachment(`att_${firstUuid.replaceAll("-", "")}`)).toBeNull();
    expect(h.store.listChatMessages(task.chatSessionId!)).toHaveLength(messagesBefore);
  } finally { await h.dispose(); }
}, 20000);

it("keeps old ids readable and extracts full UUID ids from attachment URLs", () => {
  const oldId = "att_0123456789ab";
  expect(attachmentIdsFromText(`/api/attachments/${oldId}/content /api/attachments/${collisionId}/download`))
    .toEqual([oldId, collisionId]);
});

it("hard-deletes legacy attachments but never truncates a new upload back to the old id", async () => {
  const h = await createPr2Harness({ attachmentOnly: true });
  try {
    const id = "att_0123456789ab";
    const existing = h.store.createAttachment({ id, workspaceId: "local", uploaderId: h.fixture.readerUserId,
      filename: "collision.pdf", url: `/api/attachments/${id}/content` });
    writeFileSync(uploadedAttachmentPath(existing), "original", { flag: "wx" });
    const before = await h.app.request(existing.url, { headers: h.headers });
    expect(before.status).toBe(200);
    expect(before.headers.get("etag")).toBe(`"${id}"`);
    expect(await before.text()).toBe("original");
    const deleted = await h.app.request(`/api/attachments/${id}`, { method: "DELETE", headers: h.headers });
    expect(deleted.status).toBe(200);
    expect(h.store.getAttachment(id)).toBeNull();
    expect(existsSync(uploadedAttachmentPath(existing))).toBe(false);
    const upload = await writer(h, "ordinary");
    const { result } = await withIds([collisionUuid], upload);
    expect(result.status).toBe(200);
    expect((await result.json()).attachment.id).toBe(collisionId);
    const stale = await h.app.request(existing.url, { headers: { ...h.headers, "If-None-Match": `"${id}"` } });
    expect(stale.status).toBe(404);
    expect(await stale.json()).toEqual({ error: "attachment not found" });
  } finally { await h.dispose(); }
}, 20000);
