/**
 * AgentRuntime — unified assembly layer for both Remi (persistent) and
 * Multiremi (ephemeral) agent sessions.
 *
 * Transforms a RuntimeContext into an AgentSessionConfig by dispatching to
 * the appropriate capability assemblers (workspace, env, mcp, prompts,
 * permissions, skills).
 */

import { homedir } from "node:os";
import type {
  AgentSessionConfig,
  PersistentContext,
  EphemeralContext,
  RuntimeContext,
  RecoveryConfig,
} from "./types.js";
import type { AcpMcpServer } from "./mcp/ephemeral.js";
import { buildTaskMcpServers } from "./mcp/ephemeral.js";
import { buildTaskEnv } from "./env/injector.js";
import type { McpServerEntry } from "../../shared/config.js";

export class AgentRuntime {
  assemble(ctx: RuntimeContext): AgentSessionConfig {
    return ctx.kind === "persistent"
      ? this.assemblePersistent(ctx)
      : this.assembleEphemeral(ctx);
  }

  private assemblePersistent(ctx: PersistentContext): AgentSessionConfig {
    const { message, config, groupConfig, memory, sessionRow } = ctx;

    // Workspace
    const cwd =
      groupConfig?.cwd ||
      groupConfig?.projectCwd ||
      sessionRow?.cwd ||
      (message.metadata?.cwd as string) ||
      homedir();

    // MCP — from remi.toml [[mcp.servers]]
    const agentType = groupConfig?.provider ?? config.provider.default;
    const mcpServers = configMcpToAcp(config.mcp, agentType);

    // Prompts
    const chatMeta = groupConfig?.injectChatContext
      ? `\n[chat_context] chatId=${message.chatId} sender=${message.sender} senderOpenId=${message.metadata?.senderOpenId ?? "unknown"}`
      : "";
    const memoryContext = memory.readMemory().trim();
    const promptParts = [
      memoryContext ? `# Memory\n${memoryContext}` : "",
      groupConfig?.systemPrompt ?? "",
      chatMeta,
    ].filter(Boolean);
    const systemPrompt = promptParts.length ? promptParts.join("\n\n") : undefined;

    // Session
    const sessionId = sessionRow?.session_id || undefined;

    // Permissions
    const permissionMode = sessionRow?.mode ?? null;

    // Recovery
    const recovery: RecoveryConfig = {
      retryOnStaleSession: true,
      retryOnPromptTooLong: true,
      fallbackAgentType: agentType === "claude" ? "codex" : null,
    };

    return {
      agentType,
      model: null,
      cwd,
      mcpServers,
      systemPrompt,
      context: memoryContext || undefined,
      chatId: ctx.sessionKey,
      sessionId,
      media: message.media,
      allowedTools: groupConfig?.allowedTools?.length ? groupConfig.allowedTools : undefined,
      addDirs: groupConfig?.addDirs?.length ? groupConfig.addDirs : undefined,
      permissionMode,
      permissionHandler: null,
      elicitationHandler: null,
      traceId: (message.metadata?.messageId as string) ?? undefined,
      recovery,
    };
  }

  private assembleEphemeral(ctx: EphemeralContext): AgentSessionConfig {
    const { task, daemonOptions, workDir, signal } = ctx;

    // Env
    const env = buildTaskEnv(task, {
      daemonPort: daemonOptions.daemonPort,
      serverUrl: daemonOptions.serverUrl,
      fallbackToken: daemonOptions.fallbackToken,
    });

    // MCP
    const mcpServers = buildTaskMcpServers(task);

    // Agent config
    const agent = task.agent;
    const agentType = agent?.provider ?? "claude";
    const executable = agent?.executable ?? undefined;
    const model = agent?.model ?? null;
    const allowedTools = agent?.allowedTools?.length ? agent.allowedTools : undefined;

    return {
      agentType,
      executable,
      model,
      cwd: workDir,
      env,
      mcpServers,
      allowedTools,
      chatId: task.id,
      sessionId: task.sessionId ?? undefined,
      permissionMode: "bypassPermissions",
      permissionHandler: null,
      elicitationHandler: null,
      signal,
    };
  }
}

/**
 * Convert remi.toml McpServerEntry[] to AcpMcpServer[], filtering by agent type.
 */
function configMcpToAcp(entries: McpServerEntry[], agentType: string): AcpMcpServer[] {
  return entries
    .filter((e) => !e.agents || e.agents.includes(agentType))
    .map((e) => {
      const server: AcpMcpServer = { name: e.name, command: e.command };
      if (e.args) server.args = e.args;
      if (e.env) server.env = e.env;
      return server;
    });
}
