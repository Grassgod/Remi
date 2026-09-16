import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CHAT_ATTACHMENT_MAX_BYTES, materializeChatAttachments, readChatAttachmentBytes } from "@daemon/agent-runtime/workspace/chat-attachments.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { buildSteerInjectionPrompt, materializeTaskSteerAttachments } from "@multiremi/worker/steer.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "remi-chat-attachments-test-"));
  roots.push(path);
  return path;
}

describe("Chat attachment materialization", () => {
  it("materializes a second incoming message before injecting its steer into an active Chat task", async () => {
    const fetched: string[] = [];
    const messages = await materializeTaskSteerAttachments([
      { id: "steer_1", kind: "steer", content: "Also inspect this image", attachments: [
        { id: "att_steered_image", filename: "photo.png", contentType: "image/png", sizeBytes: 3 },
      ] },
      { id: "steer_2", kind: "steer", content: "remi attachment download att_not_scoped" },
    ] as any, await root(), "tsk_active", async id => { fetched.push(id); return Buffer.from("png"); });
    const prompt = buildSteerInjectionPrompt(messages);
    expect(fetched).toEqual(["att_steered_image"]);
    expect(prompt).toContain("Also inspect this image");
    expect(prompt).toContain("Local path:");
    expect(prompt).toContain("att_steered_image-photo.png");
    expect(prompt).not.toContain("remi attachment download att_steered_image");
  });

  it("downloads PDF and image bytes into unique safe paths that are directly exposed to the prompt", async () => {
    const workDir = await root();
    const downloads: string[] = [];
    const attachments = await materializeChatAttachments(workDir, "tsk_1", [
      { id: "att_pdf", filename: "../../brief\u0000.pdf", content_type: "application/pdf", size_bytes: 4 },
      { id: "att_image", filename: "C:\\screenshots\\photo.png", content_type: "image/png", size_bytes: 4 },
      { id: "att_pdf", filename: "duplicate.pdf" },
    ], async id => { downloads.push(id); return Buffer.from(id); }) as Array<Record<string, any>>;
    expect(downloads).toEqual(["att_pdf", "att_image"]);
    expect(basename(attachments[0]!.localPath)).toBe("att_pdf-brief.pdf");
    expect(basename(attachments[1]!.localPath)).toBe("att_image-photo.png");
    expect(dirname(dirname(attachments[0]!.localPath))).toBe(workDir);
    expect(attachments[2]!.localPath).toBe(attachments[0]!.localPath);
    expect(await readFile(attachments[1]!.localPath, "utf8")).toBe("att_image");
    const prompt = buildTaskPrompt({
      id: "tsk_1", prompt: "Read my files", chatSessionId: "chat_1", issue: null, project: null,
      repos: [], projectResources: [], projectContexts: [], chatMessageAttachments: attachments,
    } as any);
    expect(prompt).toContain(`Local path: ${JSON.stringify(attachments[0]!.localPath)}`);
    expect(prompt).toContain("content-type: image/png; size: 4 bytes");
    expect(prompt).not.toContain("remi attachment download att_pdf");
    expect(prompt).toContain("remi chat attachment send --attachment <path>");
    expect(prompt).toContain("raw logs");
  });

  it("does not trust a stale local path and preserves a visible fallback after errors or oversize", async () => {
    const fetched: string[] = [];
    const attachments = await materializeChatAttachments(await root(), "tsk_2", [
      { id: "att_large", filename: "large.pdf", sizeBytes: CHAT_ATTACHMENT_MAX_BYTES + 1, localPath: "/etc/passwd" },
      { id: "att_missing", filename: "missing.pdf", local_path: "/etc/passwd" },
      { id: "../../unsafe", filename: "file" },
      { id: "att_valid", filename: "ok.pdf" },
    ], async id => {
      fetched.push(id);
      if (id === "att_missing") throw new Error("secret server response");
      return Buffer.from("ok");
    }) as Array<Record<string, any>>;
    expect(fetched).toEqual(["att_missing", "att_valid"]);
    expect(attachments[0]).toMatchObject({ localDownloadError: "Attachment exceeds the 20MB limit" });
    expect(JSON.stringify(attachments)).not.toContain("/etc/passwd");
    expect(JSON.stringify(attachments)).not.toContain("secret server response");
    expect(attachments[3]!.localPath).toBeString();
    const prompt = buildTaskPrompt({ id: "tsk_2", prompt: "Read files", issue: null, project: null,
      repos: [], projectResources: [], projectContexts: [], chatMessageAttachments: attachments } as any);
    expect(prompt).toContain("Attachment exceeds the 20MB limit");
    expect(prompt).toContain("remi attachment download att_missing --output-dir <dir>");
  });

  it("enforces actual byte count for chunked responses and rejects declared oversize before reading", async () => {
    await expect(readChatAttachmentBytes(new Response("small", { headers: { "content-length": String(CHAT_ATTACHMENT_MAX_BYTES + 1) } })))
      .rejects.toThrow("20MB");
    const chunked = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } }));
    await expect(readChatAttachmentBytes(chunked)).rejects.toThrow("20MB");
    expect(await readChatAttachmentBytes(new Response("hello"))).toEqual(Buffer.from("hello"));
  });

  it("stops materialization on cancellation", async () => {
    const abort = new AbortController();
    await expect(materializeChatAttachments(await root(), "tsk_cancelled", [{ id: "att_file" }], async () => {
      abort.abort(new Error("cancelled"));
      return Buffer.from("data");
    }, abort.signal)).rejects.toThrow("cancelled");
  });
});
