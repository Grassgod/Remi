// The issue-facing CLI an agent uses from inside a task: assignee refs, Go-style
// table output, attachment upload/download, the API calls daemon prompts document,
// the Session sub-commands, and the legacy cursor-header fallback.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";
import { tableHeaders } from "./helpers.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi CLI — issues, attachments, and sessions", () => {
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

      // A Chat that is already bound is never silently switched to the newly
      // created Issue; the structured response remains on stdout and the
      // operator gets the server-authored switch hint on stderr.
      warnings.length = 0;
      createResponse = {
        id: "iss_5b",
        identifier: "MUL-13B",
        task_id: null,
        dispatch_status: "skipped",
        dispatch_skipped_reason: "backlog_status",
        chat_issue_binding_hint: "Chat chat_1 remains bound to MUL-12; MUL-13B was not auto-bound.",
      };
      await create("--status", "backlog", "--assignee", "agt_1", "--assignee-type", "agent");
      expect(warnings).toContain("Chat chat_1 remains bound to MUL-12; MUL-13B was not auto-bound.");

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

  test("issue read commands default to Go-style table output", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/issues" && request.method === "GET") {
          return Response.json({
            issues: [{
              id: "iss_1",
              key: "MUL-1",
              title: "Fix checkout cache",
              status: "todo",
              priority: "high",
              assignee_type: "agent",
              assignee_id: "agt_codex",
              start_date: "2026-06-20",
              due_date: "2026-06-22",
            }],
            total: 1,
          });
        }
        if (url.pathname === "/api/issues/search" && request.method === "GET") {
          return Response.json({
            issues: [{ id: "iss_1", identifier: "MUL-1", title: "Fix checkout cache", status: "todo", priority: "high", match_source: "title", matched_snippet: "checkout cache" }],
            total: 1,
          });
        }
        if (url.pathname === "/api/issues/MUL-1/task-runs" && request.method === "GET") {
          return Response.json([{ id: "tsk_1234567890abcdef", status: "completed", agent_id: "agt_codex", started_at: "2026-06-21T10:30:00.000Z", completed_at: "2026-06-21T10:31:00.000Z", error: "" }]);
        }
        if (url.pathname === "/api/tasks/tsk_1/messages" && request.method === "GET") {
          return Response.json([{ seq: 2, type: "tool_result", tool: "Bash", content: "done" }]);
        }
        if (url.pathname === "/api/issues/MUL-1/comments" && request.method === "GET") {
          return Response.json([{ id: "c_1", parent_id: null, author_type: "member", author_id: "mem_1", type: "comment", created_at: "2026-06-21T10:31:00.000Z", content: "Looks good" }]);
        }
        if (url.pathname === "/api/issues/MUL-1/subscribers" && request.method === "GET") {
          return Response.json([{ id: "sub_1", user_type: "member", user_id: "mem_1", reason: "manual", created_at: "2026-06-21T10:32:00.000Z" }]);
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const serverUrl = `http://127.0.0.1:${server.port}`;

      await runMultiremi(["issue", "list", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "search", "checkout", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "runs", "MUL-1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "run-messages", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--output", "table"], { programName: "multiremi" });
      await runMultiremi(["issue", "comment", "list", "MUL-1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "subscriber", "list", "MUL-1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "list", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });

      expect(tableHeaders(logs[0])).toEqual(["KEY", "TITLE", "STATUS", "PRIORITY", "ASSIGNEE", "START DATE", "DUE DATE"]);
      expect(logs[0]).toContain("MUL-1");
      expect(logs[0]).toContain("agent:agt_codex");
      expect(logs[0]).toContain("2026-06-20");
      expect(tableHeaders(logs[1])).toEqual(["KEY", "TITLE", "STATUS", "MATCH"]);
      expect(logs[1]).toContain("title: checkout cache");
      expect(tableHeaders(logs[2])).toEqual(["ID", "AGENT", "STATUS", "PROGRESS", "STARTED", "COMPLETED", "ERROR"]);
      expect(logs[2]).toContain("tsk_1234567");
      expect(tableHeaders(logs[3])).toEqual(["SEQ", "TYPE", "TOOL", "CONTENT"]);
      expect(logs[3]).toContain("Bash");
      expect(logs[3]).toContain("done");
      expect(tableHeaders(logs[4])).toEqual(["ID", "PARENT", "AUTHOR", "TYPE", "CONTENT", "CREATED"]);
      expect(logs[4]).toContain("Looks good");
      expect(tableHeaders(logs[5])).toEqual(["USER", "REASON", "CREATED"]);
      expect(logs[5]).toContain("mem_1");
      expect(JSON.parse(logs[6]).issues[0].title).toBe("Fix checkout cache");
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("issue attachment flags upload files and attachment download saves content", async () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-cli-attachments-"));
    const issueAttachment = join(tmp, "issue-note.txt");
    const commentAttachmentA = join(tmp, "comment-a.txt");
    const commentAttachmentB = join(tmp, "comment-b.txt");
    writeFileSync(issueAttachment, "issue file", "utf8");
    writeFileSync(commentAttachmentA, "comment a", "utf8");
    writeFileSync(commentAttachmentB, "comment b", "utf8");

    const uploads: Array<{ issueId: string | null; filename: string; text: string; authorization: string | null }> = [];
    const jsonRequests: Array<{ method: string; path: string; body?: any }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/upload-file" && request.method === "POST") {
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return Response.json({ error: "missing file" }, { status: 400 });
          const id = `att_${uploads.length + 1}`;
          uploads.push({
            issueId: String(form.get("issue_id") ?? ""),
            filename: file.name,
            text: await file.text(),
            authorization: request.headers.get("authorization"),
          });
          return Response.json({
            id,
            filename: file.name,
            url: `/api/attachments/${id}/content`,
            download_url: `/api/attachments/${id}/download`,
            size_bytes: file.size,
          });
        }

        if (url.pathname === "/api/issues" && request.method === "POST") {
          const body = await request.json();
          jsonRequests.push({ method: request.method, path: url.pathname, body });
          return Response.json({ id: "iss_created", ...body }, { status: 201 });
        }
        if (url.pathname === "/api/issues/MUL-1/comments" && request.method === "POST") {
          const body = await request.json();
          jsonRequests.push({ method: request.method, path: url.pathname, body });
          return Response.json({ id: "c_added", ...body }, { status: 201 });
        }
        if (url.pathname === "/api/attachments/att_1" && request.method === "GET") {
          return Response.json({
            id: "att_1",
            filename: "download.txt",
            download_url: "/api/attachments/att_1/download",
            size_bytes: 10,
          });
        }
        if (url.pathname === "/api/attachments/att_1/download" && request.method === "GET") {
          return new Response("downloaded!", { headers: { "Content-Type": "text/plain" } });
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
      const serverUrl = `http://127.0.0.1:${server.port}`;

      await runMultiremi(["issue", "create", "--server", serverUrl, "--token", "tok_cli", "--workspace", "ws_cli", "--title", "Created", "--attachment", issueAttachment], { programName: "multiremi" });
      await runMultiremi([
        "issue",
        "comment",
        "add",
        "MUL-1",
        "--server",
        serverUrl,
        "--token",
        "tok_cli",
        "--workspace",
        "ws_cli",
        "--content",
        "Reply",
        "--attachment",
        "https://example.test/image.png",
        "--attachment",
        commentAttachmentA,
        "--attachment",
        commentAttachmentB,
      ], { programName: "multiremi" });
      const missingOutputDir = join(tmp, "missing", "downloads");
      const exactOutput = join(tmp, "renamed", "custom-name.bin");
      await expect(runMultiremi([
        "attachment",
        "download",
        "att_1",
        "-o",
        exactOutput,
      ], { programName: "multiremi" })).rejects.toThrow(
        "usage: remi attachment download <attachment-id> [--output <file> | --output-dir <dir>]",
      );
      await runMultiremi(["attachment", "download", "att_1", "--server", serverUrl, "--token", "tok_cli", "--output-dir", missingOutputDir], { programName: "multiremi" });
      await runMultiremi(["attachment", "download", "att_1", "--server", serverUrl, "--token", "tok_cli", "--output", exactOutput], { programName: "multiremi" });

      expect(uploads.map((upload) => [upload.issueId, upload.filename, upload.text])).toEqual([
        ["iss_created", "issue-note.txt", "issue file"],
        ["MUL-1", "comment-a.txt", "comment a"],
        ["MUL-1", "comment-b.txt", "comment b"],
      ]);
      expect(uploads.every((upload) => upload.authorization === "Bearer tok_cli")).toBe(true);
      expect(jsonRequests[0]).toMatchObject({ method: "POST", path: "/api/issues", body: { title: "Created" } });
      expect(jsonRequests[1]).toMatchObject({
        method: "POST",
        path: "/api/issues/MUL-1/comments",
        body: { content: "Reply", parent_id: null, attachment_ids: ["att_2", "att_3"] },
      });
      expect(errors).toContain(`Uploaded ${issueAttachment}`);
      expect(errors).toContain(`Uploaded ${commentAttachmentA}`);
      expect(errors).toContain(`Uploaded ${commentAttachmentB}`);
      expect(errors.some((line) => line.includes("URLs are not supported"))).toBe(true);
      expect(readFileSync(join(missingOutputDir, "download.txt"), "utf8")).toBe("downloaded!");
      expect(readFileSync(exactOutput, "utf8")).toBe("downloaded!");
      expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({ id: "att_1", filename: "custom-name.bin", path: exactOutput });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      server.stop(true);
    }
  });

  test("issue commands call the Multiremi API used by daemon prompts", async () => {
    const requests: Array<{ method: string; path: string; authorization: string | null; body?: any }> = [];
    const comments = [
      { id: "c_root", parentId: null, body: "Root", createdAt: "2024-12-31T00:00:00.000Z" },
      { id: "c_new", parentId: "c_root", body: "New reply", createdAt: "2025-01-01T00:00:01.000Z" },
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const entry: { method: string; path: string; authorization: string | null; body?: any } = {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("authorization"),
        };
        if (request.method !== "GET" && request.method !== "DELETE") entry.body = await request.json();
        requests.push(entry);
        if (url.pathname === "/api/issues" && request.method === "GET") {
          return Response.json({ issues: [{ id: "iss_1", title: "Issue one" }], total: 1 });
        }
        if (url.pathname === "/api/issues/search" && request.method === "GET") {
          return Response.json({ issues: [{ id: "iss_1", title: "Issue one", match_source: "title" }], total: 1 });
        }
        if (url.pathname === "/api/issues" && request.method === "POST") {
          return Response.json({ id: "iss_created", ...entry.body }, { status: 201 });
        }
        if (url.pathname === "/api/issues/iss_1" && request.method === "GET") {
          return Response.json({ id: "iss_1", title: "Issue one" });
        }
        if (url.pathname === "/api/issues/iss_1" && request.method === "PUT") {
          return Response.json({ id: "iss_1", title: entry.body.title ?? "Issue one", ...entry.body });
        }
        if (url.pathname === "/api/issues/iss_delete" && request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/issues/iss_1/comments" && request.method === "GET") {
          return Response.json(comments, {
            headers: {
              "X-Multiremi-Next-Before": "2025-01-01T00:00:01.000Z",
              "X-Multiremi-Next-Before-Id": "c_new",
            },
          });
        }
        if (url.pathname === "/api/issues/iss_1/comments" && request.method === "POST") {
          return Response.json({ id: "c_added", ...entry.body }, { status: 201 });
        }
        if (url.pathname === "/api/comments/c_new" && request.method === "PUT") {
          return Response.json({ comment: { id: "c_new", ...entry.body } });
        }
        if (url.pathname === "/api/comments/c_new" && request.method === "DELETE") {
          return Response.json({ ok: true });
        }
        if (url.pathname === "/api/comments/c_new/resolve" && request.method === "POST") {
          return Response.json({ comment: { id: "c_new", resolved_at: "2025-01-01T00:00:02.000Z", ...entry.body } });
        }
        if (url.pathname === "/api/comments/c_new/resolve" && request.method === "DELETE") {
          return Response.json({ comment: { id: "c_new", resolved_at: null } });
        }
        if (url.pathname === "/api/issues/iss_1/metadata" && request.method === "GET") {
          return Response.json({ attempts: 2, ready: true });
        }
        if (url.pathname === "/api/issues/iss_1/metadata/attempts" && request.method === "PUT") {
          return Response.json({ attempts: entry.body.value, ready: true });
        }
        if (url.pathname === "/api/issues/iss_1/metadata/attempts" && request.method === "DELETE") {
          return Response.json({ ready: true });
        }
        if (url.pathname === "/api/issues/iss_1/subscribers" && request.method === "GET") {
          return Response.json([{ id: "sub_1", member_id: "mem_1", reason: "manual" }]);
        }
        if (url.pathname === "/api/issues/iss_1/subscribe" && request.method === "POST") {
          return Response.json({ subscribed: true, ...entry.body });
        }
        if (url.pathname === "/api/issues/iss_1/unsubscribe" && request.method === "POST") {
          return Response.json({ subscribed: false, ...entry.body });
        }
        if (url.pathname === "/api/issues/iss_1/task-runs" && request.method === "GET") {
          return Response.json([{ id: "tsk_1", status: "completed" }]);
        }
        if (url.pathname === "/api/tasks/tsk_1/messages" && request.method === "GET") {
          return Response.json([{ seq: 2, type: "assistant", content: "done" }]);
        }
        if (url.pathname === "/api/issues/iss_1/rerun" && request.method === "POST") {
          return Response.json({ id: "tsk_rerun", issue_id: "iss_1", ...entry.body }, { status: 202 });
        }
        if (url.pathname === "/api/tasks/tsk_1/cancel" && request.method === "POST") {
          return Response.json({ id: "tsk_1", status: "cancelled" });
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
      const serverUrl = `http://127.0.0.1:${server.port}`;

      await runMultiremi(["issue", "list", "--server", serverUrl, "--token", "tok_cli", "--status", "todo", "--project", "prj_1", "--metadata", "ready=true", "--limit", "2", "--offset", "1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "get", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "create", "--server", serverUrl, "--token", "tok_cli", "--title", "Created", "--description", "Body", "--status", "todo", "--priority", "high", "--assignee-id", "agt_1", "--project", "prj_1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "update", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--title", "Updated", "--project=", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "assign", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--to-id", "mem_1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi([
        "issue",
        "comment",
        "list",
        "iss_1",
        "--server",
        serverUrl,
        "--token",
        "tok_cli",
        "--thread",
        "c_root",
        "--since",
        "2025-01-01T00:00:00.000Z",
        "--tail",
        "1",
        "--output",
        "json",
      ], { programName: "multiremi" });
      await runMultiremi([
        "issue",
        "comment",
        "add",
        "iss_1",
        "--server",
        serverUrl,
        "--token",
        "tok_cli",
        "--parent",
        "c_root",
        "--content",
        "Reply from CLI",
      ], { programName: "multiremi" });
      await runMultiremi(["issue", "comment", "update", "c_new", "--server", serverUrl, "--token", "tok_cli", "--content", "Edited"], { programName: "multiremi" });
      await runMultiremi(["issue", "comment", "delete", "c_new", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "comment", "resolve", "c_new", "--server", serverUrl, "--token", "tok_cli", "--actor-type", "member", "--actor-id", "mem_1"], { programName: "multiremi" });
      await runMultiremi(["issue", "comment", "unresolve", "c_new", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["issue", "status", "iss_1", "in_review", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "metadata", "list", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "metadata", "get", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--key", "attempts", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "metadata", "set", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--key", "attempts", "--value", "3", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "metadata", "delete", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--key", "attempts", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "subscriber", "list", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "subscriber", "add", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--user-id", "mem_1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "subscriber", "remove", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--user-id", "mem_1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "runs", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "run-messages", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--since", "1", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "rerun", "iss_1", "--server", serverUrl, "--token", "tok_cli", "--agent-id", "agt_1", "--prompt", "Again", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "cancel-task", "tsk_1", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "search", "Issue", "--server", serverUrl, "--token", "tok_cli", "--limit", "5", "--include-closed", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["issue", "delete", "iss_delete", "--server", serverUrl, "--token", "tok_cli", "--output", "json"], { programName: "multiremi" });

      expect(JSON.parse(logs[0]).issues[0].title).toBe("Issue one");
      expect(JSON.parse(logs[1]).title).toBe("Issue one");
      expect(JSON.parse(logs[2])).toMatchObject({ id: "iss_created", title: "Created", assignee_id: "agt_1" });
      expect(JSON.parse(logs[3])).toMatchObject({ id: "iss_1", title: "Updated", project_id: null });
      expect(JSON.parse(logs[4])).toMatchObject({ id: "iss_1", assignee_type: "member", assignee_id: "mem_1" });
      expect(JSON.parse(logs[5]).map((comment: any) => comment.id)).toEqual(["c_root", "c_new"]);
      expect(JSON.parse(logs[6])).toMatchObject({ id: "c_added", parent_id: "c_root", content: "Reply from CLI" });
      expect(JSON.parse(logs[7])).toMatchObject({ comment: { id: "c_new", content: "Edited" } });
      expect(JSON.parse(logs[8])).toEqual({ ok: true });
      expect(JSON.parse(logs[9])).toMatchObject({ comment: { id: "c_new", actor_type: "member", actor_id: "mem_1" } });
      expect(JSON.parse(logs[10])).toMatchObject({ comment: { id: "c_new", resolved_at: null } });
      expect(JSON.parse(logs[11]).status).toBe("in_review");
      expect(JSON.parse(logs[12])).toEqual({ attempts: 2, ready: true });
      expect(JSON.parse(logs[13])).toBe(2);
      expect(JSON.parse(logs[14])).toEqual({ attempts: 3, ready: true });
      expect(JSON.parse(logs[15])).toEqual({ ready: true });
      expect(JSON.parse(logs[16])[0]).toMatchObject({ id: "sub_1", member_id: "mem_1" });
      expect(JSON.parse(logs[17])).toEqual({ subscribed: true, member_id: "mem_1" });
      expect(JSON.parse(logs[18])).toEqual({ subscribed: false, member_id: "mem_1" });
      expect(JSON.parse(logs[19])[0]).toMatchObject({ id: "tsk_1", status: "completed" });
      expect(JSON.parse(logs[20])[0]).toMatchObject({ seq: 2, type: "assistant" });
      expect(JSON.parse(logs[21])).toMatchObject({ id: "tsk_rerun", agent_id: "agt_1", prompt: "Again" });
      expect(JSON.parse(logs[22])).toMatchObject({ id: "tsk_1", status: "cancelled" });
      expect(JSON.parse(logs[23]).issues[0]).toMatchObject({ id: "iss_1", match_source: "title" });
      expect(JSON.parse(logs[24])).toEqual({ deleted: true });
      expect(errors).toContain("Next reply cursor: --before 2025-01-01T00:00:01.000Z --before-id c_new");
      expect(requests.map((request) => request.path)).toEqual([
        "/api/issues?status=todo&project_id=prj_1&limit=2&offset=1&metadata=%7B%22ready%22%3Atrue%7D",
        "/api/issues/iss_1",
        "/api/issues",
        "/api/issues/iss_1",
        "/api/issues/iss_1",
        "/api/issues/iss_1/comments?since=2025-01-01T00%3A00%3A00.000Z&thread=c_root&tail=1",
        "/api/issues/iss_1/comments",
        "/api/comments/c_new",
        "/api/comments/c_new",
        "/api/comments/c_new/resolve",
        "/api/comments/c_new/resolve",
        "/api/issues/iss_1",
        "/api/issues/iss_1/metadata",
        "/api/issues/iss_1/metadata",
        "/api/issues/iss_1/metadata/attempts",
        "/api/issues/iss_1/metadata/attempts",
        "/api/issues/iss_1/subscribers",
        "/api/issues/iss_1/subscribe",
        "/api/issues/iss_1/unsubscribe",
        "/api/issues/iss_1/task-runs",
        "/api/tasks/tsk_1/messages?since=1",
        "/api/issues/iss_1/rerun",
        "/api/tasks/tsk_1/cancel",
        "/api/issues/search?q=Issue&limit=5&include_closed=true",
        "/api/issues/iss_delete",
      ]);
      expect(requests.every((request) => request.authorization === "Bearer tok_cli")).toBe(true);
      expect(requests[2].body).toMatchObject({ title: "Created", description: "Body", status: "todo", priority: "high", assignee_type: "agent", assignee_id: "agt_1", project_id: "prj_1" });
      expect(requests[3].body).toEqual({ title: "Updated", project_id: null });
      expect(requests[4].body).toEqual({ assignee_type: "member", assignee_id: "mem_1" });
      expect(requests[6].body).toEqual({ content: "Reply from CLI", parent_id: "c_root" });
      expect(requests[7].body).toEqual({ content: "Edited" });
      expect(requests[9].body).toEqual({ actor_type: "member", actor_id: "mem_1" });
      expect(requests[14].body).toEqual({ value: 3 });
      expect(requests[17].body).toEqual({ member_id: "mem_1" });
      expect(requests[18].body).toEqual({ member_id: "mem_1" });
      expect(requests[21].body).toEqual({ agent_id: "agt_1", prompt: "Again" });
      expect(requests[22].body).toEqual({});
    } finally {
      console.log = originalLog;
      console.error = originalError;
      server.stop(true);
    }
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

  test("issue comment list reads legacy cursor headers from older servers", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/issues/iss_legacy/comments" && request.method === "GET") {
          return Response.json([{ id: "c_old", content: "Old cursor" }], {
            headers: {
              "X-Multimira-Next-Before": "2025-01-01T00:00:01.000Z",
              "X-Multimira-Next-Before-Id": "c_old",
            },
          });
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
      await runMultiremi([
        "issue",
        "comment",
        "list",
        "iss_legacy",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--token",
        "tok_cli",
        "--recent",
        "1",
        "--output",
        "json",
      ], { programName: "multiremi" });

      expect(JSON.parse(logs[0])).toEqual([{ id: "c_old", content: "Old cursor" }]);
      expect(errors).toContain("Next thread cursor: --before 2025-01-01T00:00:01.000Z --before-id c_old");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      server.stop(true);
    }
  });
});
