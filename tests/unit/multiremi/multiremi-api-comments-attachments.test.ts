// Comment threads and reactions over HTTP, the local attachment file lifecycle,
// and the Go-style attachment access/delete authz boundaries.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — comments, reactions, and attachments", () => {
  it("serves original agent, skill file, chat, and inbox compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const alice = store.createWorkspaceMember({ name: "Original Alice" });
    const bob = store.createWorkspaceMember({ name: "Original Bob" });
    const runtime = store.registerRuntime({
      id: "rt_original_compat",
      name: "Original runtime",
      provider: "codex",
      models: [{
        id: "gpt-original",
        label: "GPT Original",
        provider: "openai",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
        },
      }],
    });

    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Original Codex",
        provider: "codex",
        runtime_id: runtime.id,
        custom_env: { SECRET_TOKEN: "real-value" },
        custom_args: ["--sandbox"],
        mcp_config: { mcpServers: { local: { command: "secret-command" } } },
        thinking_level: "high",
      }),
    });
    const agent = await createdAgent.json();
    expect(createdAgent.status).toBe(201);
    expect(agent.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.provider).toBe("codex");
    expect(Object.keys(agent).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(agent).toMatchObject({
      workspace_id: "local",
      runtime_id: "",
      max_concurrent_tasks: 6,
      has_custom_env: true,
      custom_env_key_count: 1,
      custom_args: ["--sandbox"],
      thinking_level: "high",
      skills: [],
    });
    expect(agent.custom_env).toBeUndefined();
    expect(agent.customEnv).toBeUndefined();
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const envThroughGenericUpdate = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { ROTATED_TOKEN: "new-value" }, custom_args: ["--updated"], thinking_level: "low" }),
    });
    expect(envThroughGenericUpdate.status).toBe(400);
    expect(await envThroughGenericUpdate.json()).toEqual({
      error: "custom_env is no longer accepted on this endpoint; use PUT /api/agents/{id}/env (or `multiremi agent env set`)",
    });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const updatedAgent = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_args: ["--updated"], thinking_level: "low" }),
    });
    const updatedAgentBody = await updatedAgent.json();
    expect(updatedAgentBody).toMatchObject({
      id: agent.id,
      has_custom_env: true,
      custom_env_key_count: 1,
      custom_args: ["--updated"],
      thinking_level: "low",
    });
    expect(updatedAgentBody.custom_env).toBeUndefined();
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const updatedEnv = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ROTATED_TOKEN: "new-value" } }),
    });
    expect(updatedEnv.status).toBe(200);
    expect((await updatedEnv.json()).custom_env).toEqual({ SECRET_TOKEN: "real-value", ROTATED_TOKEN: "new-value" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", ROTATED_TOKEN: "new-value" });

    const archived = await app.request(`/api/agents/${agent.id}/archive`, { method: "POST" });
    expect((await archived.json()).archived_at).toBeString();
    const restored = await app.request(`/api/agents/${agent.id}/restore`, { method: "POST" });
    expect((await restored.json()).archived_at).toBeNull();

    const skill = store.createSkill({ name: "Original Skill", content: "# Skill" });
    const missingSkillFiles = await app.request("/api/skills/skl_missing/files");
    expect(missingSkillFiles.status).toBe(404);
    expect(await missingSkillFiles.json()).toEqual({ error: "skill not found" });

    const invalidFileJson = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidFileJson.status).toBe(400);
    expect(await invalidFileJson.json()).toEqual({ error: "invalid request body" });

    const invalidFilePath = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../../../escape.md", content: "Nope" }),
    });
    expect(invalidFilePath.status).toBe(400);
    expect(await invalidFilePath.json()).toEqual({ error: "invalid file path" });

    const reservedFilePath = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "SKILL.md", content: "Nope" }),
    });
    expect(reservedFilePath.status).toBe(400);
    expect(await reservedFilePath.json()).toEqual({ error: "SKILL.md is reserved for the primary skill content" });

    const file = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/check.md", content: "Check" }),
    });
    const fileBody = await file.json();
    expect(fileBody.path).toBe("notes/check.md");
    expect(fileBody.skill_id).toBe(skill.id);
    expect(fileBody.skillId).toBeUndefined();
    const files = await app.request(`/api/skills/${skill.id}/files`);
    const filesBody = await files.json();
    expect(filesBody[0].content).toBe("Check");
    expect(filesBody[0].skill_id).toBe(skill.id);

    const chat = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "Original chat" }),
    });
    const chatBody = await chat.json();
    expect(chatBody.agent_id).toBe(agent.id);
    const sent = await app.request(`/api/chat/sessions/${chatBody.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello original" }),
    });
    const sentBody = await sent.json();
    expect(Object.keys(sentBody).sort()).toEqual(["created_at", "message_id", "task_id"]);
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBe(chatBody.id);
    const pending = await app.request(`/api/chat/sessions/${chatBody.id}/pending-task`);
    expect((await pending.json()).task_id).toBe(sentBody.task_id);
    const pendingAll = await app.request("/api/chat/pending-tasks");
    expect((await pendingAll.json()).tasks[0].chat_session_id).toBe(chatBody.id);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}/read`, { method: "POST" })).status).toBe(204);

    const issue = store.createIssue({ title: "Original inbox", createdBy: alice.id });
    store.addIssueSubscriber(issue.id, bob.id);
    store.createIssueComment(issue.id, { authorType: "member", authorId: alice.id, body: "Ping Bob" });
    const camelInbox = await app.request(`/api/inbox?memberId=${encodeURIComponent(bob.id)}`);
    expect(await camelInbox.json()).toEqual([]);
    expect((await (await app.request(`/api/inbox/unread-count?memberId=${encodeURIComponent(bob.id)}`)).json()).count).toBe(0);
    const inbox = await app.request(`/api/inbox?member_id=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody[0].member_id).toBe(bob.id);
    expect((await (await app.request(`/api/inbox/unread-count?member_id=${encodeURIComponent(bob.id)}`)).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/mark-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/archive-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await app.request(`/api/skills/${skill.id}/files/${fileBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await app.request(`/api/agents/${agent.id}/cancel-tasks`, { method: "POST" })).json()).cancelled).toBe(0);
  });

  it("serves comment threads, reactions, and attachments through API", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "API collaboration" });

    const issueAttachment = await app.request(`/api/multiremi/issues/${issue.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "design.png",
        url: "https://example.com/design.png",
        contentType: "image/png",
        sizeBytes: 1024,
        uploaderType: "member",
        uploaderId: "local",
      }),
    });
    expect(issueAttachment.status).toBe(201);
    const issueAttachmentBody = await issueAttachment.json();
    expect(issueAttachmentBody.attachment.issueId).toBe(issue.id);

    const root = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Root API comment" }),
    });
    const rootBody = await root.json();
    const originalComment = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Original API comment" }),
    });
    const originalCommentBody = await originalComment.json();
    expect(originalComment.status).toBe(201);
    expect(originalCommentBody.content).toBe("Original API comment");
    expect(originalCommentBody.issue_id).toBe(issue.id);
    expect(originalCommentBody.body).toBeUndefined();
    expect(originalCommentBody.issueId).toBeUndefined();
    expect(originalCommentBody.comment).toBeUndefined();

    const pendingAttachment = store.createAttachment({
      filename: "reply.md",
      url: "https://example.com/reply.md",
      uploaderType: "member",
      uploaderId: "local",
    });
    const reply = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Reply API comment", parentId: rootBody.comment.id, attachmentIds: [pendingAttachment.id] }),
    });
    const replyBody = await reply.json();
    expect(replyBody.comment.parentId).toBe(rootBody.comment.id);
    expect(replyBody.comment.attachments[0].id).toBe(pendingAttachment.id);

    const edited = await app.request(`/api/comments/${replyBody.comment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Edited API reply" }),
    });
    const editedBody = await edited.json();
    expect(editedBody.content).toBe("Edited API reply");
    expect(editedBody.comment).toBeUndefined();
    expect(editedBody.body).toBeUndefined();
    expect(editedBody.parent_id).toBe(rootBody.comment.id);
    expect(editedBody.parentId).toBeUndefined();

    const invalidCommentCreate = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCommentCreate.status).toBe(400);
    expect(await invalidCommentCreate.json()).toEqual({ error: "invalid request body" });

    const emptyCommentCreate = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(emptyCommentCreate.status).toBe(400);
    expect(await emptyCommentCreate.json()).toEqual({ error: "content is required" });

    const resolved = await app.request(`/api/multiremi/comments/${rootBody.comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorType: "member", actorId: "local" }),
    });
    expect((await resolved.json()).comment.resolvedAt).toBeString();

    const unresolved = await app.request(`/api/comments/${rootBody.comment.id}/resolve`, { method: "DELETE" });
    const unresolvedBody = await unresolved.json();
    expect(unresolvedBody.resolved_at).toBeNull();
    expect(unresolvedBody.comment).toBeUndefined();
    expect(unresolvedBody.resolvedAt).toBeUndefined();

    const compatibilityResolved = await app.request(`/api/comments/${rootBody.comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    const compatibilityResolvedBody = await compatibilityResolved.json();
    expect(compatibilityResolvedBody.resolved_at).toBeString();
    expect(compatibilityResolvedBody.resolved_by_type).toBe("member");
    expect(compatibilityResolvedBody.resolvedByType).toBeUndefined();

    const invalidReplyResolve = await app.request(`/api/comments/${replyBody.comment.id}/resolve`, { method: "POST" });
    expect(invalidReplyResolve.status).toBe(400);
    expect(await invalidReplyResolve.json()).toEqual({ error: "only root comments can be resolved" });

    const issueReaction = await app.request(`/api/multiremi/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👍", actor_type: "member", actor_id: "local" }),
    });
    expect((await issueReaction.json()).reaction.emoji).toBe("👍");
    const issueReactions = await (await app.request(`/api/issues/${issue.id}/reactions`)).json();
    expect(issueReactions[0].emoji).toBe("👍");
    expect(issueReactions[0].issueId).toBeUndefined();
    expect(issueReactions[0].issue_id).toBe(issue.id);
    expect(issueReactions[0].actorType).toBeUndefined();
    expect(issueReactions[0].actor_type).toBe("member");
    const originalIssueReaction = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "🚀", actorType: "member", actorId: "local" }),
    });
    const originalIssueReactionBody = await originalIssueReaction.json();
    expect(originalIssueReaction.status).toBe(201);
    expect(originalIssueReactionBody.issueId).toBeUndefined();
    expect(originalIssueReactionBody.issue_id).toBe(issue.id);
    expect(originalIssueReactionBody.actorType).toBeUndefined();
    expect(originalIssueReactionBody.actor_type).toBe("member");
    const invalidIssueReaction = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidIssueReaction.status).toBe(400);
    expect(await invalidIssueReaction.json()).toEqual({ error: "invalid request body" });
    const missingIssueEmoji = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    expect(missingIssueEmoji.status).toBe(400);
    expect(await missingIssueEmoji.json()).toEqual({ error: "emoji is required" });
    const metadata = await app.request(`/api/issues/${issue.id}/metadata/original_path`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect((await metadata.json()).original_path).toBe(true);
    expect((await (await app.request(`/api/issues/${issue.id}/metadata`)).json()).original_path).toBe(true);
    const issueAttachments = await (await app.request(`/api/issues/${issue.id}/attachments`)).json();
    expect(issueAttachments[0].id).toBe(issueAttachmentBody.attachment.id);
    expect(issueAttachments[0].download_url).toBe(`/api/attachments/${issueAttachmentBody.attachment.id}/download`);

    const commentReaction = await app.request(`/api/multiremi/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀", actorType: "agent", actorId: "agt-api" }),
    });
    expect((await commentReaction.json()).reaction.emoji).toBe("👀");
    const originalCommentReaction = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "✅", actorType: "member", actorId: "local" }),
    });
    const originalCommentReactionBody = await originalCommentReaction.json();
    expect(originalCommentReactionBody.emoji).toBe("✅");
    expect(originalCommentReactionBody.commentId).toBeUndefined();
    expect(originalCommentReactionBody.comment_id).toBe(replyBody.comment.id);
    expect(originalCommentReactionBody.workspace_id).toBeUndefined();
    expect(originalCommentReactionBody.actorType).toBeUndefined();
    expect(originalCommentReactionBody.actor_type).toBe("member");
    const invalidCommentReaction = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCommentReaction.status).toBe(400);
    expect(await invalidCommentReaction.json()).toEqual({ error: "invalid request body" });
    const missingCommentEmoji = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    expect(missingCommentEmoji.status).toBe(400);
    expect(await missingCommentEmoji.json()).toEqual({ error: "emoji is required" });

    const detail = await app.request(`/api/multiremi/issues/${issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.reactions).toHaveLength(2);
    expect(detailBody.issue.attachments).toHaveLength(1);
    expect(detailBody.comments.find((comment: any) => comment.id === replyBody.comment.id).reactions).toHaveLength(2);

    const timeline = await app.request(`/api/issues/${issue.id}/timeline`);
    const timelineBody = await timeline.json();
    const timelineIds = timelineBody.map((entry: any) => entry.id);
    expect(timelineIds).toContain(rootBody.comment.id);
    expect(timelineIds).toContain(replyBody.comment.id);
    const replyEntry = timelineBody.find((entry: any) => entry.id === replyBody.comment.id);
    expect(replyEntry.actorType).toBeUndefined();
    expect(replyEntry.actor_type).toBe("member");
    expect(replyEntry.parentId).toBeUndefined();
    expect(replyEntry.parent_id).toBe(rootBody.comment.id);
    expect(replyEntry.commentType).toBeUndefined();
    expect(replyEntry.comment_type).toBe("comment");
    expect(replyEntry.attachments[0].id).toBe(pendingAttachment.id);
    expect(replyEntry.attachments[0].commentId).toBeUndefined();
    expect(replyEntry.attachments[0].comment_id).toBe(replyBody.comment.id);
    expect(replyEntry.attachments[0].downloadUrl).toBeUndefined();
    expect(replyEntry.attachments[0].download_url).toBe(`/api/attachments/${pendingAttachment.id}/download`);
    expect(replyEntry.reactions).toHaveLength(2);
    expect(replyEntry.reactions[0].actorType).toBeUndefined();
    expect(replyEntry.reactions[0].actor_type).toBeDefined();
    expect(replyEntry.reactions[0].comment_id).toBe(replyBody.comment.id);
    expect(replyEntry.reactions[0].workspace_id).toBeUndefined();
    for (let index = 1; index < timelineBody.length; index++) {
      expect(timelineBody[index - 1].created_at <= timelineBody[index].created_at).toBe(true);
    }

    const compatibilityWrappedTimeline = await app.request(`/api/issues/${issue.id}/timeline?limit=50&around=${encodeURIComponent(rootBody.comment.id)}`);
    const compatibilityWrappedTimelineBody = await compatibilityWrappedTimeline.json();
    expect(compatibilityWrappedTimelineBody.entries[0].actorType).toBeUndefined();
    expect(compatibilityWrappedTimelineBody.entries[0].actor_type).toBeDefined();
    expect(compatibilityWrappedTimelineBody.entries[compatibilityWrappedTimelineBody.target_index].id).toBe(rootBody.comment.id);

    const wrappedTimeline = await app.request(`/api/multiremi/issues/${issue.id}/timeline?limit=50&around=${encodeURIComponent(rootBody.comment.id)}`);
    const wrappedTimelineBody = await wrappedTimeline.json();
    expect(wrappedTimelineBody.next_cursor).toBeNull();
    expect(wrappedTimelineBody.prev_cursor).toBeNull();
    expect(wrappedTimelineBody.has_more_before).toBe(false);
    expect(wrappedTimelineBody.has_more_after).toBe(false);
    expect(wrappedTimelineBody.entries[0].createdAt).toBeDefined();
    expect(wrappedTimelineBody.entries[wrappedTimelineBody.target_index].id).toBe(rootBody.comment.id);
    for (let index = 1; index < wrappedTimelineBody.entries.length; index++) {
      expect(wrappedTimelineBody.entries[index - 1].created_at <= wrappedTimelineBody.entries[index].created_at).toBe(true);
    }

    const deleteTarget = store.createIssueComment(issue.id, { body: "Compatibility delete target" });
    const compatibilityDeleted = await app.request(`/api/comments/${deleteTarget.id}`, { method: "DELETE" });
    expect(compatibilityDeleted.status).toBe(204);
    expect(await compatibilityDeleted.text()).toBe("");
    const missingDelete = await app.request(`/api/comments/${deleteTarget.id}`, { method: "DELETE" });
    expect(missingDelete.status).toBe(404);
    expect(await missingDelete.json()).toEqual({ error: "comment not found" });

    const deleted = await app.request(`/api/multiremi/comments/${replyBody.comment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getIssueComment(replyBody.comment.id)).toBeNull();
  });

  it("uploads, downloads, and deletes local attachment files", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Upload API" });
    const form = new FormData();
    form.append("file", new File(["hello upload"], "note.txt", { type: "text/plain" }));
    form.append("issue_id", issue.id);
    form.append("workspace_id", "local");

    const uploaded = await app.request("/api/upload-file", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const uploadedBody = await uploaded.json();
    expect(uploadedBody.attachment.issueId).toBe(issue.id);
    expect(uploadedBody.attachment.url).toStartWith("/api/attachments/");
    expect(uploadedBody.issue_id).toBe(issue.id);
    expect(uploadedBody.download_url).toBe(`/api/attachments/${uploadedBody.attachment.id}/download`);
    expect(store.listAttachmentsForIssue(issue.id)[0]?.filename).toBe("note.txt");

    const meta = await app.request(`/api/attachments/${uploadedBody.attachment.id}`);
    const metaBody = await meta.json();
    expect(metaBody.attachment.filename).toBe("note.txt");
    expect(metaBody.download_url).toBe(`/api/attachments/${uploadedBody.attachment.id}/download`);

    const content = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toContain("text/plain");
    expect(await content.text()).toBe("hello upload");

    const download = await app.request(`/api/attachments/${uploadedBody.attachment.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("note.txt");
    expect(await download.text()).toBe("hello upload");

    const deleted = await app.request(`/api/attachments/${uploadedBody.attachment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getAttachment(uploadedBody.attachment.id)).toBeNull();

    const missing = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(missing.status).toBe(404);
  });

  it("enforces Go-style attachment access boundaries", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const remoteWorkspace = store.createWorkspace({ id: "ws_att_remote", name: "Att Remote", slug: "att-remote" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "peer-user", name: "Peer", role: "member" });
    const remoteToken = await store.createAccessToken({ name: "remote", type: "pat", workspaceId: remoteWorkspace.id });
    const localToken = await store.createAccessToken({ name: "local", type: "pat", workspaceId: "local", userId: "local" });
    const peerToken = await store.createAccessToken({ name: "peer", type: "pat", workspaceId: "local", userId: "peer-user" });

    // A token scoped to another workspace gets Go's anti-enumeration 404 across read/serve/delete.
    const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

    // Issue attachment in the local workspace.
    const issue = store.createIssue({ title: "Att issue", workspaceId: "local" });
    const issueForm = new FormData();
    issueForm.append("file", new File(["issue secret"], "issue.txt", { type: "text/plain" }));
    issueForm.append("issue_id", issue.id);
    issueForm.append("workspace_id", "local");
    const issueUpload = await app.request("/api/upload-file", { method: "POST", body: issueForm, ...auth(localToken.token) });
    const issueAttId = (await issueUpload.json()).attachment.id;
    expect((await app.request(`/api/attachments/${issueAttId}`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/attachments/${issueAttId}/content`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/attachments/${issueAttId}/download`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/attachments/${issueAttId}`, auth(remoteToken.token))).status).toBe(404);
    const crossDelete = await app.request(`/api/attachments/${issueAttId}`, { method: "DELETE", ...auth(remoteToken.token) });
    expect(crossDelete.status).toBe(404);
    expect(store.getAttachment(issueAttId)).not.toBeNull();

    // A same-workspace token can read the issue attachment.
    const okContent = await app.request(`/api/attachments/${issueAttId}/content`, auth(localToken.token));
    expect(okContent.status).toBe(200);
    expect(await okContent.text()).toBe("issue secret");

    // Chat attachment uploaded by the creator.
    const agent = store.createAgent({ name: "Chat", provider: "claude", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private" });
    const chatForm = new FormData();
    chatForm.append("file", new File(["chat secret"], "chat.txt", { type: "text/plain" }));
    chatForm.append("chat_session_id", chat.id);
    const chatUpload = await app.request("/api/upload-file", { method: "POST", body: chatForm, ...auth(localToken.token) });
    expect(chatUpload.status).toBe(200);
    const chatAttId = (await chatUpload.json()).attachment.id;

    // A different workspace member cannot read another user's private chat attachment.
    expect((await app.request(`/api/attachments/${chatAttId}/content`, auth(peerToken.token))).status).toBe(403);
    expect((await app.request(`/api/attachments/${chatAttId}/download`, auth(peerToken.token))).status).toBe(403);
    expect((await app.request(`/api/attachments/${chatAttId}`, { method: "DELETE", ...auth(peerToken.token) })).status).toBe(403);
    expect(store.getAttachment(chatAttId)).not.toBeNull();

    // The chat creator can read their own attachment.
    const creatorRead = await app.request(`/api/attachments/${chatAttId}/content`, auth(localToken.token));
    expect(creatorRead.status).toBe(200);
    expect(await creatorRead.text()).toBe("chat secret");
  });

  it("enforces Go-style attachment delete authz and listing/upload workspace gates", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

    store.createWorkspaceMember({ id: "mem_local_alice", workspaceId: "local", name: "Alice", email: "alice@x.com", role: "member" });
    store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", name: "Bob", email: "bob@x.com", role: "member" });
    store.createWorkspaceMember({ id: "mem_local_carol", workspaceId: "local", name: "Carol", email: "carol@x.com", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "bob", type: "pat", workspaceId: "local", userId: "bob" });
    const carolToken = await store.createAccessToken({ name: "carol", type: "pat", workspaceId: "local", userId: "carol" });

    const issue = store.createIssue({ title: "Delete authz", workspaceId: "local" });
    const seed = () => store.createAttachment({
      issueId: issue.id, workspaceId: "local", uploaderType: "member", uploaderId: "alice",
      filename: "secret.txt", url: "/api/attachments/seed/content", contentType: "text/plain", sizeBytes: 5,
    });

    // DELETE authz (Go file.go DeleteAttachment: uploader or workspace admin/owner only).
    const att1 = seed();
    expect((await app.request(`/api/attachments/${att1.id}`, { method: "DELETE", ...auth(bobToken.token) })).status).toBe(403);
    expect(store.getAttachment(att1.id)).not.toBeNull();
    expect((await app.request(`/api/attachments/${att1.id}`, { method: "DELETE", ...auth(aliceToken.token) })).status).toBe(200);
    expect(store.getAttachment(att1.id)).toBeNull();
    const att2 = seed();
    expect((await app.request(`/api/attachments/${att2.id}`, { method: "DELETE", ...auth(carolToken.token) })).status).toBe(200);
    expect(store.getAttachment(att2.id)).toBeNull();

    // Cross-workspace metadata enumeration is blocked on listing + detail routes.
    const remoteWorkspace = store.createWorkspace({ id: "ws_att_remote2", name: "Remote2", slug: "att-remote2" });
    const remoteToken = await store.createAccessToken({ name: "remote2", type: "pat", workspaceId: remoteWorkspace.id });
    seed();
    const comment = store.createIssueComment(issue.id, { body: "c", authorType: "member", authorId: "mem_local_alice" });
    store.createAttachment({
      commentId: comment.id, issueId: issue.id, workspaceId: "local", uploaderType: "member", uploaderId: "alice",
      filename: "c.txt", url: "/api/attachments/seedc/content", contentType: "text/plain", sizeBytes: 1,
    });
    expect((await app.request(`/api/issues/${issue.id}/attachments?workspace_id=local`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/issues/${issue.id}/attachments`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/comments/${comment.id}/attachments`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/issues/${issue.id}?workspace_id=local`, auth(remoteToken.token))).status).toBe(404);
    // The same-workspace owner still sees them.
    expect((await app.request(`/api/issues/${issue.id}/attachments`, auth(carolToken.token))).status).toBe(200);

    // Cross-workspace upload is blocked (Go requires workspace membership before writing).
    const form = new FormData();
    form.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    form.append("issue_id", issue.id);
    form.append("workspace_id", "local");
    expect((await app.request("/api/upload-file", { method: "POST", body: form, ...auth(remoteToken.token) })).status).toBe(404);
    const bareCreate = await app.request("/api/multiremi/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${remoteToken.token}` },
      body: JSON.stringify({ workspaceId: "local", filename: "x.txt", url: "/x", contentType: "text/plain", sizeBytes: 1 }),
    });
    expect(bareCreate.status).toBe(404);
  });
});
