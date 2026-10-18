/**
 * Remi's own rules for agents (ADR 0023). They used to be the default text of
 * the workspace bootstrap prompt, where saving the settings froze them; they
 * are now part of the Remi notes the daemon writes into every session's
 * `AGENTS.md`, and the workspace prompt holds only the workspace's own text.
 */
import { LEGACY_WORKSPACE_DEFAULTS, WORKSPACE_DEFAULT_V3 } from "./legacy-workspace-prompts.js";

export const CODE_DELIVERY_CONTRACT = `When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.`;

export const REMI_CLI_COMMUNICATION = "Use `remi message` for communication, `remi inbox` to read addressed messages, and `remi turn` to inspect or control execution.";

/**
 * The workspace bootstrap prompt's built-in default before ADR 0023, frozen.
 * Older daemons still receive it in `workspace_bootstrap_prompt`, and the
 * legacy settings key keeps it in front of the workspace's text.
 */
export const LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT = WORKSPACE_DEFAULT_V3;

/** A stored workspace prompt without whichever former default it begins with (the longest that matches). */
export function customWorkspacePrompt(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\r\n?/g, "\n").trim();
  const legacy = LEGACY_WORKSPACE_DEFAULTS.map(entry => entry.trim()).find(entry => text === entry || text.startsWith(`${entry}\n`));
  return legacy ? text.slice(legacy.length).trim() : text;
}

/** Bootstrap and delta workspace prompts as one, the way ADR 0023 stores them. */
export function mergedWorkspacePrompt(bootstrap: string | null | undefined, delta: string | null | undefined): string {
  return [customWorkspacePrompt(bootstrap), (delta ?? "").replace(/\r\n?/g, "\n").trim()].filter(Boolean).join("\n\n");
}

/**
 * Bootstrap and delta instructions used to allow 4,000 characters each; the
 * merged field keeps both and the blank line between them (ADR 0023).
 */
export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 4_000 + 2 + 4_000;

/** Thrown when a client from before sends both halves and together they exceed the one field's limit. */
export const PROJECT_INSTRUCTIONS_TOO_LONG = `instructions and delta_instructions together must be ${MAX_PROJECT_INSTRUCTIONS_LENGTH} characters or fewer`;

/** A Project's former bootstrap and delta instructions as its one instructions field. */
export function joinProjectInstructions(instructions: string, delta: string | null | undefined): string {
  return delta?.trim() ? [instructions.trimEnd(), delta.trim()].filter(Boolean).join("\n\n") : instructions;
}
