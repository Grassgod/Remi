import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMultiremiConfig,
  redactMultiremiConfig,
  saveMultiremiConfig,
} from "../src/multiremi/config.js";
import {
  buildDaemonForegroundArgs,
  buildMultiremiDaemonLaunchSpec,
  buildMultiremiDaemonServiceSpec,
  multiremiDaemonServicePath,
  multiremiDaemonPaths,
  runMultiremi,
} from "../src/cli/multiremi.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi CLI config", () => {
  test("saves, loads, and redacts local daemon config", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-config-"));
    const path = join(tmp, "config.json");

    saveMultiremiConfig({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "mul_secret",
      provider: "claude",
      daemon_id: "daemon-devbox",
    }, path);

    expect(loadMultiremiConfig(path)).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "mul_secret",
      provider: "claude",
      daemon_id: "daemon-devbox",
    });
    expect(redactMultiremiConfig(loadMultiremiConfig(path))).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "***",
      provider: "claude",
      daemon_id: "daemon-devbox",
    });
  });

  test("builds background daemon launch spec without leaking token in argv", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-daemon-launch-"));
    const previousStateDir = process.env.MULTIREMI_STATE_DIR;
    try {
      process.env.MULTIREMI_STATE_DIR = tmp;
      const spec = buildMultiremiDaemonLaunchSpec({
        server: "https://api.example.test",
        workspace: "ws_1",
        token: "mul_secret",
        provider: "claude",
        daemonId: "daemon-devbox",
        daemonPort: "6222",
        name: "devbox",
      }, "remi multiremi", ["/usr/bin/bun", "/repo/src/main.ts"], "/usr/bin/bun");

      expect(spec.command).toBe("/usr/bin/bun");
      expect(spec.args).toEqual([
        "/repo/src/main.ts",
        "multiremi",
        "daemon",
        "start",
        "--foreground",
        "--server",
        "https://api.example.test",
        "--workspace",
        "ws_1",
        "--provider",
        "claude",
        "--daemon-id",
        "daemon-devbox",
        "--daemon-port",
        "6222",
        "--name",
        "devbox",
      ]);
      expect(spec.args.join(" ")).not.toContain("mul_secret");
      expect(spec.env).toEqual({ MULTIREMI_TOKEN: "mul_secret" });
      expect(spec.port).toBe(6222);
      expect(spec.pidPath).toBe(join(tmp, "daemon.pid"));
      expect(spec.logPath).toBe(join(tmp, "daemon.log"));
    } finally {
      if (previousStateDir === undefined) delete process.env.MULTIREMI_STATE_DIR;
      else process.env.MULTIREMI_STATE_DIR = previousStateDir;
    }
  });

  test("normalizes daemon foreground args and state paths", () => {
    expect(buildDaemonForegroundArgs({
      "server-url": "https://api.example.test",
      "workspace-id": "ws_2",
      "runtime-id": "rt_1",
      "daemon-id": "daemon-local",
      "repo-cache-root": "/tmp/repos",
      token: "mul_secret",
    })).toEqual([
      "daemon",
      "start",
      "--foreground",
      "--server",
      "https://api.example.test",
      "--workspace",
      "ws_2",
      "--runtime-id",
      "rt_1",
      "--daemon-id",
      "daemon-local",
      "--repo-cache-root",
      "/tmp/repos",
    ]);
    expect(multiremiDaemonPaths("/tmp/multiremi-state")).toEqual({
      stateDir: "/tmp/multiremi-state",
      pidPath: "/tmp/multiremi-state/daemon.pid",
      logPath: "/tmp/multiremi-state/daemon.log",
    });
  });

  test("builds launchd and systemd service files without leaking tokens in argv", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-service-spec-"));
    const previousStateDir = process.env.MULTIREMI_STATE_DIR;
    try {
      process.env.MULTIREMI_STATE_DIR = join(tmp, "state dir");
      const commonOptions = {
        server: "https://api.example.test",
        workspace: "ws_1",
        provider: "claude",
        daemonId: "daemon-devbox",
        daemonPort: "6222",
        name: "devbox",
      };

      const launchd = buildMultiremiDaemonServiceSpec(
        commonOptions,
        "remi multiremi",
        "launchd",
        join(tmp, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      );
      expect(launchd.path).toBe(join(tmp, "home", "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist"));
      expect(launchd.content).toContain("<key>ProgramArguments</key>");
      expect(launchd.content).toContain("<string>/usr/bin/bun</string>");
      expect(launchd.content).toContain("<string>/repo/src/main.ts</string>");
      expect(launchd.content).toContain("<string>daemon</string>");
      expect(launchd.content).toContain("<string>--daemon-id</string>");
      expect(launchd.content).toContain("<string>daemon-devbox</string>");
      expect(launchd.content).toContain("<key>MULTIREMI_STATE_DIR</key>");
      expect(launchd.content).not.toContain("mul_secret");

      const systemd = buildMultiremiDaemonServiceSpec(
        commonOptions,
        "remi multiremi",
        "systemd",
        join(tmp, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      );
      expect(systemd.path).toBe(join(tmp, "home", ".config", "systemd", "user", "multiremi-daemon.service"));
      expect(systemd.content).toContain("ExecStart=/usr/bin/bun /repo/src/main.ts multiremi daemon start --foreground");
      expect(systemd.content).toContain("--daemon-id daemon-devbox");
      expect(systemd.content).toContain('Environment="MULTIREMI_STATE_DIR=');
      expect(systemd.content).toContain("Restart=always");
      expect(systemd.content).not.toContain("mul_secret");
      expect(() => buildMultiremiDaemonServiceSpec(
        { ...commonOptions, token: "mul_secret" },
        "multiremi",
        "systemd",
        join(tmp, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      )).toThrow("does not write tokens");
    } finally {
      if (previousStateDir === undefined) delete process.env.MULTIREMI_STATE_DIR;
      else process.env.MULTIREMI_STATE_DIR = previousStateDir;
    }
  });

  test("daemon service install writes a user service file", async () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-service-install-"));
    const serviceDir = join(tmp, "services");
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      console.error = (value?: unknown) => { errors.push(String(value)); };

      await runMultiremi([
        "daemon",
        "service",
        "install",
        "--platform",
        "systemd",
        "--service-dir",
        serviceDir,
        "--server",
        "https://api.example.test",
        "--workspace",
        "ws_1",
        "--provider",
        "codex",
      ], { programName: "multiremi" });

      const servicePath = multiremiDaemonServicePath("systemd", tmp, serviceDir);
      expect(existsSync(servicePath)).toBeTrue();
      const service = readFileSync(servicePath, "utf8");
      expect(service).toContain("ExecStart=");
      expect(service).toContain("--provider codex");
      expect(service).not.toContain("MULTIREMI_TOKEN");
      expect(logs).toEqual([]);
      expect(errors[0]).toContain("Multiremi daemon service written:");
      expect(errors.join("\n")).toContain("systemctl --user daemon-reload");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test("repo checkout relays to the local daemon helper", async () => {
    let requestBody: any = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requestBody = await request.json();
        return Response.json({ path: "/tmp/work/repo", branch_name: "agent/test/task" });
      },
    });
    const previousEnv = {
      port: process.env.MULTIREMI_DAEMON_PORT,
      workspace: process.env.MULTIREMI_WORKSPACE_ID,
      agent: process.env.MULTIREMI_AGENT_NAME,
      task: process.env.MULTIREMI_TASK_ID,
    };
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      process.env.MULTIREMI_DAEMON_PORT = String(server.port);
      process.env.MULTIREMI_WORKSPACE_ID = "local";
      process.env.MULTIREMI_AGENT_NAME = "Test Agent";
      process.env.MULTIREMI_TASK_ID = "tsk_cli";
      console.log = (value?: unknown) => { logs.push(String(value)); };
      console.error = (value?: unknown) => { errors.push(String(value)); };

      await runMultiremi(["repo", "checkout", "https://github.com/example/repo.git", "--ref", "main"], { programName: "multiremi" });

      expect(requestBody).toMatchObject({
        url: "https://github.com/example/repo.git",
        workspace_id: "local",
        ref: "main",
        agent_name: "Test Agent",
        task_id: "tsk_cli",
      });
      expect(logs).toEqual(["/tmp/work/repo"]);
      expect(errors[0]).toContain("Checked out https://github.com/example/repo.git -> /tmp/work/repo");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (previousEnv.port === undefined) delete process.env.MULTIREMI_DAEMON_PORT;
      else process.env.MULTIREMI_DAEMON_PORT = previousEnv.port;
      if (previousEnv.workspace === undefined) delete process.env.MULTIREMI_WORKSPACE_ID;
      else process.env.MULTIREMI_WORKSPACE_ID = previousEnv.workspace;
      if (previousEnv.agent === undefined) delete process.env.MULTIREMI_AGENT_NAME;
      else process.env.MULTIREMI_AGENT_NAME = previousEnv.agent;
      if (previousEnv.task === undefined) delete process.env.MULTIREMI_TASK_ID;
      else process.env.MULTIREMI_TASK_ID = previousEnv.task;
      server.stop(true);
    }
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
      expect(tableHeaders(logs[2])).toEqual(["ID", "AGENT", "STATUS", "STARTED", "COMPLETED", "ERROR"]);
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
      await runMultiremi(["attachment", "download", "att_1", "--server", serverUrl, "--token", "tok_cli", "--output-dir", tmp], { programName: "multiremi" });

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
      expect(readFileSync(join(tmp, "download.txt"), "utf8")).toBe("downloaded!");
      expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({ id: "att_1", filename: "download.txt", path: join(tmp, "download.txt") });
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

function tableHeaders(output: string): string[] {
  return output.split("\n")[0]?.trim().split(/\s{2,}/) ?? [];
}
