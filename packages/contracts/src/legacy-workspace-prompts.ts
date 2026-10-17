/**
 * Every default the workspace bootstrap prompt shipped with before ADR 0023,
 * frozen as stored. Saving the settings froze the default in front of the
 * workspace's own text, so a stored prompt may begin with any of them; they
 * are stripped longest first, since each later one begins with the first.
 * Never edit these: they must match what is in the database.
 */

/** v1 (81a407f6b, layered workspace prompts): the code delivery contract. */
export const WORKSPACE_DEFAULT_V1 = `## Code Delivery Contract

When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.`;

/** v2 (15fa458d8): v1 with the artifact delivery contract. */
export const WORKSPACE_DEFAULT_V2 = `## Code Delivery Contract

When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.

## Artifact Delivery Contract

When a task produces a viewable artifact (HTML page, chart, diagram, rendered report):
- In an Issue, attach it to the reply comment with \`remi comment add <issue> --content <summary> --attachment <path>\`. Report the comment ID and attachment filename.
- Never deliver by workspace path alone. Short diagrams may go in the comment body as fenced Mermaid or HTML; use attachments for full pages and shareable reports.

Chat supports attachment delivery through \`remi chat attachment send --attachment <path>\`; repeat \`--attachment\` for multiple files. The current Task identifies the destination Chat; no Feishu chat ID is needed.
- Attach files the user explicitly requested, reports longer than one screen, and charts. Send plain-text conclusions without attachments when no file is needed.
- Do not attach repository source code, raw logs, configuration containing secrets, or files larger than 20MB. The server validates allowed file types and size before queueing delivery.
- For HTML, produce a self-contained file with inline CSS and JavaScript and no external stylesheet, script, or font URLs; do not depend on localStorage, cookies, or parent-frame access.
- Report the attachment IDs and filenames returned by the command. A workspace path alone is not a delivered attachment.
- Incoming Chat attachments are listed with local paths when available. Read those files directly; otherwise use the listed \`remi attachment download\` command. Use lark-cli download only as a fallback when platform attachment access is unavailable.`;

/** v2 after `scripts/migrations/rewrite-retired-cli-commands.ts` replaced its retired commands. */
export const WORKSPACE_DEFAULT_V2_REWRITTEN = `## Code Delivery Contract

When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.

## Artifact Delivery Contract

When a task produces a viewable artifact (HTML page, chart, diagram, rendered report):
- In an Issue, attach it to the reply comment with \`remi message send <conversation>\`. Report the comment ID and attachment filename.
- Never deliver by workspace path alone. Short diagrams may go in the comment body as fenced Mermaid or HTML; use attachments for full pages and shareable reports.

Chat supports attachment delivery through \`remi message send --attachment <path>\`; repeat \`--attachment\` for multiple files. The current Task identifies the destination Chat; no Feishu chat ID is needed.
- Attach files the user explicitly requested, reports longer than one screen, and charts. Send plain-text conclusions without attachments when no file is needed.
- Do not attach repository source code, raw logs, configuration containing secrets, or files larger than 20MB. The server validates allowed file types and size before queueing delivery.
- For HTML, produce a self-contained file with inline CSS and JavaScript and no external stylesheet, script, or font URLs; do not depend on localStorage, cookies, or parent-frame access.
- Report the attachment IDs and filenames returned by the command. A workspace path alone is not a delivered attachment.
- Incoming Chat attachments are listed with local paths when available. Read those files directly; otherwise use the listed \`remi attachment download\` command. Use lark-cli download only as a fallback when platform attachment access is unavailable.`;

/** v3 (106de13a4, unified CLI): the default until ADR 0023. */
export const WORKSPACE_DEFAULT_V3 = `## Code Delivery Contract

When a task changes code:
- Push the working branch and create a GitHub pull request or Codebase merge request before reporting completion.
- Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.
- Reuse an existing open PR/MR for the same source branch. Create at most one PR/MR per changed repository.
- Creating a PR/MR does not require approval. Merging it or pushing directly to the default branch requires explicit user authorization.
- Return every PR/MR URL in the final result. If creation fails, report the exact failure and preserve the pushed branch for recovery.
- Do not create empty PRs/MRs. A squad leader must ensure delegated code changes have a PR/MR before completing the parent task.

Use \`remi message\` for communication, \`remi inbox\` to read addressed messages, and \`remi turn\` to inspect or control execution.

## Artifact Delivery Contract

When a task produces a viewable artifact (HTML page, chart, diagram, rendered report):
- In an Issue, attach it to the reply message with \`remi message send <issue> --content <summary> --attachment <path>\`. Report the message ID and attachment filename.
- Never deliver by workspace path alone. Short diagrams may go in the comment body as fenced Mermaid or HTML; use attachments for full pages and shareable reports.

Chat supports attachment delivery through \`remi message send --attachment <path>\`; repeat \`--attachment\` for multiple files. The current conversation identifies the destination; no Feishu chat ID is needed.
- Attach files the user explicitly requested, reports longer than one screen, and charts. Send plain-text conclusions without attachments when no file is needed.
- Do not attach repository source code, raw logs, configuration containing secrets, or files larger than 20MB. The server validates allowed file types and size before queueing delivery.
- For HTML, produce a self-contained file with inline CSS and JavaScript and no external stylesheet, script, or font URLs; do not depend on localStorage, cookies, or parent-frame access.
- Report the attachment IDs and filenames returned by the command. A workspace path alone is not a delivered attachment.
- Incoming Chat attachments are listed with local paths when available. Read those files directly; otherwise use the listed \`remi attachment download\` command. Use lark-cli download only as a fallback when platform attachment access is unavailable.`;

/** Longest first: v1 is a prefix of the others. */
export const LEGACY_WORKSPACE_DEFAULTS: readonly string[] = [WORKSPACE_DEFAULT_V1, WORKSPACE_DEFAULT_V2,
  WORKSPACE_DEFAULT_V2_REWRITTEN, WORKSPACE_DEFAULT_V3].sort((left, right) => right.length - left.length);
