/**
 * claude-agent-acp 0.90 reduced to the subagent patch's anchors (dist/acp-agent.js:
 * the session's `NativeSubagentRuntime` with its publish callback, and the SDK
 * `task_started` case). Executable: `run` builds a session's runtime, then
 * replays SDK task messages and announcements through the patched code.
 */
export const CLAUDE_SUBAGENT_BOUNDARY = `
    async runSession(params, session, NativeSubagentRuntime, subagentForm, asSdkSessionNotification, messages, announce) {
        const subagents = (session.nativeSubagentRuntime ??= new NativeSubagentRuntime(subagentForm(this.clientCapabilities), params.sessionId, session, async (notification) => this.client.sessionUpdate(asSdkSessionNotification(notification)), this.logger));
        for (const message of messages) {
            switch (message.subtype) {
                case "task_started":
                                await subagents.taskStarted({
                                    taskId: message.task_id,
                                    toolUseId: message.tool_use_id,
                                }, async () => {});
                                break;
                case "announce":
                    await announce(subagents, message);
                    break;
            }
        }
    }
`;
