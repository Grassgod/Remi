// The issue-facing CLI an agent uses from inside a task: assignee refs, Go-style
// table output, attachment upload/download, the API calls daemon prompts document,
// the Session sub-commands, and canonical message range pagination.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";
import { buildIssueListQuery } from "../../../apps/remi/cli/multiremi/commands/issue.js";
import { cliCommandHelp } from "../../../apps/remi/cli/index.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { unifiedCommandSpecs } from "../../../apps/remi/cli/commands/unified.js";
import { tableHeaders } from "./helpers.js";

let tmp: string | null = null;

async function runConversationCli(args: string[]): Promise<void> {
  const registry = new CommandRegistry();
  for (const spec of unifiedCommandSpecs()) registry.register(spec);
  await registry.execute(args);
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi CLI — issues, attachments, and sessions", () => {
  test("issue list encodes --assignee-type as the plural compatibility parameter", () => {
    const query = new URLSearchParams(buildIssueListQuery({ "assignee-type": "member" }));
    expect(query.get("assignee_types")).toBe("member");
    expect(query.has("assignee_type")).toBe(false);
  });

  test("issue assign returns the same flat issue fields as get plus task and cancellation outcomes", async () => {
    const issue = { id: "iss_1", identifier: "MUL-1", title: "Assignment", assignee_id: null, assignee_type: null };
    let outcome: Record<string, unknown> = { task_id: null, cancelled_tasks: 2 };
    const requests: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (request.method === "GET") return Response.json(issue);
        requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() });
        return Response.json({ ...issue, ...outcome });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const options = ["--server", server.url.toString(), "--token", "fixture", "--output", "json"];
      await runMultiremi(["issue", "get", "MUL-1", ...options]);
      await runMultiremi(["issue", "assign", "MUL-1", "--unassign", ...options]);
      const fetched = JSON.parse(logs[0]);
      expect(JSON.parse(logs[1])).toEqual({ ...fetched, task_id: null, cancelled_tasks: 2 });
      expect(requests[0]).toEqual({ method: "PUT", path: "/api/issues/MUL-1", body: { assignee_type: null, assignee_id: null } });
      outcome = { task_id: "tsk_new", cancelled_tasks: 1 };
      await runMultiremi(["issue", "assign", "MUL-1", "--to", "Worker", ...options]);
      expect(JSON.parse(logs[2])).toEqual({ ...fetched, ...outcome });
      outcome = {};
      await runMultiremi(["issue", "assign", "MUL-1", "--unassign", ...options]);
      expect(JSON.parse(logs[3])).toEqual({ ...fetched, task_id: null, cancelled_tasks: 0 });
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("unassign help and usage explain cancellation of active issue tasks", async () => {
    expect(cliCommandHelp(["issue", "assign"])).toContain("Clear the assignee and cancel active tasks on this issue");
    await expect(runMultiremi(["issue", "assign"])).rejects.toThrow("--unassign clears the assignee and cancels active tasks on this issue");
  });

  test("issue assignee options can pass fuzzy refs without a type", async () => {
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const entry: { method: string; path: string; body?: any } = {
          method: request.method,
          path: `${url.pathname}${url.search}`,
        };
        if (request.method !== "GET" && request.method !== "DELETE") entry.body = await request.json();
        requests.push(entry);
        return Response.json({ id: "iss_1", ...entry.body });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const serverUrl = `http://127.0.0.1:${server.port}`;

      await runMultiremi(["issue", "assign", "MUL-1", "--server", serverUrl, "--token", "tok_cli", "--to", "Grace Hopper", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "list", "--server", serverUrl, "--token", "tok_cli", "--assignee", "Grace Hopper", "--output", "json"], { programName: "multiremi" });

      expect(requests.map((request) => request.path)).toEqual([
        "/api/issues/MUL-1",
        "/api/issues?assignee_id=Grace+Hopper",
      ]);
      expect(requests[0].body).toEqual({ assignee_id: "Grace Hopper" });
      expect(JSON.parse(logs[0])).toMatchObject({ assignee_id: "Grace Hopper" });
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("issue task steer posts steer/force-answer payloads and steers lists them", async () => {
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const entry: { method: string; path: string; body?: any } = { method: request.method, path: url.pathname };
        if (request.method === "POST") entry.body = await request.json();
        requests.push(entry);
        if (request.method === "GET") {
          return Response.json({ messages: [{ id: "steer_1", task_id: "tsk_1", kind: "steer", content: "改用中文", consumed_at: null }] });
        }
        return new Response(JSON.stringify({ message: { id: "steer_1", task_id: "tsk_1", ...entry.body } }), { status: 201 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const serverUrl = `http://127.0.0.1:${server.port}`;

      await runMultiremi(["issue", "task", "steer", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--content", "改用中文输出", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "task", "steer", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--force-answer", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "task", "steer", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--force-answer", "--content", "先给结论", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "task", "steers", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });

      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /api/tasks/tsk_1/steer",
        "POST /api/tasks/tsk_1/steer",
        "POST /api/tasks/tsk_1/steer",
        "GET /api/tasks/tsk_1/steer",
      ]);
      expect(requests[0].body).toEqual({ kind: "steer", content: "改用中文输出" });
      // --force-answer without content lets the server fill its default directive.
      expect(requests[1].body).toEqual({ kind: "force_answer" });
      expect(requests[2].body).toEqual({ kind: "force_answer", content: "先给结论" });
      expect(JSON.parse(logs[0]).message.kind).toBe("steer");
      expect(JSON.parse(logs[3]).messages[0].id).toBe("steer_1");

      // Plain steer without content must fail before any request is sent.
      await expect(
        runMultiremi(["issue", "task", "steer", "tsk_1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" }),
      ).rejects.toThrow(/--content/);
      expect(requests).toHaveLength(4);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("issue create warns loudly when the issue was created but not dispatched", async () => {
    let createResponse: Record<string, unknown> = {};
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/issues" && request.method === "POST") {
          await request.json();
          return new Response(JSON.stringify(createResponse), { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });
    const logs: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      console.error = (value?: unknown) => { warnings.push(String(value)); };
      const serverUrl = `http://127.0.0.1:${server.port}`;
      const create = (...extra: string[]) =>
        runMultiremi(["issue", "create", "--title", "Silent?", "--server", serverUrl, "--token", "tok_cli", "--output", "json", ...extra], { programName: "multiremi" });

      // No assignee fields at all: the server had the chance to backfill the
      // project default, so no_assignee confirms none is configured — warn with
      // the config hint.
      createResponse = { id: "iss_1", identifier: "MUL-9", task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "no_assignee" };
      await create("--project", "prj_1");
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ dispatch_status: "skipped", dispatch_skipped_reason: "no_assignee" });
      expect(warnings.join("\n")).toContain("NOT dispatched");
      expect(warnings.join("\n")).toContain("no assignee");
      expect(warnings.join("\n")).toContain("no default assignee");
      expect(warnings.join("\n")).toContain("issue assign MUL-9");

      // Explicit opt-out: the caller asked for no assignee, so the "project has
      // no default assignee" note would be misleading — warn without it.
      warnings.length = 0;
      createResponse = { id: "iss_1b", identifier: "MUL-9", task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "no_assignee" };
      await create("--project", "prj_1", "--no-project-defaults");
      expect(warnings.join("\n")).toContain("NOT dispatched");
      expect(warnings.join("\n")).not.toContain("no default assignee");

      // No runnable agent: warn with the server's error.
      warnings.length = 0;
      createResponse = {
        id: "iss_2",
        identifier: "MUL-10",
        task_id: null,
        dispatch_status: "skipped",
        dispatch_skipped_reason: "no_runnable_agent",
        dispatch_error: "No runnable agent for squad: sqd_1",
      };
      await create("--assignee", "sqd_1", "--assignee-type", "squad");
      expect(warnings.join("\n")).toContain("NOT dispatched");
      expect(warnings.join("\n")).toContain("No runnable agent for squad: sqd_1");

      // Dispatched: no warning at all.
      warnings.length = 0;
      createResponse = { id: "iss_3", identifier: "MUL-11", task_id: "tsk_1", dispatch_status: "dispatched", dispatch_skipped_reason: null };
      await create("--assignee", "agt_1", "--assignee-type", "agent");
      expect(warnings.join("\n")).not.toContain("NOT dispatched");

      // Member assignee: expected outcome, no warning.
      warnings.length = 0;
      createResponse = { id: "iss_4", identifier: "MUL-12", task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "member_assignee" };
      await create("--assignee", "mem_1", "--assignee-type", "member");
      expect(warnings.join("\n")).not.toContain("NOT dispatched");

      // Backlog is a parking lot: skipped on purpose, no warning.
      warnings.length = 0;
      createResponse = { id: "iss_5", identifier: "MUL-13", task_id: null, dispatch_status: "skipped", dispatch_skipped_reason: "backlog_status" };
      await create("--status", "backlog", "--assignee", "agt_1", "--assignee-type", "agent");
      expect(warnings.join("\n")).not.toContain("NOT dispatched");

      // Generic assignment failure: warn with the server's error message.
      warnings.length = 0;
      createResponse = {
        id: "iss_6",
        identifier: "MUL-14",
        task_id: null,
        dispatch_status: "skipped",
        dispatch_skipped_reason: "assign_failed",
        dispatch_error: "Simulated dispatch outage",
      };
      await create("--assignee", "agt_1", "--assignee-type", "agent");
      expect(warnings.join("\n")).toContain("NOT dispatched");
      expect(warnings.join("\n")).toContain("Simulated dispatch outage");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      server.stop(true);
    }
  });

  test("issue create prepares and commits a bound topic through the local daemon", async () => {
    const events: string[] = [];
    const localDaemon = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          events.push("health");
          return Response.json({ status: "running", mode: "serving" });
        }
        if (url.pathname === "/topic/migrate") {
          const body = await request.json() as Record<string, unknown>;
          events.push(String(body.action));
          if (body.action === "prepare") {
            return Response.json({
              bound: true,
              migration_id: "mig_1",
              state: "prepared",
              topic_id: "om_1",
              session_key: "chat:thread:om_1",
              topic_cwd: "/workspaces/_topics/om_1",
            });
          }
          return Response.json({
            migrated: true,
            issue_id: body.issue_id,
            issue_key: body.issue_key,
            path: "/workspaces/MUL-301",
            session_key: "chat:thread:om_1",
            topic_id: "om_1",
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    let created = 0;
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/issues" && request.method === "POST") {
          events.push("create");
          created++;
          return Response.json({ id: `iss_${created}`, identifier: `MUL-${300 + created}`, title: "Topic issue" }, { status: 201 });
        }
        if (path === "/api/issues/MUL-301" && request.method === "GET") {
          events.push("get");
          return Response.json({ id: "iss_1", identifier: "MUL-301", title: "Topic issue" });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      console.error = (value?: unknown) => { errors.push(String(value)); };
      const common = [
        "--server", `http://127.0.0.1:${api.port}`,
        "--token", "tok_cli",
        "--daemon-port", String(localDaemon.port),
        "--output", "json",
      ];
      await runMultiremi(["issue", "create", "--title", "Topic issue", ...common], { programName: "multiremi" });
      expect(events).toEqual(["health", "prepare", "create", "commit"]);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        id: "iss_1",
        topic_migration: { migrated: true, path: "/workspaces/MUL-301" },
      });
      expect(errors).toContain("Topic migrated to /workspaces/MUL-301");

      events.length = 0;
      await runMultiremi(["issue", "create", "--title", "Detached issue", "--no-bind-topic", ...common], { programName: "multiremi" });
      expect(events).toEqual(["create"]);

      events.length = 0;
      await runMultiremi(["issue", "bind-topic", "MUL-301", ...common], { programName: "multiremi" });
      expect(events).toEqual(["health", "get", "resume"]);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        issue_key: "MUL-301",
        topic_migration: { migrated: true, path: "/workspaces/MUL-301" },
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      localDaemon.stop(true);
      api.stop(true);
    }
  });

  test("issue read commands keep table output and retired run commands send nothing", async () => {
    const requests: string[] = [], logs: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname; requests.push(path);
      return Response.json(path.endsWith("/subscribers") ? [{ member_id: "mem_1", reason: "manual", created_at: "2026-06-21T10:32:00.000Z" }]
        : { issues: [{ identifier: "MUL-1", title: "Fix checkout cache", status: "todo", priority: "high",
          assignee_id: "agt_codex", assignee_type: "agent", start_date: "2026-06-20", due_date: "2026-06-22",
          match_source: "title", matched_snippet: "checkout cache" }], total: 1 });
    } });
    const original = console.log;
    try {
      console.log = value => { logs.push(String(value)); };
      const connection = ["--server", server.url.toString(), "--token", "fixture"];
      await runMultiremi(["issue", "list", ...connection]);
      await runMultiremi(["issue", "search", "Checkout", ...connection]);
      await runMultiremi(["issue", "subscriber", "list", "MUL-1", ...connection]);
      await runMultiremi(["issue", "list", ...connection, "--output", "json"]);
      expect(tableHeaders(logs[0])).toEqual(["KEY", "TITLE", "STATUS", "PRIORITY", "ASSIGNEE", "START DATE", "DUE DATE"]);
      expect(tableHeaders(logs[1])).toEqual(["KEY", "TITLE", "STATUS", "MATCH"]);
      expect(tableHeaders(logs[2])).toEqual(["USER", "REASON", "CREATED"]);
      expect(logs[0]).toContain("MUL-1");
      expect(logs[0]).toContain("agent:agt_codex");
      expect(logs[0]).toContain("2026-06-20");
      expect(logs[0]).toContain("2026-06-22");
      expect(logs[1]).toContain("title: checkout cache");
      expect(logs[2]).toContain("mem_1");
      expect(JSON.parse(logs[3]).issues[0].title).toBe("Fix checkout cache");
      const before = [...requests];
      for (const argv of [["issue", "runs", "MUL-1"], ["issue", "run-messages", "tsk_1"], ["issue", "comment", "list", "MUL-1"]]) {
        await expect(runMultiremi([...argv, ...connection])).rejects.toThrow("已移除");
      }
      expect(requests).toEqual(before);
    } finally { console.log = original; server.stop(true); }
  });

  test("issue attachments upload and canonical message attachments preserve their bytes", async () => {
    tmp = mkdtempSync(join(tmpdir(), "conversation-cli-attachments-"));
    const path = join(tmp, "report.txt"); writeFileSync(path, "report bytes");
    const secondPath = join(tmp, "second.txt"); writeFileSync(secondPath, "second bytes");
    const uploads: Array<{ path: string; body: unknown; files: Array<{ name: string; text: string }> }> = [];
    const authorizations: Array<string | null> = [], logs: string[] = [], errors: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      authorizations.push(request.headers.get("authorization"));
      if (url.pathname === "/api/cli/capabilities") return Response.json({ commands: [{ id: "message.send", allowed: true }] });
      if (url.pathname === "/api/upload-file") {
        const form = await request.formData(); const file = form.get("file") as File;
        uploads.push({ path: url.pathname, body: form.get("issue_id"), files: [{ name: file.name, text: await file.text() }] });
        return Response.json({ id: "att_1", filename: file.name });
      }
      if (url.pathname === "/api/issues") return Response.json({ id: "iss_created", ...await request.json() }, { status: 201 });
      if (url.pathname === "/api/sessions/ises_1/messages") {
        const form = await request.formData();
        const files = await Promise.all((form.getAll("file") as File[]).map(async file => ({ name: file.name, text: await file.text() })));
        uploads.push({ path: url.pathname, body: JSON.parse(String(form.get("message"))), files });
        return Response.json({ message: { id: "msg_1" }, wake_applied: "inbox_only", wake_reason: "requested_inbox_only" });
      }
      if (url.pathname === "/api/attachments/att_1") return Response.json({ id: "att_1", filename: "report.txt", download_url: "/api/attachments/att_1/download" });
      if (url.pathname.endsWith("/download")) return new Response("report bytes");
      return Response.json({ error: "not found" }, { status: 404 });
    } });
    const original = console.log, originalError = console.error;
    console.log = value => { logs.push(String(value)); };
    console.error = value => { errors.push(String(value)); };
    try {
      const connection = ["--server", server.url.toString(), "--token", "fixture", "--output", "json"];
      await runMultiremi(["issue", "create", "--title", "Report", "--attachment", path, ...connection]);
      await runConversationCli(["message", "send", "ises_1", "--kind", "report", "--wake", "inbox_only", "--content", "Report", "--attachment", path, "--attachment", secondPath, ...connection]);
      const output = join(tmp, "downloads", "renamed.txt");
      await expect(runMultiremi(["attachment", "download", "att_1", "-o", output]))
        .rejects.toThrow("usage: remi attachment download <attachment-id> [--output <file> | --output-dir <dir>]");
      const outputDir = join(tmp, "missing", "downloads");
      await runMultiremi(["attachment", "download", "att_1", "--output-dir", outputDir, "--server", server.url.toString(), "--token", "fixture"]);
      await runMultiremi(["attachment", "download", "att_1", "--output", output, "--server", server.url.toString(), "--token", "fixture"]);
      expect(uploads).toEqual([
        { path: "/api/upload-file", body: "iss_created", files: [{ name: "report.txt", text: "report bytes" }] },
        { path: "/api/sessions/ises_1/messages", body: { body_md: "Report", message_kind: "report", wake_requested: "inbox_only", to: { type: "none" }, reply_to_id: null, dedupe_key: null }, files: [{ name: "report.txt", text: "report bytes" }, { name: "second.txt", text: "second bytes" }] },
      ]);
      expect(authorizations.every(value => value === "Bearer fixture")).toBe(true);
      expect(errors).toContain(`Uploaded ${path}`);
      expect(readFileSync(join(outputDir, "report.txt"), "utf8")).toBe("report bytes");
      expect(readFileSync(output, "utf8")).toBe("report bytes");
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ id: "att_1", filename: "renamed.txt", path: output });
      const before = uploads.length;
      await expect(runConversationCli(["message", "send", "ises_1", "--attachment", "https://example.test/image.png", ...connection]))
        .rejects.toThrow("--attachment requires a local file path");
      expect(uploads).toHaveLength(before);
    } finally { console.log = original; console.error = originalError; server.stop(true); }
  });

  test("Issue resources and canonical message commands call the API used by daemon prompts", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [], logs: string[] = [];
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      authorizations.push(request.headers.get("authorization"));
      if (path === "/api/cli/capabilities") return Response.json({ commands: ["message.list", "message.send", "message.edit", "message.delete", "message.resolve"].map(id => ({ id, allowed: true })) });
      const body = ["GET", "DELETE"].includes(request.method) ? null : await request.json();
      requests.push({ method: request.method, path: `${path}${url.search}`, body });
      if (path.endsWith("/metadata")) return Response.json({ attempts: 2, ready: true });
      if (path.endsWith("/metadata/attempts")) return Response.json(request.method === "DELETE" ? { ready: true } : { attempts: 3, ready: true });
      if (path.endsWith("/subscribers")) return Response.json([{ id: "sub_1", member_id: "mem_1" }]);
      if (path.endsWith("/subscribe") || path.endsWith("/unsubscribe")) return Response.json({ subscribed: path.endsWith("/subscribe"), member_id: "mem_1" });
      if (path === "/api/issues" || path === "/api/issues/search") return Response.json(request.method === "GET"
        ? { issues: [{ id: "iss_1", title: "Issue one", match_source: "title" }], total: 1 }
        : { id: "iss_created", ...body });
      if (path === "/api/issues/iss_delete") return Response.json({ deleted: true });
      if (path === "/api/issues/iss_1") return Response.json({ id: "iss_1", title: "Issue one", ...body });
      return Response.json(path.endsWith("/messages") && request.method === "GET"
        ? { messages: [{ id: "msg_1", body_md: "Root" }], next_cursor: null }
        : { message: { id: "msg_1" }, wake_applied: "inbox_only", wake_reason: "requested_inbox_only" });
    } });
    const original = console.log; console.log = value => { logs.push(String(value)); };
    try {
      const connection = ["--server", server.url.toString(), "--token", "fixture", "--output", "json"];
      await runMultiremi(["issue", "list", "--status", "todo", "--project", "prj_1", "--limit", "2", "--offset", "1", "--metadata", "ready=true", ...connection]);
      await runMultiremi(["issue", "get", "iss_1", ...connection]);
      await runMultiremi(["issue", "create", "--title", "Created", "--description", "Body", "--status", "todo", "--priority", "high", "--assignee-type", "agent", "--assignee", "agt_1", "--project", "prj_1", ...connection]);
      await runMultiremi(["issue", "update", "iss_1", "--title", "Updated", "--project=", ...connection]);
      await runMultiremi(["issue", "assign", "iss_1", "--to", "mem_1", "--type", "member", ...connection]);
      await runMultiremi(["issue", "status", "iss_1", "in_review", ...connection]);
      for (const name of ["list", "get", "set", "delete"]) {
        await runMultiremi(["issue", "metadata", name, "iss_1", ...(name === "list" ? [] : ["--key", "attempts"]), ...(name === "set" ? ["--value", "3"] : []), ...connection]);
      }
      await runMultiremi(["issue", "subscriber", "list", "iss_1", ...connection]);
      await runMultiremi(["issue", "subscriber", "add", "iss_1", "--user-id", "mem_1", ...connection]);
      await runMultiremi(["issue", "subscriber", "remove", "iss_1", "--user-id", "mem_1", ...connection]);
      await runMultiremi(["issue", "search", "Issue", "--limit", "5", "--include-closed", ...connection]);
      await runMultiremi(["issue", "delete", "iss_delete", ...connection]);
      expect(logs.map(value => JSON.parse(value))).toEqual([
        { issues: [{ id: "iss_1", title: "Issue one", match_source: "title" }], total: 1 },
        { id: "iss_1", title: "Issue one" },
        { id: "iss_created", title: "Created", description: "Body", status: "todo", priority: "high", assignee_type: "agent", assignee_id: "agt_1", project_id: "prj_1" },
        { id: "iss_1", title: "Updated", project_id: null },
        { id: "iss_1", title: "Issue one", assignee_type: "member", assignee_id: "mem_1", task_id: null, cancelled_tasks: 0 },
        { id: "iss_1", title: "Issue one", status: "in_review" },
        { attempts: 2, ready: true }, 2, { attempts: 3, ready: true }, { ready: true },
        [{ id: "sub_1", member_id: "mem_1" }], { subscribed: true, member_id: "mem_1" }, { subscribed: false, member_id: "mem_1" },
        { issues: [{ id: "iss_1", title: "Issue one", match_source: "title" }], total: 1 }, { deleted: true },
      ]);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/issues?status=todo&project_id=prj_1&limit=2&offset=1&metadata=%7B%22ready%22%3Atrue%7D",
        "GET /api/issues/iss_1", "POST /api/issues", "PUT /api/issues/iss_1", "PUT /api/issues/iss_1", "PUT /api/issues/iss_1",
        "GET /api/issues/iss_1/metadata", "GET /api/issues/iss_1/metadata", "PUT /api/issues/iss_1/metadata/attempts", "DELETE /api/issues/iss_1/metadata/attempts",
        "GET /api/issues/iss_1/subscribers", "POST /api/issues/iss_1/subscribe", "POST /api/issues/iss_1/unsubscribe",
        "GET /api/issues/search?q=Issue&limit=5&include_closed=true", "DELETE /api/issues/iss_delete",
      ]);
      expect(requests[2].body).toEqual({ title: "Created", description: "Body", status: "todo", priority: "high", assignee_type: "agent", assignee_id: "agt_1", project_id: "prj_1" });
      expect(requests[3].body).toEqual({ title: "Updated", project_id: null });
      expect(requests[4].body).toEqual({ assignee_type: "member", assignee_id: "mem_1" });
      expect(requests[8].body).toEqual({ value: 3 });
      expect(requests[11].body).toEqual({ member_id: "mem_1" });
      expect(requests[12].body).toEqual({ member_id: "mem_1" });
      requests.length = 0;
      await runConversationCli(["message", "list", "ises_1", "--thread", "msg_root", ...connection]);
      await runConversationCli(["message", "send", "ises_1", "--kind", "reply", "--reply-to", "msg_root", "--to", "agt_1", "--content", "Reply", ...connection]);
      await runConversationCli(["message", "edit", "msg_1", "--content", "Edited", ...connection]);
      await runConversationCli(["message", "resolve", "msg_1", ...connection]);
      await runConversationCli(["message", "resolve", "msg_1", "--no-resolved", ...connection]);
      await runConversationCli(["message", "delete", "msg_1", "--yes", ...connection]);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/sessions/ises_1/messages?thread=msg_root", "POST /api/sessions/ises_1/messages", "PATCH /api/messages/msg_1",
        "POST /api/messages/msg_1/resolve", "POST /api/messages/msg_1/resolve", "DELETE /api/messages/msg_1",
      ]);
      expect(requests[1].body).toEqual({ body_md: "Reply", message_kind: "reply", wake_requested: "now", reply_to_id: "msg_root", to: { type: "agent", ref: "agt_1" }, dedupe_key: null });
      expect(requests[2].body).toEqual({ body_md: "Edited" });
      expect(requests.slice(3, 5).map(r => r.body)).toEqual([{ resolved: true }, { resolved: false }]);
      expect(authorizations.every(value => value === "Bearer fixture")).toBe(true);
    } finally { console.log = original; server.stop(true); }
  });

  test("issue Session CLI lists Sessions and publishes explicit reusable results", async () => {
    const requests: Array<{
      method: string;
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json() as Record<string, unknown>
          : {};
        requests.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          body,
        });
        if (url.pathname === "/api/issues/iss_1/sessions") {
          return Response.json([{
            id: "sess_main",
            title: "Main",
            status: "active",
            is_default: true,
            participants: [],
          }]);
        }
        if (url.pathname === "/api/issues/iss_1/session-results") {
          return Response.json([{
            id: "sres_1",
            source_session_id: "sess_main",
            title: "Decision",
            body: "Use canonical events.",
            created_at: "2026-07-27T00:00:00.000Z",
          }]);
        }
        if (url.pathname === "/api/issues/iss_1/sessions/sess_main/results" && request.method === "POST") {
          return Response.json({
            id: "sres_2",
            source_session_id: "sess_main",
            ...body,
          }, { status: 201 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const connection = ["--server", `http://127.0.0.1:${server.port}`, "--token", "tok_cli", "--output", "json"];
      await runMultiremi(["issue", "session", "list", "iss_1", ...connection], { programName: "multiremi" });
      await runMultiremi(["issue", "session", "result", "list", "iss_1", "--session", "sess_main", ...connection], { programName: "multiremi" });
      await runMultiremi([
        "issue",
        "session",
        "result",
        "publish",
        "iss_1",
        "--session",
        "sess_main",
        "--title",
        "API contract",
        "--content",
        "Share results, not raw transcripts.",
        ...connection,
      ], { programName: "multiremi" });

      expect(JSON.parse(logs[0])[0]).toMatchObject({ id: "sess_main", title: "Main" });
      expect(JSON.parse(logs[1])[0]).toMatchObject({ id: "sres_1", source_session_id: "sess_main" });
      expect(JSON.parse(logs[2])).toMatchObject({
        id: "sres_2",
        title: "API contract",
        body: "Share results, not raw transcripts.",
      });
      expect(requests).toEqual([
        { method: "GET", path: "/api/issues/iss_1/sessions", body: {} },
        { method: "GET", path: "/api/issues/iss_1/session-results", body: {} },
        {
          method: "POST",
          path: "/api/issues/iss_1/sessions/sess_main/results",
          body: {
            title: "API contract",
            body: "Share results, not raw transcripts.",
          },
        },
      ]);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("issue Session result publish maps --type and --ref into result metadata", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/issues/iss_1/sessions/sess_main/results" && request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          bodies.push(body);
          return Response.json({ id: "sres_3", ...body }, { status: 201 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const originalLog = console.log;
    try {
      console.log = () => {};
      const connection = ["--server", `http://127.0.0.1:${server.port}`, "--token", "tok_cli", "--output", "json"];
      const publish = ["issue", "session", "result", "publish", "iss_1", "--session", "sess_main"];

      await runMultiremi([
        ...publish,
        "--title", "Merged the projection fix",
        "--type", "mr",
        "--ref", "issue:MUL-12",
        "--ref", "https://example.test/mr/12",
        "--content", "Landed on main.",
        ...connection,
      ], { programName: "multiremi" });

      // Neither flag given: the body stays exactly as before this feature —
      // no empty metadata bag pushed at the server.
      await runMultiremi([
        ...publish,
        "--content", "Plain result.",
        ...connection,
      ], { programName: "multiremi" });

      expect(bodies).toEqual([
        {
          title: "Merged the projection fix",
          body: "Landed on main.",
          metadata: {
            kind: "mr",
            refs: [
              { type: "issue", value: "MUL-12" },
              { type: "url", value: "https://example.test/mr/12" },
            ],
          },
        },
        { title: "", body: "Plain result." },
      ]);

      // An unknown kind is rejected client-side, listing the valid kinds.
      await expect(runMultiremi([
        ...publish,
        "--type", "merge-request",
        "--content", "Rejected before it reaches the server.",
        ...connection,
      ], { programName: "multiremi" })).rejects.toThrow(
        '--type "merge-request" must be one of mr, report, deploy, decision, doc, other',
      );
      // A malformed --ref keeps the shared project-doc parser's message.
      await expect(runMultiremi([
        ...publish,
        "--ref", "MUL-12",
        "--content", "Rejected before it reaches the server.",
        ...connection,
      ], { programName: "multiremi" })).rejects.toThrow('--ref "MUL-12" must be <type>:<value>');
      expect(bodies).toHaveLength(2);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("canonical message range follows cursor pages and joins split bodies", async () => {
    let count = 0; const logs: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/cli/capabilities") return Response.json({ commands: [{ id: "message.list", allowed: true }] });
      expect(url.pathname).toBe("/api/sessions/ises_1/messages");
      expect(url.searchParams.get("from")).toBe("0"); expect(url.searchParams.get("to")).toBe("2");
      count++;
      expect(url.searchParams.get("cursor")).toBe(count === 1 ? null : "page2");
      return Response.json(count === 1 ? { entries: [{ id: "msg_1", seq: 1, body_md: "first ", body_offset: 0, body_omitted_chars: 4 }], next_cursor: "page2" }
        : { entries: [{ id: "msg_1", seq: 1, body_md: "body", body_offset: 6, body_omitted_chars: 0 }, { id: "msg_2", seq: 2, body_md: "last" }], next_cursor: null });
    } });
    const original = console.log;
    try {
      console.log = value => { logs.push(String(value)); };
      await runConversationCli(["message", "list", "ises_1", "--from", "0", "--to", "2", "--server", server.url.toString(), "--token", "fixture", "--output", "json"]);
      expect(count).toBe(2);
      expect(JSON.parse(logs[0]).map((entry: { body_md: string }) => entry.body_md)).toEqual(["first body", "last"]);
    } finally { console.log = original; server.stop(true); }
  });
});
