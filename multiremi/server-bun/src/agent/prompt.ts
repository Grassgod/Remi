/**
 * Task prompt builder for the ACP executor. The Go daemon's prompt is CLI-driven
 * (it tells the agent to run `multimira issue get` / `comment list`); the Bun
 * executor instead EMBEDS the task context directly in the prompt, since the
 * unified ACP agents receive their context in the prompt rather than fetching it
 * over a CLI + task token (not ported). Pure + deterministic so it unit-tests
 * cleanly; the executor resolves the DB rows and calls this.
 */

export interface PromptIssue {
  identifier: string;
  title: string;
  description?: string | null;
  status: string;
  acceptanceCriteria?: unknown;
}

export interface PromptComment {
  author: string;
  content: string;
}

export interface BuildPromptOptions {
  /** The agent's standing instructions (persona / how to work). */
  instructions?: string | null;
  /** The issue the task is about. */
  issue?: PromptIssue | null;
  /** Recent comments, chronological (oldest → newest). */
  comments?: PromptComment[];
  /** True when a comment @mention triggered this task. */
  triggeredByComment?: boolean;
}

/** Acceptance criteria are stored as a jsonb array; keep the string entries. */
function stringCriteria(ac: unknown): string[] {
  if (!Array.isArray(ac)) return [];
  return ac.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** Assemble the agent prompt from the task context. Never empty. */
export function buildTaskPrompt(opts: BuildPromptOptions): string {
  const parts: string[] = [];

  if (opts.instructions?.trim()) parts.push(opts.instructions.trim());

  if (opts.issue) {
    const i = opts.issue;
    const lines = [`# Task: ${i.identifier} — ${i.title}`, `Status: ${i.status}`];
    if (i.description?.trim()) lines.push("", i.description.trim());
    const ac = stringCriteria(i.acceptanceCriteria);
    if (ac.length) {
      lines.push("", "## Acceptance criteria");
      for (const c of ac) lines.push(`- ${c}`);
    }
    parts.push(lines.join("\n"));
  }

  if (opts.comments && opts.comments.length > 0) {
    const lines = ["## Conversation"];
    for (const c of opts.comments) lines.push(`[${c.author}]: ${c.content}`);
    parts.push(lines.join("\n"));
  }

  if (opts.triggeredByComment) {
    parts.push("You were mentioned in the most recent comment above — read the conversation and respond.");
  }

  return parts.join("\n\n").trim() || "Proceed.";
}
