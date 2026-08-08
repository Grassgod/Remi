/**
 * Multiremi CLI — `repo` command handler.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { type CliOptions, stringOpt } from "../options.js";

export async function repo(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action !== "checkout") throw new Error("usage: multiremi repo checkout <url> [--ref <branch-or-sha>]");
  const repoUrl = positional[1]?.trim();
  if (!repoUrl) throw new Error("usage: multiremi repo checkout <url> [--ref <branch-or-sha>]");
  const daemonPort = stringOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT);
  if (!daemonPort) {
    throw new Error("MULTIREMI_DAEMON_PORT not set (this command is intended to run inside a Multiremi daemon task)");
  }
  const workDir = process.cwd();
  const response = await fetch(`http://127.0.0.1:${daemonPort}/repo/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: repoUrl,
      workspace_id: stringOpt(options.workspace ?? options["workspace-id"], process.env.MULTIREMI_WORKSPACE_ID) ?? "",
      workdir: workDir,
      ref: stringOpt(options.ref, undefined) ?? "",
      agent_name: stringOpt(options.agentName ?? options["agent-name"], process.env.MULTIREMI_AGENT_NAME) ?? "",
      task_id: stringOpt(options.taskId ?? options["task-id"], process.env.MULTIREMI_TASK_ID) ?? "",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`checkout failed: ${text}`);
  const result = JSON.parse(text) as { path?: string; branch_name?: string };
  if (!result.path) throw new Error(`checkout failed: invalid daemon response ${text}`);
  console.log(result.path);
  console.error(`Checked out ${repoUrl} -> ${result.path}${result.branch_name ? ` (branch: ${result.branch_name})` : ""}`);
}
