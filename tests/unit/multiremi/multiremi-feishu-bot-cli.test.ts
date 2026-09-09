import { describe, expect, it } from "bun:test";
import { dispatch } from "../../../apps/remi/cli/index.js";

describe("Feishu bot route CLI", () => {
  it("executes route list/set/unset and chat list against the advertised API", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let routes: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "PUT" ? await request.json() : null;
        requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/cli/capabilities") {
          return Response.json({
            commands: ["feishu.route.list", "feishu.route.set", "feishu.route.unset", "feishu.chat.list"]
              .map((id) => ({ id, allowed: true })),
          });
        }
        if (url.pathname === "/api/agents") {
          return Response.json([{ id: "agt_broad", name: "Broad" }]);
        }
        if (url.pathname === "/api/workspaces/ws_cli/feishu-bot/routes" && request.method === "GET") {
          return Response.json({ workspace_id: "ws_cli", routes });
        }
        if (url.pathname === "/api/workspaces/ws_cli/feishu-bot/routes" && request.method === "PUT") {
          routes = ((body as { routes: Array<Record<string, unknown>> }).routes ?? []).map((route, index) => ({
            id: `fbr_${index}`,
            ...route,
          }));
          return Response.json({ workspace_id: "ws_cli", routes });
        }
        if (url.pathname === "/api/workspaces/ws_cli/feishu-bot/chats") {
          return Response.json({
            workspace_id: "ws_cli",
            chats: [{ name: "Roadmap", chat_id: "oc_roadmap", member_count: 7, chat_mode: "group" }],
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    const connection = [
      "--server", `http://127.0.0.1:${server.port}`,
      "--token", "tok_cli",
      "--workspace", "ws_cli",
      "--output", "json",
    ];
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      await dispatch(["feishu", "route", "set", "group_default", "--agent", "Broad", ...connection]);
      await dispatch(["feishu", "route", "list", ...connection]);
      await dispatch(["feishu", "chat", "list", ...connection]);
      await dispatch(["feishu", "route", "unset", "group_default", ...connection]);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }

    expect(JSON.parse(logs[0]!).routes).toEqual([expect.objectContaining({
      scope: "group_default",
      agent_id: "agt_broad",
    })]);
    expect(JSON.parse(logs[1]!).routes).toHaveLength(1);
    expect(JSON.parse(logs[2]!).chats).toEqual([
      { name: "Roadmap", chat_id: "oc_roadmap", member_count: 7, chat_mode: "group" },
    ]);
    expect(JSON.parse(logs[3]!).routes).toEqual([]);
    expect(requests.filter((request) => request.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/api/workspaces/ws_cli/feishu-bot/routes",
        body: {
          routes: [{ scope: "group_default", chat_id: null, chat_name: null, agent_id: "agt_broad" }],
        },
      },
      {
        method: "PUT",
        path: "/api/workspaces/ws_cli/feishu-bot/routes",
        body: { routes: [] },
      },
    ]);
    expect(requests).toContainEqual({
      method: "GET",
      path: "/api/agents?workspace_id=ws_cli",
      body: null,
    });
    expect(requests).toContainEqual({
      method: "GET",
      path: "/api/workspaces/ws_cli/feishu-bot/chats",
      body: null,
    });
  });
});
