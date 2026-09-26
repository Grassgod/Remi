#!/usr/bin/env bun
/**
 * MUL-388: disposable, local-only timing of `PUT /api/projects/:id/docs/:ref` against
 * a loopback fake OpenViking that can hang. Never points at a real OpenViking.
 *
 *   bun scripts/bench-openviking-deadline.ts <label> <hang: none|write|all> [timeoutMs] [maxRetries]
 *
 * Omitted timeout/retries leave the env unset, so the code defaults apply.
 * Prints one JSON line per run.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { createProjectKnowledgeServiceFromEnv } from "@multiremi/project-knowledge/service.js";
import { MultiremiStore } from "@multiremi/store.js";

const [label = "run", hang = "none", timeoutMs, maxRetries] = process.argv.slice(2);
if (!["none", "write", "all"].includes(hang)) throw new Error(`hang must be none|write|all, got ${hang}`);

const files = new Map<string, string>();
const calls: Record<string, number> = {};
let hanging = false;
let commits = 0;
const ok = (result: unknown) => Response.json({ status: "ok", result });
const notFound = () => Response.json({ status: "error", error: { code: "NOT_FOUND" } }, { status: 404 });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const op = `${request.method} ${url.pathname}`;
    const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json();
    if (hanging) calls[op] = (calls[op] ?? 0) + 1;
    if (hanging && (hang === "all" || op === "POST /api/v1/content/batch-write")) return new Promise<Response>(() => {});
    const uri = url.searchParams.get("uri") ?? "";
    switch (op) {
      case "POST /api/v1/fs/mkdir":
      case "POST /api/v1/content/set_tags":
        return ok({});
      case "POST /api/v1/search/find":
        return ok({ resources: [] });
      case "GET /api/v1/fs/stat":
        return files.has(uri) ? ok({ uri }) : notFound();
      case "GET /api/v1/content/read":
        return files.has(uri) ? ok(files.get(uri)) : notFound();
      case "DELETE /api/v1/fs":
        files.delete(uri);
        return ok({});
      case "POST /api/v1/snapshot/commit":
        return ok({ oid: `oid_${++commits}` });
      case "POST /api/v1/content/batch-write":
        for (const write of body.operations) {
          const current = files.get(write.uri);
          const allowed = write.precondition.kind === "create_if_absent"
            ? current === undefined
            : current !== undefined && write.precondition.base_hash === `sha256:${sha256(current)}`;
          if (!allowed) return Response.json({ status: "error", error: { code: "CONFLICT" } }, { status: 409 });
          files.set(write.uri, write.content);
        }
        return ok({});
      default:
        return Response.json({ status: "error", error: { message: `unexpected ${op}` } }, { status: 400 });
    }
  },
});

process.env.MULTIREMI_PROJECT_KNOWLEDGE_MODE = "openviking";
process.env.MULTIREMI_OPENVIKING_URL = `http://127.0.0.1:${server.port}`;
// The fake accepts any bearer value; this is a placeholder, not a credential.
process.env.MULTIREMI_OPENVIKING_API_KEY = "bench-placeholder";
if (timeoutMs) process.env.MULTIREMI_OPENVIKING_TIMEOUT_MS = timeoutMs;
if (maxRetries) process.env.MULTIREMI_OPENVIKING_MAX_RETRIES = maxRetries;

const store = new MultiremiStore(new Database(":memory:"));
const app = createMultiremiApp({ store, projectKnowledge: createProjectKnowledgeServiceFromEnv(store), backgroundJobs: false });
const project = store.createProject({ title: "MUL-388 bench" });
const headers = { "Content-Type": "application/json" };
const created = await app.request(`/api/projects/${project.id}/docs`, {
  method: "POST",
  headers,
  body: JSON.stringify({ kind: "wiki", title: "Runbook", body: "v1 body" }),
});
if (created.status !== 201) throw new Error(`seed create failed: ${created.status}`);
const doc = (await created.json()).doc;

hanging = hang !== "none";
const started = performance.now();
const response = await app.request(`/api/projects/${project.id}/docs/${doc.slug}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ body: "v2 body" }),
});
const elapsedMs = Math.round(performance.now() - started);
const responseBody = await response.json();
hanging = false;
const readBack = await app.request(`/api/projects/${project.id}/docs/${doc.slug}`);

console.log(JSON.stringify({
  label,
  hang,
  env: { timeoutMs: timeoutMs ?? "unset", maxRetries: maxRetries ?? "unset" },
  status: response.status,
  body: responseBody.error ? { error: responseBody.error, code: responseBody.code ?? null } : { version: responseBody.doc?.version },
  elapsedMs,
  openvikingCallsWhileHung: calls,
  readBack: { status: readBack.status, body: readBack.status === 200 ? (await readBack.json()).doc.body : null },
}));
server.stop(true);
process.exit(0);
