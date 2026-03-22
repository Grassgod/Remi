/**
 * AgentRunner — spawn Claude Code CLI for background agents.
 *
 * Each agent runs as a one-shot `claude -p "prompt"` process
 * with its own cwd (agents/{name}/) for isolated CLAUDE.md + skills.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { AGENTS } from "./registry.js";
import type { AgentConfig, AgentRunResult } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("agent-runner");

/** Project root — where agents/ directory lives. */
const PROJECT_ROOT = resolve(join(import.meta.dir, "..", ".."));

export class AgentRunner {
  /**
   * Run an agent with a prompt, collect output, write JSONL log.
   */
  async run(agentName: string, prompt: string): Promise<AgentRunResult> {
    const config = AGENTS[agentName];
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    const agentDir = join(PROJECT_ROOT, "agents", agentName);
    if (!existsSync(agentDir)) {
      throw new Error(`Agent directory not found: ${agentDir}`);
    }

    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    const cmd = this._buildCommand(config, prompt);

    // Strip Claude env vars to avoid nested-session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    log.info(`Starting agent: ${agentName} (model=${config.model})`);

    const proc = Bun.spawn(cmd, {
      cwd: agentDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = config.timeoutMs ?? 600_000;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
      log.warn(`Agent ${agentName} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    clearTimeout(timeout);

    const durationMs = Date.now() - startTime;
    const exitCode = timedOut ? -1 : (proc.exitCode ?? 1);

    const result: AgentRunResult = {
      agent: agentName,
      exitCode,
      stdout,
      stderr,
      durationMs,
      timestamp,
    };

    if (exitCode !== 0) {
      log.error(
        `Agent ${agentName} exited with code ${exitCode} (${durationMs}ms)`,
        { stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) },
      );
    } else {
      log.info(`Agent ${agentName} completed in ${durationMs}ms`);
    }

    this._appendLog(agentName, result);

    return result;
  }

  private _buildCommand(config: AgentConfig, prompt: string): string[] {
    return [
      "claude",
      "--dangerously-skip-permissions",
      "--model", config.model,
      "--add-dir", join(homedir(), ".remi"),
      "--mcp-config", join(homedir(), ".mcp.json"),
      "-p", prompt,
    ];
  }

  private _appendLog(agentName: string, result: AgentRunResult): void {
    try {
      const logsDir = join(
        homedir(),
        ".remi",
        "agents",
        agentName,
        "runs",
      );
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      const logFile = join(logsDir, `${today}.jsonl`);

      const entry = JSON.stringify({
        ts: result.timestamp,
        agent: result.agent,
        model: AGENTS[agentName]?.model,
        exit: result.exitCode,
        duration_ms: result.durationMs,
        stdout_len: result.stdout.length,
        stderr_len: result.stderr.length,
      });

      appendFileSync(logFile, entry + "\n", "utf-8");
    } catch (e) {
      log.warn("Failed to write agent log:", e);
    }
  }
}
