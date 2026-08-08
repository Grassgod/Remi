// `multiremi agent` list/read/edit, including the client-side validation that
// rejects an empty or malformed update before it reaches the server.
import { describe, expect, test } from "bun:test";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";
import { tableHeaders } from "./helpers.js";

describe("Multiremi CLI — agent management", () => {
  test("agent CLI lists, reads, and edits post-create metadata", async () => {
    const requests: Array<{
      method: string;
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const agentRow = {
      id: "agt_1",
      name: "Builder",
      description: "Builds things",
      instructions: "Be careful",
      avatar_url: "https://example.test/avatar.png",
      provider: "claude",
      model: "claude-sonnet",
      thinking_level: "medium",
      visibility: "workspace",
      max_concurrent_tasks: 2,
      updated_at: "2026-07-27T12:00:00.000Z",
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "PUT"
          ? await request.json() as Record<string, unknown>
          : {};
        requests.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("Authorization"),
          body,
        });
        if (url.pathname === "/api/agents" && request.method === "GET") {
          return Response.json([agentRow]);
        }
        if (url.pathname === "/api/agents/agt_1" && request.method === "GET") {
          return Response.json(agentRow);
        }
        if (url.pathname === "/api/agents/agt_1" && request.method === "PUT") {
          return Response.json({ ...agentRow, ...body });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const serverUrl = `http://127.0.0.1:${server.port}`;
      const connectionArgs = [
        "--server",
        serverUrl,
        "--token",
        "tok_cli",
        "--workspace",
        "ws_cli",
      ];

      await runMultiremi(["agent", "list", ...connectionArgs], { programName: "multiremi" });
      await runMultiremi(["agent", "get", "agt_1", ...connectionArgs], { programName: "multiremi" });
      await runMultiremi([
        "agent",
        "edit",
        "agt_1",
        ...connectionArgs,
        "--name",
        "Researcher",
        "--description=",
        "--instructions",
        "Investigate first.\nThen report.",
        "--avatar-url=",
        "--provider",
        "codex",
        "--model",
        "gpt-5.4",
        "--thinking-level",
        "high",
        "--visibility",
        "private",
        "--max-concurrent-tasks",
        "4",
      ], { programName: "multiremi" });

      expect(tableHeaders(logs[0]!)).toEqual([
        "ID",
        "NAME",
        "ENGINE",
        "MODEL",
        "VISIBILITY",
        "CONCURRENCY",
        "UPDATED",
      ]);
      expect(JSON.parse(logs[1]!)).toMatchObject({ id: "agt_1", name: "Builder" });
      expect(JSON.parse(logs[2]!)).toMatchObject({
        id: "agt_1",
        name: "Researcher",
        provider: "codex",
        visibility: "private",
      });
      expect(requests).toEqual([
        {
          method: "GET",
          path: "/api/agents?workspace_id=ws_cli",
          authorization: "Bearer tok_cli",
          body: {},
        },
        {
          method: "GET",
          path: "/api/agents/agt_1",
          authorization: "Bearer tok_cli",
          body: {},
        },
        {
          method: "PUT",
          path: "/api/agents/agt_1",
          authorization: "Bearer tok_cli",
          body: {
            name: "Researcher",
            description: "",
            instructions: "Investigate first.\nThen report.",
            avatar_url: "",
            model: "gpt-5.4",
            thinking_level: "high",
            provider: "codex",
            visibility: "private",
            max_concurrent_tasks: 4,
          },
        },
      ]);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("agent edit rejects empty and invalid updates before sending a request", async () => {
    await expect(runMultiremi(["agent", "edit", "agt_1"], { programName: "multiremi" }))
      .rejects.toThrow("no fields to edit");
    await expect(runMultiremi([
      "agent",
      "edit",
      "agt_1",
      "--visibility",
      "public",
    ], { programName: "multiremi" })).rejects.toThrow("--visibility must be private or workspace");
    await expect(runMultiremi([
      "agent",
      "edit",
      "agt_1",
      "--max-concurrent-tasks",
      "51",
    ], { programName: "multiremi" })).rejects.toThrow("between 1 and 50");
  });
});
