import { afterEach, describe, expect, it } from "bun:test";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { buildToolApprovalForm } from "@connectors/feishu/permission-ui.js";
import { readFileSync } from "node:fs";

const credentials = { appId: "cli_test", appSecret: "test-only" };
const sessions: FeishuStreamingSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.detach(); });

function harness(patchHook?: (card: Record<string, unknown>) => Promise<void>) {
  const calls: Array<{ operation: string; input: any }> = [];
  const client = { im: { message: {
    create: async (input: any) => { calls.push({ operation: "create", input }); return { code: 0, data: { message_id: "om_card" } }; },
    reply: async (input: any) => { calls.push({ operation: "reply", input }); return { code: 0, data: { message_id: "om_card" } }; },
    patch: async (input: any) => {
      calls.push({ operation: "patch", input });
      await patchHook?.(JSON.parse(input.data.content));
      return { code: 0 };
    },
  } } };
  const session = new FeishuStreamingSession(client as any, credentials, { log: () => {},
    tokenProvider: async () => { throw new Error("CardKit token path must not be used"); } });
  sessions.push(session);
  return { session, calls, patches: () => calls.filter(c => c.operation === "patch").map(c => JSON.parse(c.input.data.content)) };
}

describe("one patch-only Feishu card transport", () => {
  it("adds the sender mention only in the final patch, never in initial or progress cards", async () => {
    const h = harness();
    await h.session.start("oc_group", "chat_id", { replyToMessageId: "om_question", mentionOpenId: "ou_sender" });
    await h.session.update("Working");
    await h.session.appendPermissionForm(buildToolApprovalForm("sender-form", "Read", "source", []));
    await h.session.removePermissionForm("sender-form");
    await h.session.close({ finalText: "Answer", stats: "2s · 1 tool" });

    for (const { input } of h.calls.slice(0, -1)) expect(input.data.content).not.toContain("<at ");
    const final = JSON.parse(h.calls.at(-1)!.input.data.content);
    expect(h.calls.at(-1)!.operation).toBe("patch");
    expect(final.body.elements.at(-1).columns[0].elements[0].content).toBe("<at id=ou_sender></at>");
    expect(final.body.elements.at(-1).flex_mode).toBe("flow");
    expect(JSON.stringify(final).match(/<at id=ou_sender><\/at>/g)).toHaveLength(1);
    expect(h.calls.filter(call => call.operation !== "patch")).toHaveLength(1);
  });

  it("preserves the sender mention on an error or cancelled reply", async () => {
    for (const aborted of [false, true]) {
      const h = harness();
      await h.session.start("oc_group", "chat_id", { mentionOpenId: "ou_sender" });
      await h.session.close({ finalText: "Stopped", aborted });
      expect(h.patches().at(-1).body.elements.at(-1).columns[0].elements[0].content).toBe("<at id=ou_sender></at>");
    }
  });

  for (const durable of [undefined, { idempotencyKey: "delivery_1" }]) {
    it(`uses the same message JSON and patch path for ${durable ? "proactive" : "interactive"} replies`, async () => {
      const h = harness();
      await h.session.start("oc_group", "chat_id", { replyToMessageId: "om_root", displayName: "Topic Agent", durable });
      expect(h.calls.map(c => c.operation)).toEqual(["reply"]);
      const sent = h.calls[0]!.input;
      expect(sent.data.msg_type).toBe("interactive");
      expect(sent.path.message_id).toBe("om_root");
      const initial = JSON.parse(sent.data.content);
      expect(initial.schema).toBe("2.0");
      expect(initial.config).not.toHaveProperty("streaming_mode");
      expect(initial.config).not.toHaveProperty("streaming_config");
      expect(initial).not.toHaveProperty("data.card_id");

      await h.session.update("partial");
      h.session.addStep("Read", "Read source");
      h.session.updateStepDuration(1500);
      await h.session.appendPermissionForm(buildToolApprovalForm("approval", "Read", "source", [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
      ]));
      expect(h.patches()).toHaveLength(1);
      expect(JSON.stringify(h.patches()[0])).toContain("partial");
      expect(JSON.stringify(h.patches()[0])).toContain("1.5s");
      expect(JSON.stringify(h.patches()[0])).toContain("approval");
      expect(JSON.stringify(h.patches()[0]!.header)).toContain("Topic Agent");
      await h.session.removePermissionForm("approval");
      expect(JSON.stringify(h.patches().at(-1))).not.toContain("perm_approval");
      await h.session.close({ finalText: "Final answer", stats: "1 tool" });
      expect(JSON.stringify(h.patches().at(-1))).toContain("Final answer");
      expect(h.calls.filter(c => c.operation !== "patch")).toHaveLength(1);
      expect(h.session.isActive()).toBe(false);
    });
  }

  it("coalesces text, status and steps into one patch for an ordinary chat", async () => {
    const h = harness();
    await h.session.start("oc_group");
    for (let i = 0; i < 20; i++) await h.session.update(`text ${i}`);
    await h.session.updateStatus("Checking");
    h.session.addStep("Bash", "git status");
    expect(h.patches()).toHaveLength(0);
    for (let i = 0; i < 80 && !h.patches().length; i++) await Bun.sleep(50);
    expect(h.patches()).toHaveLength(1);
    const current = JSON.stringify(h.patches()[0]);
    expect(current).toContain("text 19");
    expect(current).toContain("Checking");
    expect(current).toContain("git status");
    await h.session.close("done");
    expect(h.patches()).toHaveLength(2);
  });

  it("serializes progress and final patches and ignores events after close begins", async () => {
    let unblock!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    const h = harness(async () => { if (h.patches().length === 1) await waiting; });
    await h.session.start("oc_group");
    await h.session.update("before");
    const form = h.session.appendPermissionForm(buildToolApprovalForm("test", "Read", "source", []));
    await Promise.resolve();
    const final = h.session.close("final");
    expect(h.session.close("must not replace final")).toBe(final);
    await h.session.update("late event");
    expect(h.patches()).toHaveLength(1);
    unblock();
    await form;
    await final;
    expect(h.patches()).toHaveLength(2);
    expect(JSON.stringify(h.patches().at(-1))).toContain("final");
    expect(JSON.stringify(h.patches().at(-1))).not.toContain("late event");
  });

  it("flushes the latest buffered content at completion without waiting for the interval", async () => {
    const h = harness();
    await h.session.start("oc_group");
    await h.session.update("last chunk");
    await h.session.updateThinking("reasoning");
    await h.session.close();
    expect(h.patches()).toHaveLength(1);
    expect(JSON.stringify(h.patches()[0])).toContain("last chunk");
    expect(JSON.stringify(h.patches()[0])).toContain("reasoning");
  });

  it("finishes a legacy card without creating a second pseudo-CoT message", async () => {
    const h = harness();
    await h.session.start("oc_group", "chat_id", {
      replyToMessageId: "om_question",
      displayName: "Remi",
      subtitle: "Remi Claude opus5",
      mentionOpenId: "ou_sender",
    });
    await h.session.update("answer must stay hidden until completion");
    h.session.addStep("Read", "Read source");
    await h.session.close({ finalText: "Final answer", stats: "8s · 1 tool" });

    const operations = h.calls.map(call => call.operation);
    expect(operations).toEqual(["reply", "patch"]);
    const result = JSON.parse(h.calls[1]!.input.data.content);
    expect(JSON.stringify(result)).toContain("Final answer");
    expect(JSON.stringify(result)).toContain("8s");
    expect(JSON.stringify(result)).toContain("<at id=ou_sender></at>");
    expect(h.session.getMessageId()).toBe("om_card");
  });

  it("retries transient failures on the same message and keeps the queue usable", async () => {
    let attempts = 0;
    const h = harness(async () => { if (++attempts < 3) throw new Error("connection lost"); });
    await h.session.start("oc_group");
    await h.session.close("done");
    expect(attempts).toBe(3);
    expect(h.calls.filter(c => c.operation === "patch").every(c => c.input.path.message_id === "om_card")).toBe(true);
    expect(h.calls.filter(c => c.operation === "create")).toHaveLength(1);
  });

  it("cannot fall back to native CardKit or select a second transport", () => {
    const source = readFileSync(new URL("../../../packages/connectors/src/feishu/streaming.ts", import.meta.url), "utf8");
    expect(source).not.toContain("/cardkit/");
    expect(source).not.toContain("_degraded");
    expect(source).not.toContain("CardKitElements");
  });
});
