import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { prepareSessionArchive } from "@daemon/agent-runtime/workspace/session-archive.js";
import { readZipCentralDirectory, readZipMember } from "@shared/zip/reader.js";

const storage = mkdtempSync(join(tmpdir(), "dw-"));
const sessionRoot = join(storage, ".runtime", "ises_1");
mkdirSync(join(sessionRoot, "traces"), { recursive: true });
mkdirSync(join(sessionRoot, "agt_1", "1", "home", "projects"), { recursive: true });
writeFileSync(join(sessionRoot, "traces", "tsk_a.jsonl"), "{\"seq\":0}\n{\"seq\":1}\n");
writeFileSync(join(sessionRoot, "traces", "tsk_b.jsonl"), "{\"seq\":0}\n");
writeFileSync(join(sessionRoot, "agt_1", "1", "home", "projects", "history.jsonl"), "provider\n");
writeFileSync(join(sessionRoot, "agt_1", "1", "home", "auth.json"), "SECRET");
mkdirSync(join(sessionRoot, ".multiremi"), { recursive: true });
writeFileSync(join(sessionRoot, ".multiremi", "gc.json"), "{}");

const issueRoot = join(storage, "issues", "MUL-1");
mkdirSync(issueRoot, { recursive: true });
const prepared = await prepareSessionArchive(issueRoot, {
  subject: { kind: "issue", id: "iss_1" },
  providerRoots: [{ sessionId: "ises_1", root: sessionRoot }],
  storageBoundary: storage,
});
console.log("path", prepared.archivePath);
console.log("revision", prepared.sourceRevision.slice(0, 12), "sha", prepared.sha256.slice(0, 12));
console.log("files", prepared.fileCount, "traces", prepared.traceCount);
console.log("manifest files", prepared.metadata.files.map((f) => f.path));

const handle = await open(prepared.archivePath, "r");
const dir = await readZipCentralDirectory(handle);
console.log("zip entries", dir.entries.map((e) => e.path));
const trace = dir.entries.find((e) => e.path === "traces/tsk_a.jsonl")!;
const m = await readZipMember(handle, { localHeaderOffset: trace.localHeaderOffset, compressedSize: trace.compressedSize, uncompressedSize: trace.uncompressedSize, sha256: trace.crc32 ? undefined : undefined });
console.log("trace bytes", m.bytes.toString().trim().replace("\n", "|"), "read", m.bytesRead, "compressed", trace.compressedSize);
await handle.close();
