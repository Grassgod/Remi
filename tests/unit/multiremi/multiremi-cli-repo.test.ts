// `multiremi repo checkout` does not clone anything itself: it relays to the local
// daemon over MULTIREMI_DAEMON_PORT and prints the path the daemon returns.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi CLI — repo checkout relay", () => {
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
});
