import { createResponsibleTestIssue } from "../multiremi/helpers.js";
import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpClient } from "@acp/index.js";
import { AntigravityProvider } from "@acp/antigravity.js";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { pendingTurnBackendTests } from "../multiremi/pending-turn-test-backends.js";
import { resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { daemonTurnOfferPayload } from "@multiremi/api/daemon-protocol/task-offers.js";
import { normalizeDaemonTurnOffer } from "@multiremi/worker/daemon-offers.js";

afterEach(resetMultiremiTestEnv);
pendingTurnBackendTests("Store offer to actual provider spawn", fixture => {
  for (const provider of ["acp", "antigravity"] as const) {
    it(`${provider} final spawn removes a legacy task ID inherited from the parent and overlays`, async () => {
      const { store } = fixture();
      const runtime = store.registerRuntime({ id: "rt_spawn", daemonId: "daemon_spawn", name: "Spawn", provider: "codex", workspaceId: "local" });
      const agent = store.createAgent({ name: "Spawn", provider: "codex", runtimeId: runtime.id });
      const issue = createResponsibleTestIssue(store, { title: "Store to spawn" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const seed = store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" },
        to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: "Spawn with real IDs" });
      // Exercise a replacement so the turn and attempt have distinct IDs.
      store.cancelTurn(seed.turn_id!);
      const turn = store.retryTurn(seed.turn_id!, true);
      const claimed = store.claimTask(runtime.id)!;
      expect(claimed.id).toBe(turn.current_attempt_id!);
      const task = store.getTaskWithAgent(claimed.id)!;
      const input = store.getDaemonTurnBridge().offerInput(task);
      const offered = normalizeDaemonTurnOffer(daemonTurnOfferPayload(
        daemonTaskClaimResponse(store, task, store.getTaskTriggerMetadata(task)), input));
      expect(offered.turn_id).not.toBe(offered.attempt_id);
      expect(offered.input_from_seq).toBe(0);
      expect(offered.input_messages.some(message => message.id === seed.message.id)).toBe(true);
      const directory = mkdtempSync(join(tmpdir(), "task-spawn-env-"));
      const capture = join(directory, "ids.json");
      const script = join(directory, "agent.js");
      const original = process.env.MULTIREMI_TASK_ID;
      process.env.MULTIREMI_TASK_ID = "tsk_parent_sentinel";
      const overlay = buildTaskEnv({ ...offered, workspaceEnv: { MULTIREMI_TASK_ID: "tsk_workspace_sentinel" },
        agent: { ...offered.agent, customEnv: { MULTIREMI_TASK_ID: "tsk_agent_sentinel" } },
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
        expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({ turn: turn.id, attempt: claimed.id });
      } finally {
        if (client instanceof AcpClient) await client.stop();
        else await client.close();
        if (original === undefined) delete process.env.MULTIREMI_TASK_ID;
        else process.env.MULTIREMI_TASK_ID = original;
        rmSync(directory, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
