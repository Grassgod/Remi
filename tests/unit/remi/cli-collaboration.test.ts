import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CommandRegistry, type CommandSpec } from "../../../apps/remi/cli/core/index.js";
import {
  BOOTSTRAP_COMPATIBILITY_PATHS,
  collaborationCommandSpecs,
} from "../../../apps/remi/cli/commands/collaboration.js";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

const root = resolve(import.meta.dir, "../../..");
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};
const specs = collaborationCommandSpecs();

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("native collaboration CLI contracts", () => {
  it("forwards project and directory work locations through real Chat and quick-create commands", async () => {
    useCliEnv();
    for (const [command, flag, field] of [
      ["chat.create", "project", "projectId"],
      ["chat.create", "runtime-workspace", "runtime_workspace_id"],
      ["issue.quick-create", "runtime-workspace", "runtime_workspace_id"],
    ]) {
      const spec = specById(command);
      let body: Record<string, unknown> | undefined;
      globalThis.fetch = capabilityFetch(spec.id, async request => {
        body = await request.json() as Record<string, unknown>;
        return Response.json({ id: "created" });
      });
      await capture(() => registryFor([spec]).execute([...spec.path, "--agent", "agent-1", `--${flag}`, "location-1", ...(command === "issue.quick-create" ? ["--prompt", "Inspect files"] : []), "--output", "json"]));
      expect(body?.agent_id).toBe("agent-1");
      expect(body?.[field]).toBe("location-1");
      if (command === "issue.quick-create") expect(body?.prompt).toBe("Inspect files");
    }
  });

  it("creates chats with optional Project binding and keeps pure-chat requests unchanged", async () => {
    useCliEnv();
    const spec = specById("chat.create");
    const bodies: unknown[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/chat/sessions");
      bodies.push(await request.json());
      return Response.json({ id: "chat_1" }, { status: 201 });
    });
    for (const projectArgs of [[], ["--project", "prj_1"], ["--project", "none"]]) {
      await capture(() => registryFor([spec]).execute([
        ...spec.path, "--agent", "agt_1", "--title", "Work", ...projectArgs, "--output", "json",
      ]));
    }
    expect(bodies).toEqual([
      { workspace_id: "ws_1", title: "Work", agent_id: "agt_1" },
      { workspace_id: "ws_1", title: "Work", agent_id: "agt_1", projectId: "prj_1" },
      { workspace_id: "ws_1", title: "Work", agent_id: "agt_1", projectId: null },
    ]);
  });

  it("updates Chat metadata without exposing Project changes", async () => {
    useCliEnv();
    const spec = specById("chat.update");
    expect(registryFor([spec]).renderHelp(spec.path)).not.toContain("--project");
    const bodies: unknown[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/chat/sessions") {
        return Response.json([{ id: "chat_1", title: "Work" }]);
      }
      expect(request.method).toBe("PATCH");
      expect(path).toBe("/api/chat/sessions/chat_1");
      bodies.push(await request.json());
      return Response.json({ id: "chat_1" });
    });
    for (const args of [
      ["--title", "Renamed"],
      ["--status", "archived"],
      ["--data", '{"pinned":true}'],
    ]) {
      await capture(() => registryFor([spec]).execute([...spec.path, "Work", ...args, "--output", "json"]));
    }
    expect(bodies).toEqual([{ title: "Renamed" }, { status: "archived" }, { pinned: true }]);
  });

  it("rejects Project update flags and generic input before any Chat lookup or mutation", async () => {
    useCliEnv();
    const spec = specById("chat.update");
    const registry = registryFor([spec]);
    let requests = 0;
    globalThis.fetch = capabilityFetch(spec.id, async () => { requests++; throw new Error("unexpected Chat request"); });
    for (const value of ["prj_1", "none"]) {
      await expect(capture(() => registry.execute([...spec.path, "chat_1", "--project", value])))
        .rejects.toThrow("--project");
    }
    const dir = await mkdtemp(resolve(tmpdir(), "chat-fixed-project-"));
    try {
      for (const field of ["projectId", "project_id"]) {
        for (const value of ["prj_1", null]) {
          const body = JSON.stringify({ [field]: value });
          const path = resolve(dir, "update.json");
          await writeFile(path, body);
          for (const args of [["--data", body], ["--file", path]]) {
            await expect(capture(() => registry.execute([...spec.path, "chat_1", ...args])))
              .rejects.toThrow("A Chat Project can only be selected when creating the session");
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(requests).toBe(0);
  });

  it("advertises the Project flag only for creation and rejects empty Project values", async () => {
    useCliEnv();
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
    const spec = specById("chat.create");
    const registry = registryFor([spec]);
    expect(registry.renderHelp(spec.path)).toContain("--project <project-id|none>");
    await expect(capture(() => registry.execute([...spec.path, "--agent", "agt_1", "--project", "   "])))
      .rejects.toThrow("--project");
    await expect(capture(() => registry.execute([...spec.path, "--agent", "agt_1", "--project", "prj_1", "--runtime-workspace", "rws_1"])))
      .rejects.toThrow("conflict");
    expect(requests).toBe(0);
  });

  it("sends repeated local Chat attachments and a caption using the Task destination", async () => {
    useCliEnv();
    const dir = await mkdtemp(resolve(tmpdir(), "chat-cli-"));
    const spec = specById("chat.attachment.send");
    expect(spec.auth).toEqual(["task"]);
    try {
      await writeFile(resolve(dir, "report.html"), "<html>Report</html>");
      await writeFile(resolve(dir, "chart.png"), "test-image");
      let sends = 0;
      globalThis.fetch = capabilityFetch(spec.id, async (request) => {
        sends++;
        expect(new URL(request.url).pathname).toBe("/api/chat/attachments/send");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");
        const form = await request.formData();
        expect(form.get("content")).toBe("Report ready");
        expect(form.has("chat_id")).toBe(false);
        const files = form.getAll("file") as File[];
        expect(files.map((file) => file.name)).toEqual(["report.html", "chart.png"]);
        // Multipart parsers may add a charset parameter to text media types.
        expect(files.map((file) => file.type.split(";")[0])).toEqual(["text/html", "image/png"]);
        expect(await files[0]!.text()).toBe("<html>Report</html>");
        return Response.json({ attachments: [{ id: "att_report" }, { id: "att_chart" }], delivery_ids: ["delivery_1", "delivery_2"] });
      });
      const result = await capture(() => registryFor([spec]).execute([
        ...spec.path, "--attachment", resolve(dir, "report.html"), "--attachment", resolve(dir, "chart.png"),
        "--content", "Report ready", "--output", "json",
      ]));
      expect(sends).toBe(1);
      expect(JSON.parse(result.stdout).delivery_ids).toEqual(["delivery_1", "delivery_2"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects missing, remote, and oversized Chat files before uploading anything", async () => {
    useCliEnv();
    const dir = await mkdtemp(resolve(tmpdir(), "chat-cli-"));
    const spec = specById("chat.attachment.send");
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
    try {
      const large = resolve(dir, "large.pdf");
      await writeFile(large, "");
      await truncate(large, 20 * 1024 * 1024 + 1);
      const cases = [
        { args: [], error: "requires --attachment" },
        { args: ["--attachment", "https://example.test/report.html"], error: "local file path" },
        { args: ["--attachment", large], error: "20MB" },
      ];
      for (const value of cases) {
        await expect(capture(() => registryFor([spec]).execute([...spec.path, ...value.args]))).rejects.toThrow(value.error);
      }
      expect(requests).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects empty HTML and image files, including a later batch item, without a network request", async () => {
    useCliEnv();
    const dir = await mkdtemp(resolve(tmpdir(), "chat-cli-empty-"));
    const spec = specById("chat.attachment.send");
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
    try {
      const valid = resolve(dir, "report.html");
      await writeFile(valid, "<h1>Report</h1>");
      for (const filename of ["空 报告.html", "empty.png"]) {
        const empty = resolve(dir, filename);
        await writeFile(empty, "");
        for (const args of [["--attachment", empty], ["--attachment", valid, "--attachment", empty]]) {
          await expect(capture(() => registryFor([spec]).execute([...spec.path, ...args])))
            .rejects.toThrow(`Attachment ${filename} is empty (0 bytes)`);
        }
      }
      expect(requests).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("surfaces rejected Chat file types without claiming successful delivery", async () => {
    useCliEnv();
    const dir = await mkdtemp(resolve(tmpdir(), "chat-cli-"));
    const spec = specById("chat.attachment.send");
    try {
      const path = resolve(dir, "program.exe");
      await writeFile(path, "unsupported");
      globalThis.fetch = capabilityFetch(spec.id, () => Response.json({ error: "File type .exe is not allowed" }, { status: 415 }));
      await expect(capture(() => registryFor([spec]).execute([...spec.path, "--attachment", path]))).rejects.toThrow("not allowed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("manages private chats and queued messages through the registered commands", async () => {
    useCliEnv();
    const cases: Array<{ id: string; args?: string[]; method: string; path: string; body?: unknown }> = [
      { id: "chat.pin", method: "PATCH", path: "/api/chat/sessions/chat_1", body: { pinned: true } },
      { id: "chat.unpin", method: "PATCH", path: "/api/chat/sessions/chat_1", body: { pinned: false } },
      { id: "chat.archive", method: "PATCH", path: "/api/chat/sessions/chat_1", body: { status: "archived" } },
      { id: "chat.restore", method: "PATCH", path: "/api/chat/sessions/chat_1", body: { status: "active" } },
      { id: "chat.queue.update", args: ["task_2", "--content", "先检查测试\n再修改实现"], method: "PATCH", path: "/api/chat/sessions/chat_1/queue/task_2", body: { content: "先检查测试\n再修改实现" } },
      { id: "chat.queue.remove", args: ["task_2"], method: "DELETE", path: "/api/chat/sessions/chat_1/queue/task_2" },
      { id: "chat.queue.clear", method: "DELETE", path: "/api/chat/sessions/chat_1/queue" },
      { id: "chat.queue.prioritize", args: ["task_2"], method: "POST", path: "/api/chat/sessions/chat_1/queue/task_2/prioritize", body: {} },
    ];
    for (const testCase of cases) {
      const spec = specById(testCase.id);
      const writes: Array<{ method: string; path: string; body?: unknown }> = [];
      globalThis.fetch = capabilityFetch(spec.id, async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/chat/sessions" && request.method === "GET") {
          return Response.json([{ id: "chat_1", title: "我的聊天" }]);
        }
        writes.push({ method: request.method, path, body: request.body ? await request.json() : undefined });
        return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "chat_1", task_id: "task_2", active_task_id: "task_1" });
      });
      await capture(() => registryFor([spec]).execute([...spec.path, "我的聊天", ...(testCase.args ?? []), "--output", "json"]));
      expect(writes, testCase.id).toEqual([{ method: testCase.method, path: testCase.path, body: testCase.body }]);
      expect(spec.auth, testCase.id).toEqual(["human"]);
    }
  });

  it("rejects empty queue edits and propagates a task that already started", async () => {
    useCliEnv();
    const spec = specById("chat.queue.update");
    let writes = 0;
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      if (request.method === "GET") return Response.json([{ id: "chat_1", title: "Work" }]);
      writes += 1;
      return Response.json({ error: "task is no longer queued" }, { status: 409 });
    });
    await expect(capture(() => registryFor([spec]).execute([
      ...spec.path, "Work", "task_2", "--content", "   ",
    ]))).rejects.toThrow("requires non-empty");
    expect(writes).toBe(0);
    await expect(capture(() => registryFor([spec]).execute([
      ...spec.path, "Work", "task_2", "--content", "Updated",
    ]))).rejects.toThrow("task is no longer queued");
    expect(writes).toBe(1);
  });

  it("makes the bound-topic continuation commands available to Task credentials", () => {
    const registry = registryFor(specs);
    const inventory = new Map(registry.inventory().map((entry) => [entry.id, entry]));
    const cases = [
      ["session.task.list", ["session", "task", "list", "iss_1", "ises_1", "--output", "json"]],
      ["session.task.create", ["session", "task", "create", "iss_1", "ises_1", "--agent", "agt_owner", "--prompt", "Continue", "--output", "json"]],
      ["task.get", ["task", "get", "tsk_1", "--output", "json"]],
      ["task.continue", ["task", "continue", "tsk_1", "--prompt", "Follow-up", "--output", "json"]],
      ["task.steer", ["task", "steer", "tsk_1", "--content", "Follow-up", "--output", "json"]],
      ["task.steer.list", ["task", "steer", "list", "tsk_1", "--output", "json"]],
    ] as const;
    for (const [id, argv] of cases) {
      expect(inventory.get(id)?.auth, id).toContain("task");
      expect(registry.resolve([...argv])?.spec.id).toBe(id);
    }
  });

  it.each([
    ["task.list", ["task", "list"], "/api/multiremi/tasks"],
    ["task.get", ["task", "get", "tsk_queued"], "/api/multiremi/tasks/tsk_queued"],
    ["session.task.list", ["session", "task", "list", "iss_1", "ises_1"], "/api/issues/iss_1/sessions/ises_1/tasks"],
    ["issue.active-task", ["issue", "active-task", "iss_1"], "/api/issues/iss_1/active-task"],
  ] as const)("shows complete queued task wait reasons through %s", async (id, argv, path) => {
    useCliEnv();
    const spec = specById(id);
    const waitReason = "等待模型能力恢复（已等待至少 15 分钟）：3 个候选 Runtime 均无法执行 claude-opus-5-with-an-extra-long-model-name（thinking: high）";
    const task = { id: "tsk_queued", status: "queued", wait_reason: waitReason };
    const response = id === "task.get" ? { task } : { tasks: [task] };
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(path);
      return Response.json(response);
    });

    const table = await capture(() => registryFor([spec]).execute([...argv]));
    expect(table.stdout).toContain("WAIT REASON");
    expect(table.stdout).toContain("tsk_queued");
    expect(table.stdout).toContain("queued");
    expect(table.stdout).toContain(waitReason);
    expect(table.stdout).not.toContain("awaiting_human");
    const json = await capture(() => registryFor([spec]).execute([...argv, "--output", "json"]));
    expect(JSON.parse(json.stdout)).toEqual(response);
    const jsonl = await capture(() => registryFor([spec]).execute([...argv, "--output", "jsonl"]));
    expect(JSON.parse(jsonl.stdout)).toEqual(task);
  });

  it.each(["wait_reason", "waitReason"] as const)("shows complete issue run wait reasons from %s", async (reasonField) => {
    useCliEnv();
    const spec = specById("issue.task-runs");
    const waitReason = "等待模型能力恢复（任务创建已达 15 分钟）：3 个候选 Runtime 均无法执行 claude-opus-5-with-an-extra-long-model-name（thinking: high）";
    const tasks = [
      { id: "tsk_queued", status: "queued", [reasonField]: waitReason },
      { id: "tsk_human", status: "awaiting_human", [reasonField]: "Need approval" },
      { id: "tsk_dir", status: "waiting_local_directory", [reasonField]: "/tmp/workspace" },
      { id: "tsk_done", status: "running", [reasonField]: null },
    ];
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/api/issues/iss_1/task-runs");
      return Response.json(tasks);
    });

    const table = await capture(() => registryFor([spec]).execute(["issue", "runs", "iss_1"]));
    expect(table.stdout).toContain("WAIT REASON");
    expect(table.stdout.split("\n").find((line) => line.startsWith("tsk_queued"))).toContain(waitReason);
    expect(table.stdout.split("\n").find((line) => line.startsWith("tsk_human"))).toContain("Need approval");
    expect(table.stdout.split("\n").find((line) => line.startsWith("tsk_dir"))).toContain("/tmp/workspace");
    expect(table.stdout.split("\n").find((line) => line.startsWith("tsk_done"))).toMatch(/running\s+(?:-\s+){4}-$/);
    const json = await capture(() => registryFor([spec]).execute(["issue", "runs", "iss_1", "--output", "json"]));
    expect(JSON.parse(json.stdout)).toEqual(tasks);
  });

  it("preserves other waiting states and cleared reasons in task tables", async () => {
    useCliEnv();
    const spec = specById("task.list");
    globalThis.fetch = capabilityFetch(spec.id, () => Response.json({ tasks: [
      { id: "tsk_human", status: "awaiting_human", wait_reason: "Need approval" },
      { id: "tsk_directory", status: "waiting_local_directory", waitReason: "/tmp/workspace" },
      { id: "tsk_recovered", status: "running", wait_reason: null },
    ] }));
    const table = await capture(() => registryFor([spec]).execute(["task", "list"]));
    expect(table.stdout).toContain("awaiting_human");
    expect(table.stdout).toContain("Need approval");
    expect(table.stdout).toContain("waiting_local_directory");
    expect(table.stdout).toContain("/tmp/workspace");
    expect(table.stdout.split("\n").find((line) => line.startsWith("tsk_recovered"))).toMatch(/running\s+-\s+-$/);
  });

  it("continues the exact delegated task through the registered command", async () => {
    useCliEnv();
    const spec = specById("task.continue");
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path,
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      });
      if (request.method === "GET") {
        return Response.json({ task: { id: "tsk_previous", agentId: "agt_worker" } });
      }
      return Response.json({ task: { id: "tsk_continued", status: "queued" } }, { status: 201 });
    });

    const result = await capture(() => registryFor([spec]).execute([
      ...spec.path,
      "tsk_previous",
      "--prompt",
      "Fix the review feedback",
      "--output",
      "json",
    ]));
    expect(requests).toEqual([
      { method: "GET", path: "/api/multiremi/tasks/tsk_previous" },
      {
        method: "POST",
        path: "/api/multiremi/tasks",
        body: {
          agentId: "agt_worker",
          prompt: "Fix the review feedback",
          continueTaskId: "tsk_previous",
        },
      },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ task: { id: "tsk_continued" } });
  });

  it("keeps issue share capability management human-only", () => {
    const inventory = new Map(registryFor(specs).inventory().map((entry) => [entry.id, entry]));
    for (const id of ["share.get", "share.create", "share.extend", "share.delete"]) {
      expect(inventory.get(id)?.auth, id).toEqual(["human"]);
    }
    expect(inventory.get("share.view")?.auth).toEqual(["human", "share", "task"]);
  });

  it("declares output/paging contracts and confirmations for native destructive commands", () => {
    for (const spec of specs.filter((candidate) => candidate.capability)) {
      expect(spec.outputs, spec.id).toEqual(["table", "json", "jsonl"]);
      const options = new Set(spec.options?.map((option) => option.name));
      expect(options.has("output"), `${spec.id} --output`).toBe(true);
      expect(options.has("workspace"), `${spec.id} --workspace`).toBe(true);
      if (spec.mutation === "read") {
        for (const name of ["limit", "cursor", "query"]) {
          expect(options.has(name), `${spec.id} --${name}`).toBe(true);
        }
      }
      if (spec.mutation === "destructive" && spec.parse !== "passthrough") {
        expect(options.has("yes"), `${spec.id} --yes`).toBe(true);
      }
    }
  });

  it("injects canonical daemon prompt paths while preserving legacy issue dispatch", () => {
    const daemonSource = readFileSync(resolve(root, "packages/daemon/src/agent-runtime/prompts/ephemeral.ts"), "utf8");
    const canonicalPromptPaths = [
      "comment list",
      "comment add",
      "session result publish",
      "session list",
      "session task list",
      "session task create",
      "task get",
      "task steer",
      "task steer list",
    ];
    for (const path of canonicalPromptPaths) {
      expect(daemonSource, path).toContain(`remi ${path}`);
    }
    const compatibilityPaths = [
      "issue comment list",
      "issue comment add",
      "issue session result publish",
    ];
    for (const path of compatibilityPaths) {
      expect(daemonSource, path).not.toContain(`remi ${path}`);
      expect(BOOTSTRAP_COMPATIBILITY_PATHS).toContain(path as typeof BOOTSTRAP_COMPATIBILITY_PATHS[number]);
    }

    const registry = new CommandRegistry();
    registry.register(legacyParent("issue"));
    registry.register(legacyParent("attachment"));
    for (const spec of specs) registry.register(spec);
    const cases = [
      ["issue", "comment", "list", "iss_1", "--thread", "cmt_1", "--output", "json"],
      ["issue", "comment", "add", "iss_1", "--parent", "cmt_1", "--content-stdin"],
      ["issue", "session", "result", "publish", "iss_1", "--session", "ises_1", "--content-stdin"],
    ];
    for (const argv of cases) {
      const invocation = registry.resolve(argv);
      expect(invocation?.spec.id, argv.join(" ")).toBe(`legacy.${argv[0]}`);
      expect(invocation?.rawArgs, argv.join(" ")).toEqual(argv.slice(1));
    }

    const attachmentDownload = registry.resolve(["attachment", "download", "att_1", "--output-dir", "/tmp"]);
    expect(attachmentDownload?.spec.id).toBe("issue.attachment.download");
    expect(attachmentDownload?.positionals).toEqual(["att_1"]);
    expect(attachmentDownload?.options["output-dir"]).toBe("/tmp");

    const inventory = specs.flatMap((spec) => spec.aliases ?? []);
    for (const path of compatibilityPaths) {
      expect(inventory.some((alias) => alias.path.join(" ") === path && alias.dispatch === false), path).toBe(true);
    }

    const taskMessages = registry.resolve(["task", "messages", "tsk_1", "--since", "4"]);
    expect(taskMessages?.spec.id).toBe("task.message.list");
    expect(taskMessages?.options.since).toBe(4);
  });

  it("keeps issue list output byte-compatible with the legacy handler", async () => {
    useCliEnv();
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/issues") return Response.json({ issues: [{ id: "iss_1", key: "MUL-1", title: "Compatibility", status: "todo", priority: "high" }], total: 1 });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const direct = await capture(() => runMultiremi(["issue", "list", "--output", "json"], { programName: "remi multiremi" }));
    const nativeAdapter = specById("issue.list");
    const viaRegistry = await capture(() => registryFor([nativeAdapter]).execute(["issue", "list", "--output", "json"]));
    expect(viaRegistry).toEqual(direct);
  });

  it("supports table, JSON, and JSONL on a native collaboration read command", async () => {
    useCliEnv();
    const spec = specById("label.list");
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      if (new URL(request.url).pathname === "/api/labels") {
        return Response.json({ labels: [{ id: "lbl_1", name: "Urgent", color: "#ff0000" }], total: 1 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const table = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "table"]));
    const json = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "json"]));
    const jsonl = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "jsonl"]));
    expect(table.stdout).toContain("Urgent");
    expect(JSON.parse(json.stdout)).toMatchObject({ labels: [{ id: "lbl_1", name: "Urgent" }] });
    expect(JSON.parse(jsonl.stdout)).toMatchObject({ id: "lbl_1", name: "Urgent" });
  });

  it("rejects removed Chat Issue commands without making API requests", async () => {
    useCliEnv();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("Removed Chat Issue commands must not call the API");
    }) as unknown as typeof fetch;
    const registry = registryFor(specs);
    for (const suffix of [["bind", "Work", "MUL-226"], ["unbind", "Work"],
      ["updates", "get", "Work"], ["updates", "enable", "Work"], ["updates", "disable", "Work"]]) {
      await expect(capture(() => registry.execute(["chat", "issue", ...suffix])))
        .rejects.toThrow("usage: remi chat <command>");
    }
    expect(requests).toBe(0);
  });

  it("creates workspace Sessions by default and supports discussion Sessions", async () => {
    useCliEnv();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capabilityFetch("session.create", async (input) => {
      const request = input;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/issues/MUL-136/sessions");
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ id: `ises_${bodies.length}`, ...body }, { status: 201 });
    });
    const spec = specById("session.create");

    await capture(() => registryFor([spec]).execute([
      "session", "create", "MUL-136", "--title", "Implementation", "--output", "json",
    ]));
    await capture(() => registryFor([spec]).execute([
      "session", "create", "MUL-136", "--title", "Design chat", "--discussion", "--output", "json",
    ]));

    expect(bodies).toEqual([
      { title: "Implementation" },
      { title: "Design chat", holds_workspace: false },
    ]);
  });

  it("creates side Sessions from a parent with or without --discussion", async () => {
    useCliEnv();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capabilityFetch("session.create", async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/issues/MUL-312/sessions");
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json({ id: "ises_side" }, { status: 201 });
    });
    const spec = specById("session.create");
    for (const extra of [[], ["--discussion"]]) {
      await capture(() => registryFor([spec]).execute([
        "session", "create", "MUL-312", "--title", "Side", "--from", "ises_main", ...extra,
      ]));
    }
    expect(bodies).toEqual([
      { title: "Side", holds_workspace: false, parent_session_id: "ises_main" },
      { title: "Side", holds_workspace: false, parent_session_id: "ises_main" },
    ]);
    expect(registryFor([spec]).renderHelpForArgv(["session", "create", "--help"]))
      .toContain("--from <session-id>");
  });

  it("shows frozen inheritance fields by Session ID in table, JSON, and JSONL", async () => {
    useCliEnv();
    const spec = specById("session.show");
    const session = {
      id: "ises_side", title: "Side", status: "active", parent_session_id: "ises_main",
      inherit_mode: "snapshot", inherit_cutoff_seq: 42, inherited_event_count: 37,
    };
    const paths: string[] = [];
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/api/sessions/ises_side/inherited-context") {
        return Response.json({ diagnostics: { truncated: true } });
      }
      expect(path).toBe("/api/sessions/ises_side");
      return Response.json(session);
    });
    for (const mode of ["json", "jsonl"]) {
      const result = await capture(() => registryFor([spec]).execute(["session", "show", "ises_side", "--output", mode]));
      expect(JSON.parse(result.stdout)).toEqual(session);
    }
    const table = await capture(() => registryFor([spec]).execute(["session", "show", "ises_side"]));
    for (const value of ["PARENT", "CUTOFF", "INHERITED EVENTS (PRE-TRUNCATION)", "TRUNCATED", "ises_main", "snapshot", "42", "37"]) {
      expect(table.stdout).toContain(value);
    }
    expect(table.stdout.split("\n")[1]?.trim().split(/\s{2,}/).at(-1)).toBe("true");
    expect(paths).toEqual([
      "/api/sessions/ises_side", "/api/sessions/ises_side", "/api/sessions/ises_side",
      "/api/sessions/ises_side/inherited-context",
    ]);
    expect(registryFor(specs).resolve(["session", "get", "MUL-312", "ises_side"])?.spec.id).toBe("session.get");
  });

  it("creates follow Sessions with an explicit inheritance mode", async () => {
    useCliEnv();
    const spec = specById("session.create");
    let body: unknown;
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      body = await request.json();
      return Response.json({ id: "ises_follow" }, { status: 201 });
    });
    await capture(() => registryFor([spec]).execute([
      "session", "create", "MUL-324", "--title", "Follow", "--from", "ises_main", "--inherit-mode", "follow",
    ]));
    expect(body).toEqual({ title: "Follow", holds_workspace: false, parent_session_id: "ises_main", inherit_mode: "follow" });
    expect(registryFor([spec]).renderHelpForArgv(["session", "create", "--help"]))
      .toContain("--inherit-mode <snapshot|follow>");
  });

  it("opts into code snapshots independently of inheritance mode and defaults to no code", async () => {
    useCliEnv();
    const spec = specById("session.create");
    const bodies: unknown[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/issues/MUL-324/sessions");
      bodies.push(await request.json());
      return Response.json({ id: "ises_code" }, { status: 201 });
    });
    for (const inheritMode of ["snapshot", "follow"]) {
      for (const extra of [[], ["--with-code"]]) {
        await capture(() => registryFor([spec]).execute([
          "session", "create", "MUL-324", "--from", "ises_main", "--inherit-mode", inheritMode, ...extra,
        ]));
      }
    }
    expect(bodies).toEqual([
      { holds_workspace: false, parent_session_id: "ises_main", inherit_mode: "snapshot" },
      { holds_workspace: false, parent_session_id: "ises_main", inherit_mode: "snapshot", with_code: true },
      { holds_workspace: false, parent_session_id: "ises_main", inherit_mode: "follow" },
      { holds_workspace: false, parent_session_id: "ises_main", inherit_mode: "follow", with_code: true },
    ]);
    expect(registryFor([spec]).renderHelpForArgv(["session", "create", "--help"]))
      .toContain("--with-code");
  });

  it("keeps missing Session diagnostics distinct from a recorded untruncated projection", async () => {
    useCliEnv();
    const spec = specById("session.show");
    for (const diagnostics of [null, { truncated: false }]) {
      globalThis.fetch = capabilityFetch(spec.id, (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/sessions/ises_side/inherited-context") return Response.json({ diagnostics });
        expect(path).toBe("/api/sessions/ises_side");
        return Response.json({ id: "ises_side", title: "Side", status: "active", inherit_mode: "snapshot" });
      });
      const result = await capture(() => registryFor([spec]).execute(["session", "show", "ises_side"]));
      expect(result.stdout.split("\n")[1]?.trim().split(/\s{2,}/).at(-1)).toBe(diagnostics ? "false" : "-");
    }
  });

  it("reads recorded inherited context through its registered command in all output modes", async () => {
    useCliEnv();
    const spec = specById("session.inherited-context");
    const registry = registryFor([spec]);
    expect(spec.auth).toEqual(["human", "task"]);
    expect(registry.renderHelpForArgv(["session", "inherited-context", "--help"]))
      .toContain("<session>");
    const context = {
      session_id: "ises_side", parent_session_id: "ises_main", parent_session_title: "Main",
      inherit_mode: "snapshot", inherit_cutoff_seq: 42, inherited_event_count: 37,
      diagnostics: {
        task_id: "tsk_latest", agent_id: "agt_worker", to_seq: 42, truncated: true,
        omitted_events: 25, estimated_tokens: 12800, token_budget: 32000,
        recorded_at: "2026-09-17T16:33:37.961Z",
      },
    };
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/api/sessions/ises_side/inherited-context");
      return Response.json(context);
    });
    for (const mode of ["json", "jsonl"]) {
      const result = await capture(() => registry.execute(["session", "inherited-context", "ises_side", "--output", mode]));
      expect(JSON.parse(result.stdout)).toEqual(context);
    }
    const table = await capture(() => registry.execute(["session", "inherited-context", "ises_side"]));
    expect(table.stdout.split("\n")[0]?.trim().split(/\s{2,}/)).toEqual([
      "SESSION", "PARENT", "CUTOFF", "INHERITED EVENTS (PRE-TRUNCATION)",
      "TRUNCATED", "OMITTED", "EST TOKENS", "TOKEN BUDGET",
      "INHERIT", "PARENT MAX", "PARENT CURSORS", "TOTAL INHERITED TOKENS", "FOLLOW TOKEN LIMIT", "FOLLOW FROZEN", "FROZEN AT",
    ]);
    expect(table.stdout.split("\n")[1]?.trim().split(/\s{2,}/)).toEqual([
      "ises_side", "ises_main", "42", "37", "true", "25", "12800", "32000",
      "snapshot", "-", "-", "-", "-", "-", "-",
    ]);
  });

  it("preserves null and zero inherited diagnostics without inventing a truncation result", async () => {
    useCliEnv();
    const spec = specById("session.inherited-context");
    for (const state of ["pending", "none", "untruncated"] as const) {
      const inherits = state !== "none";
      const context = {
        session_id: "ises_side", parent_session_id: inherits ? "ises_main" : null,
        parent_session_title: inherits ? "Main" : null, inherit_mode: inherits ? "snapshot" : "none",
        inherit_cutoff_seq: inherits ? 0 : null, inherited_event_count: inherits ? 0 : null,
        diagnostics: state === "untruncated" ? {
          task_id: "tsk_latest", agent_id: "agt_worker", to_seq: 0, truncated: false,
          omitted_events: 0, estimated_tokens: 0, token_budget: 32000,
          recorded_at: "2026-09-17T16:33:37.961Z",
        } : null,
      };
      globalThis.fetch = capabilityFetch(spec.id, (request) => {
        expect(new URL(request.url).pathname).toBe("/api/sessions/ises_side/inherited-context");
        return Response.json(context);
      });
      const registry = registryFor([spec]);
      const json = await capture(() => registry.execute([...spec.path, "ises_side", "--output", "json"]));
      expect(JSON.parse(json.stdout)).toEqual(context);
      const table = await capture(() => registry.execute([...spec.path, "ises_side"]));
      expect(table.stdout.split("\n")[1]?.trim().split(/\s{2,}/)).toEqual([
        "ises_side", inherits ? "ises_main" : "-", inherits ? "0" : "-", inherits ? "0" : "-",
        ...(state === "untruncated" ? ["false", "0", "0", "32000"] : ["-", "-", "-", "-"]),
        inherits ? "snapshot" : "none", "-", "-", "-", "-", "-", "-",
      ]);
    }
  });

  it("shows each follow lane's progress and cumulative token freeze state", async () => {
    useCliEnv();
    const context = {
      session_id: "ises_follow", parent_session_id: "ises_main", parent_session_title: "Main",
      inherit_mode: "follow", inherit_cutoff_seq: 42, inherited_event_count: 80, parent_max_seq: 91,
      lanes: [
        { agent_id: "agt_first", execution_scope: "prod", parent_cursor_seq: 73 },
        { agent_id: "agt_second", execution_scope: "prod", parent_cursor_seq: 54 },
      ],
      inherited_tokens_total: 45000, follow_token_limit: 200000, follow_frozen: false, follow_frozen_seq: null as number | null, diagnostics: null,
    };
    const spec = specById("session.inherited-context");
    globalThis.fetch = capabilityFetch(spec.id, () => Response.json(context));
    const registry = registryFor([spec]);
    const table = await capture(() => registry.execute([...spec.path, "ises_follow"]));
    for (const expected of ["follow", "91", "agt_first/prod:73", "agt_second/prod:54", "45000", "200000", "false"]) {
      expect(table.stdout).toContain(expected);
    }
    for (const mode of ["json", "jsonl"]) {
      const result = await capture(() => registry.execute([...spec.path, "ises_follow", "--output", mode]));
      expect(JSON.parse(result.stdout)).toEqual(context);
    }
    context.follow_frozen = true;
    context.follow_frozen_seq = 73;
    const frozen = await capture(() => registry.execute([...spec.path, "ises_follow"]));
    expect(frozen.stdout).toContain("follow");
    expect(frozen.stdout.trim().split(/\s{2,}/).slice(-2)).toEqual(["true", "73"]);
  });

  it("executes task inspection and supervisor-only redispatch commands", async () => {
    useCliEnv();
    const inspect = specById("task.inspect");
    globalThis.fetch = capabilityFetch(inspect.id, (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/api/tasks/tsk_target/inspection");
      return Response.json({ inspection: { id: "tsk_target", status: "running" } });
    });
    const inspected = await capture(() => registryFor([inspect]).execute([
      "task", "inspect", "tsk_target", "--output", "json",
    ]));
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      inspection: { id: "tsk_target", status: "running" },
    });

    const redispatch = specById("task.redispatch");
    let body: unknown;
    globalThis.fetch = capabilityFetch(redispatch.id, async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/tasks/tsk_target/redispatch");
      body = await request.json();
      return Response.json({ replacement_task: { id: "tsk_replacement", status: "queued" } }, { status: 202 });
    });
    await capture(() => registryFor([redispatch]).execute([
      "task", "redispatch", "tsk_target", "--reason", "Queued too long", "--yes", "--output", "json",
    ]));
    expect(body).toEqual({ reason: "Queued too long" });
    expect(registryFor([redispatch]).inventory()[0]?.auth).toEqual(["task"]);
  });

  it("uploads attachments against the requested issue and honors structured output", async () => {
    useCliEnv();
    let uploadedIssue = "";
    globalThis.fetch = (async (_input, init) => {
      const form = init?.body as FormData;
      uploadedIssue = String(form.get("issue_id"));
      return Response.json({ attachment: { id: "att_1", issue_id: uploadedIssue, filename: "package.json" } });
    }) as typeof fetch;
    const upload = specById("issue.attachment.upload");
    const result = await capture(() => registryFor([upload]).execute([
      "issue", "attachment", "upload", "iss_target", "--attachment", resolve(root, "package.json"), "--output", "json",
    ]));
    expect(uploadedIssue).toBe("iss_target");
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "att_1", issue_id: "iss_target" }),
    ]);
  });

  it("leaves default-assignee inheritance to the server and opts out with --no-project-defaults", async () => {
    useCliEnv();
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/issues" && request.method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        return Response.json({ id: `iss_${bodies.length}`, ...body }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    }) as typeof fetch;
    const spec = specById("issue.create");
    // Default: no assignee fields at all — the server inherits the project default.
    const inherited = await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Inherited", "--project", "prj_1"]));
    expect(bodies[0]).not.toHaveProperty("assignee_id");
    expect(bodies[0]).not.toHaveProperty("assignee_type");
    expect(inherited.stderr).not.toContain("Project default assignee is");
    // --use-project-defaults stays accepted as a no-op (server-side default).
    await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Legacy opt-in", "--project", "prj_1", "--use-project-defaults"]));
    expect(bodies[1]).not.toHaveProperty("assignee_id");
    // --no-project-defaults sends explicit nulls so the issue stays unassigned.
    await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Unassigned", "--project", "prj_1", "--no-project-defaults"]));
    expect(bodies[2]).toMatchObject({ assignee_type: null, assignee_id: null });
  });

  it("restores an archived issue through the native command", async () => {
    useCliEnv();
    const spec = specById("issue.restore");
    let restored = "";
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/issues/iss_archived/restore") {
        restored = path;
        return Response.json({ id: "iss_archived", status: "backlog", deleted_at: null });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });
    const result = await capture(() => registryFor([spec]).execute(["issue", "restore", "iss_archived", "--output", "json"]));
    expect(restored).toBe("/api/issues/iss_archived/restore");
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "iss_archived", deleted_at: null });
  });

  it("retitles an issue through the registered command and supports dry-run", async () => {
    useCliEnv();
    const spec = specById("issue.retitle");
    const bodies: unknown[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/multiremi/issues/MUL-111/retitle") {
        bodies.push(await request.json());
        return Response.json({
          title: "Use Luna to improve Issue titles",
          previous_title: "Remi",
          applied: (bodies.at(-1) as { apply: boolean }).apply,
          reason: "generated",
        });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });

    await capture(() => registryFor([spec]).execute([
      "issue", "retitle", "MUL-111", "--output", "json",
    ]));
    await capture(() => registryFor([spec]).execute([
      "issue", "retitle", "MUL-111", "--dry-run", "--output", "json",
    ]));

    expect(bodies).toEqual([{ apply: true }, { apply: false }]);
  });
});

function specById(id: string): CommandSpec {
  const spec = specs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`missing spec ${id}`);
  return spec;
}

function registryFor(entries: readonly CommandSpec[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const entry of entries) registry.register(entry);
  return registry;
}

function legacyParent(name: string): CommandSpec {
  return {
    id: `legacy.${name}`,
    path: [name],
    description: "legacy",
    parse: "passthrough",
    run: async () => {},
  };
}

async function capture(run: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function capabilityFetch(commandId: string, handler: (request: Request) => Response | Promise<Response>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ commands: [{ id: commandId, allowed: true }] });
    }
    return handler(request);
  }) as typeof fetch;
}

function useCliEnv(): void {
  process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
  process.env.MULTIREMI_WORKSPACE_ID = "ws_1";
  process.env.MULTIREMI_TOKEN = "test-token";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
