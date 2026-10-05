/** Shared by workspace defaults and the current Chat runtime appendix. */
export const CHAT_ARTIFACT_DELIVERY_CONTRACT = `Chat supports attachment delivery through \`remi message send --attachment <path>\`; repeat \`--attachment\` for multiple files. The current conversation identifies the destination; no Feishu chat ID is needed.
- Attach files the user explicitly requested, reports longer than one screen, and charts. Send plain-text conclusions without attachments when no file is needed.
- Do not attach repository source code, raw logs, configuration containing secrets, or files larger than 20MB. The server validates allowed file types and size before queueing delivery.
- For HTML, produce a self-contained file with inline CSS and JavaScript and no external stylesheet, script, or font URLs; do not depend on localStorage, cookies, or parent-frame access.
- Report the attachment IDs and filenames returned by the command. A workspace path alone is not a delivered attachment.
- Incoming Chat attachments are listed with local paths when available. Read those files directly; otherwise use the listed \`remi attachment download\` command. Use lark-cli download only as a fallback when platform attachment access is unavailable.`;

export const ARTIFACT_DELIVERY_CONTRACT = `## Artifact Delivery Contract

When a task produces a viewable artifact (HTML page, chart, diagram, rendered report):
- In an Issue, attach it to the reply message with \`remi message send <issue> --content <summary> --attachment <path>\`. Report the message ID and attachment filename.
- Never deliver by workspace path alone. Short diagrams may go in the comment body as fenced Mermaid or HTML; use attachments for full pages and shareable reports.

${CHAT_ARTIFACT_DELIVERY_CONTRACT}`;
