import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpClient } from "@acp/index.js";
import { AntigravityProvider } from "@acp/antigravity.js";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import type { AgentTask } from "@daemon/contracts/types.js";

for (const provider of ["acp", "antigravity"] as const) {
  it(`${provider} final spawn removes a legacy task ID inherited from the parent and overlays`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "task-spawn-env-"));
    const capture = join(directory, "ids.json");
    const script = join(directory, "agent.js");
    const original = process.env.MULTIREMI_TASK_ID;
    process.env.MULTIREMI_TASK_ID = "tsk_parent_sentinel";
    const overlay = buildTaskEnv({ id: "tsk_probe", turn_id: "turn_probe", attempt_id: "tsk_probe",
      workspaceId: "local", repos: [], workspaceEnv: { MULTIREMI_TASK_ID: "tsk_workspace_sentinel" },
      agent: { customEnv: { MULTIREMI_TASK_ID: "tsk_agent_sentinel" } },
    } as unknown as AgentTask, { daemonPort: 1, serverUrl: "http://127.0.0.1" });
    writeFileSync(script, `
      await Bun.write(process.env.TEST_ID_CAPTURE, JSON.stringify({
        turn: process.env.MULTIREMI_TURN_ID, attempt: process.env.MULTIREMI_ATTEMPT_ID,
        old: process.env.MULTIREMI_TASK_ID,
      }));
      ${provider === "acp" ? "await new Promise(() => {});" : ""}
    `);
    const env = { ...overlay, TEST_ID_CAPTURE: capture, MULTIREMI_TASK_ID: "tsk_overlay_sentinel" };
    const client = provider === "acp"
      ? new AcpClient({ executable: process.execPath, args: [script], env })
      : new AntigravityProvider({ executable: process.execPath, args: [script], env });
    try {
      if (client instanceof AcpClient) await client.start();
      else expect(await client.healthCheck()).toBe(true);
      const deadline = performance.now() + 2000;
      while (!existsSync(capture)) {
        if (performance.now() > deadline) throw new Error("Child did not capture its environment");
        await Bun.sleep(5);
      }
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({ turn: "turn_probe", attempt: "tsk_probe" });
    } finally {
      if (client instanceof AcpClient) await client.stop();
      else await client.close();
      if (original === undefined) delete process.env.MULTIREMI_TASK_ID;
      else process.env.MULTIREMI_TASK_ID = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
