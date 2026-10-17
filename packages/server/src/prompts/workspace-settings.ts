import type {
  MultiremiPromptSettings,
  MultiremiWorkspace,
  UpdateMultiremiPromptSettingsInput,
} from "@multiremi/contracts/types.js";
import { LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT, mergedWorkspacePrompt } from "@multiremi/contracts/remi-rules.js";

/** Bootstrap and delta used to allow 8,000 characters each; the merged prompt keeps both and the blank line between them. */
export const MAX_WORKSPACE_PROMPT_LENGTH = 8_000 + 2 + 8_000;

/**
 * Remi's former default bootstrap prompt (ADR 0023). Its rules are now part of
 * the Remi notes the daemon writes into every session's `AGENTS.md`; the server
 * still puts it ahead of the workspace's own text for daemons from before.
 */
export const DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT = LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT;

/** `prompt_appendix` holds the workspace's own text only; the two legacy keys are folded into it. */
export const WORKSPACE_PROMPT_KEYS = {
  prompt: "prompt_appendix",
  /** The revision `prompt_appendix` was written or folded at; an older image bumps only `prompt_revision`. */
  promptRevision: "prompt_appendix_revision",
  legacyBootstrap: "prompt_bootstrap_appendix",
  legacyDelta: "prompt_delta_appendix",
  revision: "prompt_revision",
  updatedAt: "prompt_updated_at",
  updatedBy: "prompt_updated_by",
} as const;
const KEYS = WORKSPACE_PROMPT_KEYS;

/**
 * The stored workspace prompt. Settings saved before ADR 0023, or edited on an
 * older image after a rollback (it bumps `prompt_revision` and writes only the
 * two legacy keys), read as their two prompts merged.
 */
export function readWorkspacePromptSettings(workspace: MultiremiWorkspace): MultiremiPromptSettings {
  const settings = workspace.settings ?? {};
  return {
    prompt: currentPrompt(settings)
      ?? mergedWorkspacePrompt(readString(settings[KEYS.legacyBootstrap]), readString(settings[KEYS.legacyDelta])),
    revision: readRevision(settings[KEYS.revision]),
    updatedAt: readString(settings[KEYS.updatedAt]),
    updatedBy: readString(settings[KEYS.updatedBy]),
  };
}

/**
 * Settings with the two legacy prompt keys folded into `prompt_appendix`, or
 * null when there is nothing to fold. A stored bootstrap prompt that begins
 * with Remi's former default keeps only what follows it. The legacy keys stay,
 * so an image from before reads what it always read.
 */
export function foldLegacyWorkspacePrompts(settings: Record<string, unknown>): Record<string, unknown> | null {
  if (currentPrompt(settings) !== null) return null;
  if (!(KEYS.legacyBootstrap in settings) && !(KEYS.legacyDelta in settings)) return null;
  return { ...settings,
    [KEYS.prompt]: mergedWorkspacePrompt(readString(settings[KEYS.legacyBootstrap]), readString(settings[KEYS.legacyDelta])),
    [KEYS.promptRevision]: readRevision(settings[KEYS.revision]) };
}

/** `prompt_appendix`, unless an older image changed the legacy keys after it was written. */
function currentPrompt(settings: Record<string, unknown>): string | null {
  const prompt = readString(settings[KEYS.prompt]);
  if (prompt === null) return null;
  const derivedAt = settings[KEYS.promptRevision];
  // Without the mark it was written before the mark existed, by this image: it is current.
  return derivedAt === undefined || readRevision(derivedAt) >= readRevision(settings[KEYS.revision]) ? prompt : null;
}

/** What an image from before ADR 0023 reads: Remi's former default with the workspace's text after it. */
function legacyPromptKeys(prompt: string): Record<string, string> {
  return {
    [KEYS.legacyBootstrap]: [DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT, prompt].filter(Boolean).join("\n\n"),
    [KEYS.legacyDelta]: "",
  };
}

/**
 * What `/api/workspaces/:id/prompts` returns: the prompt, plus the two fields a
 * web from before ADR 0023 reads, in the shape its tab expects (Remi's former
 * default with the workspace's text after it, and an empty delta). Its save
 * sends them back and they merge into the one prompt again.
 */
export function workspacePromptsResponse(prompts: MultiremiPromptSettings): MultiremiPromptSettings & { bootstrapPrompt: string; deltaPrompt: string } {
  return { ...prompts, bootstrapPrompt: legacyPromptKeys(prompts.prompt)[KEYS.legacyBootstrap]!, deltaPrompt: "" };
}

export function mergeWorkspacePromptSettings(
  workspace: MultiremiWorkspace,
  input: UpdateMultiremiPromptSettingsInput,
  updatedBy: string | null,
  updatedAt: string,
): { settings: Record<string, unknown>; prompts: MultiremiPromptSettings } {
  const current = readWorkspacePromptSettings(workspace);
  const expectedRevision = input.expectedRevision ?? input.expected_revision;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error("expected_revision must be a non-negative integer");
  }
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new WorkspacePromptRevisionConflictError(expectedRevision, current.revision);
  }

  const settings = workspace.settings ?? {};
  const legacyBootstrap = input.bootstrapPrompt ?? input.bootstrap_prompt;
  const legacyDelta = input.deltaPrompt ?? input.delta_prompt;
  // Clients from before ADR 0023 send the two prompts; they are stored as one. A client that sends only one
  // (an old CLI's `--delta-prompt`) keeps the other as stored: the legacy keys stay in step with the prompt.
  const prompt = input.prompt !== undefined
    ? normalizePrompt(input.prompt, "prompt").trim()
    : legacyBootstrap !== undefined || legacyDelta !== undefined
      ? mergedWorkspacePrompt(
        legacyBootstrap === undefined
          ? readString(settings[KEYS.legacyBootstrap]) ?? current.prompt
          : normalizePrompt(legacyBootstrap, "bootstrap_prompt"),
        legacyDelta === undefined
          ? readString(settings[KEYS.legacyDelta]) ?? ""
          : normalizePrompt(legacyDelta, "delta_prompt"))
      : current.prompt;
  validatePromptLength("prompt", prompt);

  const changed = prompt !== current.prompt;
  if (!changed) return { settings: workspace.settings, prompts: current };

  const prompts: MultiremiPromptSettings = {
    prompt,
    revision: current.revision + 1,
    updatedAt,
    updatedBy,
  };
  return {
    settings: {
      ...settings,
      // Kept in step for a rollback to an image from before ADR 0023.
      ...legacyPromptKeys(prompts.prompt),
      [KEYS.prompt]: prompts.prompt,
      [KEYS.promptRevision]: prompts.revision,
      [KEYS.revision]: prompts.revision,
      [KEYS.updatedAt]: prompts.updatedAt,
      [KEYS.updatedBy]: prompts.updatedBy,
    },
    prompts,
  };
}

export class WorkspacePromptRevisionConflictError extends Error {
  readonly code = "workspace_prompt_revision_conflict";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super("Workspace prompts changed after they were loaded");
    this.name = "WorkspacePromptRevisionConflictError";
  }
}

function normalizePrompt(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.replace(/\r\n?/g, "\n");
}

function validatePromptLength(field: string, value: string): void {
  if (Array.from(value).length > MAX_WORKSPACE_PROMPT_LENGTH) {
    throw new Error(`${field} must be ${MAX_WORKSPACE_PROMPT_LENGTH} characters or fewer`);
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRevision(value: unknown): number {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}
