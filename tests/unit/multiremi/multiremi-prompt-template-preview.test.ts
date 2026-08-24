import { describe, expect, it } from "bun:test";
import { buildPlatformPromptTemplatePreview } from "@multiremi/prompts/platform-template.js";

describe("platform prompt template preview", () => {
  it("renders both modes through the real prompt builder with runtime placeholders", () => {
    const preview = buildPlatformPromptTemplatePreview();

    expect(preview.bootstrap).toContain("# Bootstrap Prompt");
    expect(preview.bootstrap).toContain("## Current Request\n{{current_request}}");
    expect(preview.bootstrap).toContain("## Workspace Context\n{{workspace_context}}");
    expect(preview.bootstrap).toContain("## Requesting User");
    expect(preview.bootstrap).toContain("## Chat Message\n{{chat_message}}");
    expect(preview.bootstrap).toContain("## Autopilot Context");
    expect(preview.bootstrap).toContain("## Quick Create Request\n{{quick_create_prompt}}");
    expect(preview.bootstrap).toContain("## Workspace Bootstrap Instructions\n{{workspace_bootstrap_prompt}}");
    expect(preview.bootstrap).toContain("## Current Session Context");
    expect(preview.bootstrap).toContain("{{session_jsonl}}");
    expect(preview.bootstrap).toContain("## Published Results From Other Sessions");
    expect(preview.bootstrap).toContain("## Issue Workspace Session History");
    expect(preview.bootstrap).toContain("## Sharing Results Across Sessions");
    expect(preview.bootstrap).toContain("## Issue\nKey: {{issue_key}}");
    expect(preview.bootstrap).toContain("{{issue_description}}");
    expect(preview.bootstrap).toContain("## Issue Metadata");
    expect(preview.bootstrap).toContain("## Triggering Comment");
    expect(preview.bootstrap).toContain("--parent {{trigger_comment_id}}");
    expect(preview.bootstrap).toContain("## Repository Availability Warnings");
    expect(preview.bootstrap).toContain("## Project Context");
    expect(preview.bootstrap).toContain("## Project Instructions\n{{project_instructions}}");
    expect(preview.bootstrap).toContain("## Project Knowledge");
    expect(preview.bootstrap).toContain("## Available Repositories");
    expect(preview.bootstrap).toContain("## Squad Coordination");
    expect(preview.bootstrap).toContain("## Agent Instructions\n{{agent_instructions}}");
    expect(preview.bootstrap).toContain("## Skills");
    expect(preview.bootstrap).toContain("## Output");

    expect(preview.delta).toContain("# Delta Prompt");
    expect(preview.delta).toContain("## Requesting User");
    expect(preview.delta).toContain("## Chat Message\n{{chat_message}}");
    expect(preview.delta).toContain("## Autopilot Context");
    expect(preview.delta).toContain("## Quick Create Request\n{{quick_create_prompt}}");
    expect(preview.delta).toContain("## Workspace Delta Instructions\n{{workspace_delta_prompt}}");
    expect(preview.delta).toContain("## Current Session Context");
    expect(preview.delta).toContain("## Issue\nKey: {{issue_key}}");
    expect(preview.delta).toContain("## Triggering Comment");
    expect(preview.delta).toContain("## Repository Availability Warnings");
    expect(preview.delta).toContain("## Project Delta Instructions\n{{project_delta_instructions}}");
    expect(preview.delta).toContain("## New Published Results From Other Sessions");
    expect(preview.delta).not.toContain("{{issue_description}}");
    expect(preview.delta).not.toContain("{{agent_instructions}}");
    expect(preview.delta).not.toContain("## Available Repositories");
    expect(preview.delta).not.toContain("## Output");

    expect(preview.bootstrap).not.toContain("Create a PR.");
    expect(preview.delta).not.toContain("Check new comments.");
    expect(preview.sha256.bootstrap).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.sha256.delta).toMatch(/^[a-f0-9]{64}$/);
  });
});
