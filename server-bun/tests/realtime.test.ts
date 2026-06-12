import { test, expect } from "bun:test";
import { EventBus } from "../src/realtime/bus.js";
import { attachClient } from "../src/realtime/hub.js";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

test("EventBus fans out only to same-workspace subscribers", () => {
  const bus = new EventBus();
  const a: string[] = [];
  const b: string[] = [];
  const unsubA = bus.subscribe(WS_A, (e) => a.push(e.type));
  bus.subscribe(WS_B, (e) => b.push(e.type));

  bus.publish({ type: "issue.created", workspaceId: WS_A, payload: { id: "x" } });
  expect(a).toEqual(["issue.created"]);
  expect(b).toEqual([]); // isolation: B's workspace is untouched

  unsubA();
  expect(bus.subscriberCount(WS_A)).toBe(0);
  bus.publish({ type: "issue.updated", workspaceId: WS_A });
  expect(a).toEqual(["issue.created"]); // unsubscribed → no more events
});

test("attachClient forwards bus events to the socket as JSON wire frames", () => {
  const bus = new EventBus();
  const sent: string[] = [];
  const detach = attachClient(bus, WS_A, { send: (d) => sent.push(d) });

  bus.publish({ type: "comment.created", workspaceId: WS_A, payload: { id: "c1" } });
  expect(sent.length).toBe(1);
  expect(JSON.parse(sent[0]!)).toEqual({
    type: "comment.created",
    workspace_id: WS_A,
    payload: { id: "c1" },
  });

  detach();
  bus.publish({ type: "comment.created", workspaceId: WS_A });
  expect(sent.length).toBe(1); // detached
});

test("a throwing subscriber does not break the fanout", () => {
  const bus = new EventBus();
  const got: string[] = [];
  bus.subscribe(WS_A, () => {
    throw new Error("bad subscriber");
  });
  bus.subscribe(WS_A, (e) => got.push(e.type));
  bus.publish({ type: "issue.created", workspaceId: WS_A });
  expect(got).toEqual(["issue.created"]); // sibling still received it
});
