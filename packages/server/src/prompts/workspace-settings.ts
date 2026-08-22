import type {
  MultiremiPromptSettings,
  MultiremiWorkspace,
  UpdateMultiremiPromptSettingsInput,
} from "@multiremi/contracts/types.js";

export const MAX_WORKSPACE_PROMPT_LENGTH = 8_000;

export const DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT = `## Code Delivery Contract

When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.`;

const KEYS = {
  bootstrap: "prompt_bootstrap_appendix",
  delta: "prompt_delta_appendix",
  revision: "prompt_revision",
  updatedAt: "prompt_updated_at",
  updatedBy: "prompt_updated_by",
} as const;

export function readWorkspacePromptSettings(workspace: MultiremiWorkspace): MultiremiPromptSettings {
  const settings = workspace.settings ?? {};
  return {
    bootstrapPrompt: readString(settings[KEYS.bootstrap]) ?? DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT,
    deltaPrompt: readString(settings[KEYS.delta]) ?? "",
    revision: readRevision(settings[KEYS.revision]),
    updatedAt: readString(settings[KEYS.updatedAt]),
    updatedBy: readString(settings[KEYS.updatedBy]),
  };
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

  const bootstrapPrompt = normalizePrompt(
    input.bootstrapPrompt ?? input.bootstrap_prompt ?? current.bootstrapPrompt,
    "bootstrap_prompt",
  );
  const deltaPrompt = normalizePrompt(
    input.deltaPrompt ?? input.delta_prompt ?? current.deltaPrompt,
    "delta_prompt",
  );
  validatePromptLength("bootstrap_prompt", bootstrapPrompt);
  validatePromptLength("delta_prompt", deltaPrompt);

  const changed = bootstrapPrompt !== current.bootstrapPrompt || deltaPrompt !== current.deltaPrompt;
  if (!changed) return { settings: workspace.settings, prompts: current };

  const prompts: MultiremiPromptSettings = {
    bootstrapPrompt,
    deltaPrompt,
    revision: current.revision + 1,
    updatedAt,
    updatedBy,
  };
  return {
    settings: {
      ...workspace.settings,
      [KEYS.bootstrap]: prompts.bootstrapPrompt,
      [KEYS.delta]: prompts.deltaPrompt,
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
