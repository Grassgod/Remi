import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, resolveTaskWorkDir, type ResolvedTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { acquireWorkspaceSupervisorLease, activeWorkspaceSupervisorPids } from "@daemon/agent-runtime/workspace/process-owner.js";

const workspace = process.argv[2]!;
if (homedir() !== process.env.HOME || userInfo().homedir !== process.env.HOME) {
  throw new Error("The lock fixture requires both home resolvers to use its temporary startup HOME");
}
let supervisor: ReturnType<typeof acquireWorkspaceSupervisorLease> | undefined;
let runtime: ResolvedTaskWorkDir | undefined;

function reply(value: object): void {
  console.log(`MUL512 ${JSON.stringify(value)}`);
}

async function acquireRuntime(abortWhenBusy: boolean): Promise<object> {
  const controller = new AbortController();
  let waited = false;
  const task = {
    id: `task-${process.pid}`, workspaceId: "fixture", runtimeWorkspaceId: "runtime",
    runtimeWorkspace: {
      id: "runtime", workspaceId: "fixture", daemonId: "daemon", rootPath: workspace,
      cwd: ".", archivedAt: null,
    },
  } as unknown as AgentTask;
  try {
    // Deliberately use defaults: the regression concerns their shared registry.
    runtime = await resolveTaskWorkDir(task, {
      daemonIds: ["daemon"], workspacesRoot: join(process.env.MULTIREMI_STATE_DIR!, "workspaces"),
      locker: new LocalPathLocker(), signal: controller.signal,
      onWaitLocalDirectory: () => {
        waited = true;
        if (abortWhenBusy) controller.abort();
      },
    });
    return { acquired: true, waited, workDir: runtime.workDir };
  } catch (error) {
    return { acquired: false, waited, errorCode: (error as { code?: string }).code };
  }
}

const input = createInterface({ input: process.stdin });
reply({ ready: true, pid: process.pid });
try {
  for await (const line of input) {
    const { op } = JSON.parse(line) as { op: string };
    try {
      switch (op) {
        case "supervisor-acquire":
          supervisor = acquireWorkspaceSupervisorLease(workspace);
          reply({ acquired: true, lockPath: supervisor.lockPath });
          break;
        case "supervisor-release":
          supervisor?.release(); supervisor = undefined;
          reply({ released: true });
          break;
        case "owners": reply({ pids: activeWorkspaceSupervisorPids() }); break;
        case "runtime-acquire": reply(await acquireRuntime(false)); break;
        case "runtime-contend": reply(await acquireRuntime(true)); break;
        case "runtime-release":
          runtime?.release?.(); runtime = undefined;
          reply({ released: true });
          break;
        case "stop": input.close(); reply({ stopped: true }); process.exitCode = 0; break;
        default: throw new Error(`Unknown fixture command: ${op}`);
      }
    } catch (error) {
      reply({ acquired: false, errorCode: (error as { code?: string }).code, error: String(error) });
    }
    if (op === "stop") break;
  }
} finally {
  supervisor?.release();
  runtime?.release?.();
  input.close();
}
