import { describe, expect, it } from "bun:test";
import { buildPlatformPromptTemplatePreview } from "@multiremi/prompts/platform-template.js";

describe("platform prompt template preview (ADR 0023)", () => {
  it("renders the session's AGENTS.md and one turn's input through the real builder", () => {
    const preview = buildPlatformPromptTemplatePreview();

    // The Agent's definition first, then Remi's notes.
    expect(preview.instructions.startsWith("# {{agent_name}}\n\n{{agent_instructions}}\n\n# Remi\n")).toBe(true);
    for (const section of [
      "## Remi CLI",
      "## Delivery\nWhen a task changes code:",
      "## Workspace Instructions\n{{workspace_prompt}}",
      "## Workspace Context\n{{workspace_context}}",
      "## Requesting User\nName: {{requesting_user_name}}\n{{requesting_user_profile}}",
      "## Autopilot Context",
      "## Quick Create Request\n{{quick_create_prompt}}",
      "## Issue\nKey: {{issue_key}}",
      "{{issue_description}}",
      "## Issue Metadata",
      "## Bound Issue\nThis Feishu topic is bound to {{issue_key}} — {{issue_title}} (status when this turn started: {{issue_status}}).",
      "remi issue get {{issue_id}} --output json",
      "## Replying to Comments",
      "--reply-to <comment-id> --content-stdin",
      "## Sharing Results Across Sessions",
      "## Issue Workspace Session History",
      "## Issue Execution and Escalation",
      "## Squad Coordination",
      "## Repository Availability Warnings",
      "## Project Context",
      "## Project Instructions\n{{project_instructions}}",
      "## Project Knowledge",
      "## Available Repositories",
    ]) expect(preview.instructions).toContain(section);
    for (const removed of ["# Bootstrap Prompt", "# Delta Prompt", "## Current Request", "## Current Turn", "## Skills",
      "{{skill_content}}", "## Inbox", "Published Results", "## Chat Message", "Write the summary from the log", "{{session_jsonl}}"]) {
      expect(preview.instructions).not.toContain(removed);
      expect(preview.input).not.toContain(removed);
    }

    // The turn: the labelled message, the unread sentence, the comment to reply to, the trigger payload, attachments.
    expect(preview.input.startsWith("[{{trigger_author_name}}] {{message_body}}\n\n")).toBe(true);
    expect(preview.input).toContain("(1 earlier unread message isn't shown here. Read it before you answer: `remi message list {{chat_session_id}} --from 0 --to 2`)");
    expect(preview.input).toContain("(Reply to comment {{trigger_comment_id}}: `remi message send {{issue_session_id}} --kind reply --reply-to {{trigger_comment_id}}`.)");
    expect(preview.input).toContain("Trigger payload:");
    expect(preview.input).toContain("- {{chat_attachment_filename}}: run `remi attachment download {{chat_attachment_id}} --output-dir <dir>`");
    expect(preview.input).not.toContain("{{agent_instructions}}");
    // The preview is a Feishu topic: a Chat, so it has no Issue-round finishing note.
    expect(preview.instructions).not.toContain("## Finishing");
    expect(preview.sha256.instructions).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.sha256.input).toMatch(/^[a-f0-9]{64}$/);
  });
});
