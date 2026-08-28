const DEFAULT_CONTEXT_WINDOW = 64_000;
const DEFAULT_BUDGET_SHARE = 0.32;
const DEFAULT_MIN_BUDGET = 4_096;

const PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  antigravity: 1_000_000,
  claude: 200_000,
  codex: 400_000,
  copilot: 128_000,
  cursor: 128_000,
  gemini: 1_000_000,
  hermes: 128_000,
  kiro: 200_000,
  kimi: 128_000,
  multiremi_agent: DEFAULT_CONTEXT_WINDOW,
  openclaw: 128_000,
  opencode: DEFAULT_CONTEXT_WINDOW,
  other: DEFAULT_CONTEXT_WINDOW,
  pi: DEFAULT_CONTEXT_WINDOW,
};

const MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-5|codex/i, 400_000],
  [/claude/i, 200_000],
  [/\bo[134](?:-|$)/i, 200_000],
  [/kimi/i, 128_000],
];

export interface ResolveProjectionTokenBudgetInput {
  provider: string | null | undefined;
  model: string | null | undefined;
  degradeLevel: number;
}

/**
 * Reserve most of the model window for instructions, issue context, tools and
 * the agent's own execution. Operators can override the share, floor, and
 * provider/model windows without rebuilding the server.
 */
export function resolveProjectionTokenBudget(input: ResolveProjectionTokenBudgetInput): number {
  const provider = String(input.provider ?? "").trim().toLowerCase();
  const model = String(input.model ?? "").trim().toLowerCase();
  const windows = projectionContextWindowOverrides();
  const contextWindow = positiveInteger(
    windows[`${provider}:${model}`]
      ?? windows[model]
      ?? windows[provider]
      ?? windows.default,
  ) ?? resolveBuiltInContextWindow(provider, model);
  const share = boundedNumber(
    process.env.MULTIREMI_SESSION_PROJECTION_BUDGET_SHARE,
    DEFAULT_BUDGET_SHARE,
    0.01,
    0.9,
  );
  const minimum = positiveInteger(process.env.MULTIREMI_SESSION_PROJECTION_MIN_TOKENS)
    ?? DEFAULT_MIN_BUDGET;
  const degradeLevel = Math.max(0, Math.floor(Number(input.degradeLevel) || 0));
  const base = Math.max(1, Math.floor(contextWindow * share));
  return Math.max(minimum, Math.floor(base * (0.5 ** degradeLevel)));
}

/** Conservative heuristic: CJK uses one token per character; everything else uses 3.5 chars. */
export function estimateProjectionTokens(value: string): number {
  let cjkCharacters = 0;
  let cjkCodeUnits = 0;
  for (const match of value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)) {
    cjkCharacters += 1;
    cjkCodeUnits += match[0].length;
  }
  return cjkCharacters + Math.ceil(Math.max(0, value.length - cjkCodeUnits) / 3.5);
}

function resolveBuiltInContextWindow(provider: string, model: string): number {
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (model && pattern.test(model)) return window;
  }
  return PROVIDER_CONTEXT_WINDOWS[provider] ?? DEFAULT_CONTEXT_WINDOW;
}

function projectionContextWindowOverrides(): Record<string, unknown> {
  const raw = process.env.MULTIREMI_SESSION_PROJECTION_CONTEXT_WINDOWS;
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
