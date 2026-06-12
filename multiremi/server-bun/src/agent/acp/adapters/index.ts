export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./base.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { GenericAcpAdapter } from "./generic.js";

import type { AgentAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GenericAcpAdapter } from "./generic.js";

// The 12 agent types that the Go backend implemented as 12 separate per-agent
// packages (pkg/agent/{claude,codex,copilot,opencode,openclaw,hermes,gemini,
// pi,cursor,kimi,kiro,antigravity}.go) — each speaking a different protocol
// (stream-json / app-server / json / acp). Here they ALL collapse onto the one
// unified AcpProvider: each agent type resolves to a single ACP adapter that
// names the agent's ACP entrypoint (native CLI, native flag, or ACP bridge).
//
// ACP launch entrypoint per agent. CRITICAL: an ACP CLI must be launched with
// the args that put it into ACP stdio JSON-RPC server mode — spawning the bare
// binary launches its interactive REPL and AcpClient.initialize() hangs. The
// args below for hermes/kimi/kiro are ported VERBATIM from the Go backend
// (pkg/agent/{hermes,kimi,kiro}.go), which is the ground-truth entrypoint.
//
// Tier:
//   - bridge      : a dedicated ACP bridge binary that speaks ACP when run bare
//                   (claude→claude-agent-acp, codex→codex-acp)
//   - native-flag : the agent's own CLI speaks ACP behind a flag/subcommand
//                   (gemini, hermes, kimi, kiro, opencode, cursor, copilot,
//                    openclaw) — verbatim from Go where Go drove it via ACP
//   - unverified  : no confirmed first-party ACP entrypoint; routed generically
//                   so an operator can override `executable`/`args` with a real
//                   bridge. These will NOT work until configured (pi, antigravity).
const adapters: Record<string, () => AgentAdapter> = {
  // bridge
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  // native-flag — ACP subcommand/flag required (else initialize() hangs).
  gemini: () =>
    new GenericAcpAdapter({ agentType: "gemini", executable: "gemini", args: ["--experimental-acp"] }),
  hermes: () => new GenericAcpAdapter({ agentType: "hermes", executable: "hermes", args: ["acp"] }),
  kimi: () => new GenericAcpAdapter({ agentType: "kimi", executable: "kimi", args: ["acp"] }),
  kiro: () =>
    new GenericAcpAdapter({ agentType: "kiro", executable: "kiro-cli", args: ["acp", "--trust-all-tools"] }),
  // opencode's Go backend used `opencode run --format json` (non-ACP); routed
  // here through opencode's ACP mode (opencode.ai/docs/acp).
  opencode: () => new GenericAcpAdapter({ agentType: "opencode", executable: "opencode", args: ["acp"] }),
  // cursor's Go backend used cursor-agent stream-json; ACP via the cursor-agent
  // ACP subcommand (newer builds) or the `cursor-agent-acp` npx bridge.
  cursor: () => new GenericAcpAdapter({ agentType: "cursor", executable: "cursor-agent", args: ["acp"] }),
  copilot: () => new GenericAcpAdapter({ agentType: "copilot", executable: "copilot", args: ["--acp"] }),
  openclaw: () => new GenericAcpAdapter({ agentType: "openclaw", executable: "openclaw", args: ["acp"] }),
  // unverified — no confirmed ACP entrypoint; override executable/args to use.
  pi: () => new GenericAcpAdapter({ agentType: "pi", executable: "pi" }),
  antigravity: () => new GenericAcpAdapter({ agentType: "antigravity", executable: "agy" }),
};

export function createAdapter(agentType: string): AgentAdapter {
  const factory = adapters[agentType];
  if (!factory) {
    throw new Error(
      `Unknown agent type: ${agentType}. Available: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return factory();
}

/** Agent types currently drivable through the unified ACP provider. */
export function supportedAgentTypes(): string[] {
  return Object.keys(adapters);
}
