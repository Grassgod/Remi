const ACP_CLAUDE_PROVIDER = "acp:claude";
const ACP_CODEX_PROVIDER = "acp:codex";
const CLAUDE_CLI_PROVIDER = "claude_cli";

const ACP_CLAUDE_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);

const CLAUDE_CLI_MODES = new Set([
  "bypassPermissions",
  "plan",
  "default",
  "acceptEdits",
]);

export interface SwitchTarget {
  providerName: string;
  mode: string | null;
  storedMode: string | null;
  modeLabel: string;
}

export function parseSwitchArgs(args: string): { providerAlias: string; modeArg?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { providerAlias: "" };
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { providerAlias: trimmed };
  return {
    providerAlias: trimmed.slice(0, idx),
    modeArg: trimmed.slice(idx + 1),
  };
}

export function resolveSwitchProviderAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  const aliases: Record<string, string> = {
    claude: ACP_CLAUDE_PROVIDER,
    acp: ACP_CLAUDE_PROVIDER,
    "acp:claude": ACP_CLAUDE_PROVIDER,
    codex: ACP_CODEX_PROVIDER,
    "acp:codex": ACP_CODEX_PROVIDER,
    cli: CLAUDE_CLI_PROVIDER,
    claude_cli: CLAUDE_CLI_PROVIDER,
  };
  return aliases[normalized] ?? normalized;
}

export function defaultSwitchMode(providerName: string): string | null {
  if (providerName === ACP_CLAUDE_PROVIDER || providerName === "acp") return "bypassPermissions";
  if (providerName === CLAUDE_CLI_PROVIDER) return "bypassPermissions";
  return null;
}

export function normalizeSwitchMode(mode: string | null | undefined): string | null {
  const trimmed = typeof mode === "string" ? mode.trim() : "";
  if (!trimmed) return null;
  if (trimmed === "bypass") return "bypassPermissions";
  return trimmed;
}

export function isKnownSwitchMode(providerName: string, mode: string): boolean {
  if (providerName === ACP_CLAUDE_PROVIDER || providerName === "acp") {
    return ACP_CLAUDE_MODES.has(mode);
  }
  if (providerName === CLAUDE_CLI_PROVIDER) {
    return CLAUDE_CLI_MODES.has(mode);
  }
  return true;
}

export function availableSwitchModes(providerName: string): string[] {
  if (providerName === ACP_CLAUDE_PROVIDER || providerName === "acp") {
    return [...ACP_CLAUDE_MODES];
  }
  if (providerName === CLAUDE_CLI_PROVIDER) {
    return [...CLAUDE_CLI_MODES];
  }
  return [];
}

export function providerLabel(providerName: string): string {
  if (providerName === ACP_CLAUDE_PROVIDER || providerName === "acp") return "ACP Claude";
  if (providerName === ACP_CODEX_PROVIDER) return "ACP Codex";
  if (providerName === CLAUDE_CLI_PROVIDER) return "Claude CLI";
  return providerName;
}

export function buildSwitchTarget(providerAlias: string, modeArg?: string): SwitchTarget {
  const providerName = resolveSwitchProviderAlias(providerAlias);
  const defaultMode = defaultSwitchMode(providerName);
  const mode = normalizeSwitchMode(modeArg) ?? defaultMode;
  if (!mode) {
    return { providerName, mode: null, storedMode: null, modeLabel: "agent default" };
  }
  const storedMode = mode === defaultMode ? null : mode;
  return {
    providerName,
    mode,
    storedMode,
    modeLabel: mode === "bypassPermissions" ? "bypass" : mode,
  };
}
