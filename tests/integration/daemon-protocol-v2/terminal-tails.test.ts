import { expect, it, spyOn } from "bun:test";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

it("replays real runAgent finally/workspace and finalize/progress tails once after complete", async () => {
  const summaryServer = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ choices: [{ message: { content: '{"summary":"final display summary","step":3,"total":3}' } }] }),
  });
  const settings = {
    MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "openai",
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL: `http://127.0.0.1:${summaryServer.port}`,
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL: "local-fixture",
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY: "local-fixture-key",
    MULTIREMI_PROGRESS_SUMMARY_DISABLED: "0",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  let h: DaemonProtocolHarness | undefined;
  const lost = new Set<string>();
  const attempts = new Map<string, Record<string, any>>();
  const wrapped = new WeakSet<object>();
  const replies: Array<ReturnType<typeof spyOn>> = [];
  let taskId = "";
  let workspaceEffects = 0;
  let progressEffects = 0;
  let completeEffects = 0;
  let workspace: ReturnType<typeof spyOn> | undefined;
  let progress: ReturnType<typeof spyOn> | undefined;
  let complete: ReturnType<typeof spyOn> | undefined;
  try {
    h = await DaemonProtocolHarness.create({
      outboxBackoffMs: [5],
      beforeSend(frame, socket, harness) {
        if (frame.p?.task_id !== taskId) return;
        const tail = (frame.t === "task.workspace" && frame.p.status === "ready")
          || (frame.t === "task.progress" && frame.p.final === true);
        if (!tail) return;
        attempts.set(String(frame.seq), frame);
        const session = harness.sessions.at(-1)!;
        if (wrapped.has(session)) return;
        wrapped.add(session);
        const real = session.sendReply.bind(session);
        replies.push(spyOn(session, "sendReply").mockImplementation((re, payload) => {
          if (attempts.has(re) && !lost.has(re)) {
            lost.add(re);
            socket.close(4001);
            return false;
          }
          return real(re, payload);
        }));
      },
    });
    const agent = h.store.createAgent({ name: "Real terminal tails", provider: "claude" });
    const issue = h.store.createIssue({ title: "Terminal tail replay", workspaceId: "local" });
    const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "finish the local fixture" });
    taskId = task.id;
    const realWorkspace = h.store.reportIssueWorkspace.bind(h.store);
    workspace = spyOn(h.store, "reportIssueWorkspace").mockImplementation((input) => {
      if (input.lastTaskId === taskId && input.status === "ready") workspaceEffects++;
      return realWorkspace(input);
    });
    const realProgress = h.store.reportProgress.bind(h.store);
    progress = spyOn(h.store, "reportProgress").mockImplementation((id, summary, step, total, options) => {
      if (id === taskId && options?.allowTerminal) progressEffects++;
      return realProgress(id, summary, step, total, options);
    });
    const realComplete = h.store.completeTask.bind(h.store);
    complete = spyOn(h.store, "completeTask").mockImplementation((id, input) => {
      if (id === taskId) completeEffects++;
      return realComplete(id, input);
    });
    await h.startDaemon();
    for (let index = 0; index < 2; index++) {
      await waitFor(() => lost.size === index + 1 && h!.client.connectionState() === "disconnected", "tail committed without ACK", 5_000);
      expect(h.store.getTask(taskId)?.status).toBe("completed");
      const previousSockets = h.sockets.length;
      h.clock.advance(1_000);
      // The next lost ACK can disconnect immediately after welcome, before a state poll sees connected.
      await waitFor(() => h!.sockets.length > previousSockets
        && h!.sockets.at(-1)!.frames.some((frame) => frame.t === "welcome"), "tail replay welcome");
    }
    await waitFor(() => progressEffects > 0 && ((h!.daemon as any).ensureOutbox() as MultiremiTaskReportOutbox).stats().pending === 0,
      "both replayed tails to drain", 5_000);
    expect(workspaceEffects).toBe(1);
    expect(progressEffects).toBe(1);
    expect(completeEffects).toBe(1);
    expect(h.store.getTask(taskId)).toMatchObject({ status: "completed", result: "fixture", progressSummary: "final display summary" });
    expect(h.store.getIssueWorkspace(issue.id)).toMatchObject({ status: "ready", lastTaskId: taskId });
    expect(h.client.connectionState()).toBe("connected");
    await h.settleHeartbeat();
    const frames = h.ledger.filter((entry) => entry.partition === taskId);
    const afterComplete = frames.slice(frames.findIndex((entry) => entry.type === "task.complete") + 1);
    expect(afterComplete.length).toBe(4);
    expect(afterComplete.every((entry) => entry.type === "task.workspace"
      || (entry.type === "task.progress" && entry.frame.p.final === true))).toBe(true);
    for (const seq of lost) expect(afterComplete.filter((entry) => String(entry.seq) === seq)).toHaveLength(2);
    expect(h.errors).toEqual([]);
  } finally {
    await h?.dispose();
    workspace?.mockRestore(); progress?.mockRestore(); complete?.mockRestore();
    for (const reply of replies) reply.mockRestore();
    summaryServer.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 20_000);
