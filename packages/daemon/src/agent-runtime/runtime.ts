/**
 * AgentRuntime — unified assembly layer for both Remi (persistent) and
 * Multiremi (ephemeral) agent sessions.
 *
 * Transforms a RuntimeContext into an AgentSessionConfig via a declarative
 * pipeline of CapabilityBlock modules.
 */

import type {
  AgentSessionConfig,
  RuntimeContext,
  CapabilityBlock,
} from "./types.js";
import { workspaceBlock } from "./capabilities/workspace.js";
import { envBlock } from "./capabilities/env.js";
import { mcpBlock } from "./capabilities/mcp.js";
import { promptsBlock } from "./capabilities/prompts.js";
import { identityBlock } from "./capabilities/identity.js";
import { permissionsBlock } from "./capabilities/permissions.js";

const CAPABILITIES: CapabilityBlock[] = [
  workspaceBlock,
  envBlock,
  mcpBlock,
  promptsBlock,
  identityBlock,
  permissionsBlock,
];

export class AgentRuntime {
  assemble(ctx: RuntimeContext): AgentSessionConfig {
    const method = ctx.kind;
    const parts = CAPABILITIES
      .map((cap) => cap[method]?.(ctx as any))
      .filter(Boolean);
    return Object.assign({} as AgentSessionConfig, ...parts);
  }
}
