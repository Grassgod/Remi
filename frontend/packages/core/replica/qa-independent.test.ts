import { describe, expect, test } from "vitest";
import { ReplicaEngine } from "./engine";
import { MemoryReplicaStorage } from "./storage";
import { ReplicaView } from "./view";
import { ReplicaLeader } from "./leader";
import { ReplicaFollower } from "./follower";
import { openBrowserReplica, type BrowserReplica } from "./browser";
import { META_SCHEMA_VERSION, META_USER_ID, META_WORKSPACE_ID, REPLICA_SCHEMA_VERSION } from "./schema";
import { rowHeightKey, type SessionLogEntry } from "./port";
import type { HubFrame, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { ReplicaWorkerRequest } from "./worker-protocol";

const sid = "qa_session";
function row(seq: number, extra: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return { session_id: sid, seq, id: `qa_${seq}`, kind: "message", revision: 1,
    body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`, render_version: "v1", ...extra };
}
function frame(seq: number, extra: Partial<SessionLogEntry> = {}): HubFrame {
  return { seq, kind: "entry", payload: { ...row(seq, extra), visibility: "shown" } };
}
function ack(head = 3, version = 1, gap = null as {from:number;to:number}|null): HubStreamAckPayload {
  return { stream: "log", id: sid, first_seq: 1, head_seq: head, log_version: version, gap };
}
function engine() {
  const storage = new MemoryReplicaStorage();
  const replica = new ReplicaEngine(storage);
  replica.openSession({ sessionId: sid, userId: "qa_u", workspaceId: "qa_w" });
  return { storage, replica };
}
async function ticks() { for (let n=0;n<16;n++) await Promise.resolve(); }
function harness() {
  const requests: ReplicaWorkerRequest[] = [], subscriptions: Array<[string,number]> = [], unsubs: string[] = [];
  const view = new ReplicaView();
  const leader = new ReplicaLeader({ userId: "qa_u", workspaceId: "qa_w", tabId: "qa_tab",
    worker: { postMessage: r => requests.push(r), onMessage: () => () => {} },
    subscription: { subscribe: (id, from) => subscriptions.push([id,from]), unsubscribe: id => unsubs.push(id) },
    readRange: async (_id, range) => Array.from({length:range.to-range.from+1},(_,n)=>row(range.from+n)),
    broadcast: () => {}, view });
  return { leader, requests, subscriptions, unsubs, view };
}
async function shared(input: { readRange?: (id:string,range:{from:number;to:number})=>Promise<SessionLogEntry[]> } = {}) {
  const reads: Array<{from:number;to:number}> = [], subs: number[] = [], unsubs: string[] = [];
  const replica = await openBrowserReplica({ userId: "qa_u", workspaceId: "qa_w", tabId: "qa_tab",
    subscribe: (_id,from) => subs.push(from), unsubscribe: id => unsubs.push(id),
    readRange: input.readRange ?? (async (_id,r) => { reads.push(r); return Array.from({length:r.to-r.from+1},(_,n)=>row(r.from+n)); }),
    env: { locks: { request: async (_name:unknown,_opts:unknown,callback:()=>Promise<unknown>) => callback() } as never,
      hasOpfs: true, broadcastChannel: class { onmessage=null; postMessage() {} close() {} } as never } });
  await ticks(); replica.open(sid); await ticks();
  return { replica, reads, subs, unsubs };
}

describe("QA independent engine and storage contracts", () => {
  test("sparse windows and out-of-order batches never advance past a hole", () => {
    const { replica, storage } = engine();
    replica.ack(sid, ack(9)); replica.frames(sid,[frame(1),frame(5),frame(9)]);
    expect(storage.readState(sid).head).toBe(1);
    replica.writeWindow(sid,[row(70),row(71)],{from:70,to:71});
    expect(replica.resumeFrom(sid)).toBe(2); expect(replica.isFresh(sid)).toBe(false);
  });
  test("partial patches in one batch preserve all changed fields", () => {
    const {replica}=engine(); replica.frames(sid,[frame(1)]);
    replica.frames(sid,[
      {seq:1,kind:"patch",payload:{target_seq:1,revision:2,fields:{body_md:"changed"}}},
      {seq:1,kind:"patch",payload:{target_seq:1,revision:3,fields:{body_html:"<p>changed</p>"}}},
    ]);
    expect(replica.readWindow(sid,1,1)[0]).toMatchObject({body_md:"changed",body_html:"<p>changed</p>",revision:3});
  });
  test("older patch replay cannot roll content backwards or invent a revision", () => {
    const {replica}=engine(); replica.frames(sid,[frame(1,{revision:5,body_md:"new"})]);
    replica.frames(sid,[{seq:1,kind:"patch",payload:{target_seq:1,revision:3,fields:{body_md:"old"}}}]);
    expect(replica.readWindow(sid,1,1)[0]).toMatchObject({body_md:"new",revision:5});
  });
  test("a replayed entry cannot overwrite a newer patched row", () => {
    const {replica}=engine(); replica.frames(sid,[frame(1,{revision:5,body_md:"new"})]);
    replica.frames(sid,[frame(1)]);
    expect(replica.readWindow(sid,1,1)[0]).toMatchObject({body_md:"new",revision:5});
  });
  test("patch changes the height key while keeping one row", () => {
    const {replica}=engine(); replica.frames(sid,[frame(1)]);
    replica.writeRowHeight(sid,1,rowHeightKey({revision:1,renderVersion:"v1",widthPx:600}),40);
    replica.frames(sid,[{seq:1,kind:"patch",payload:{target_seq:1,revision:2,fields:{body_md:"changed"}}}]);
    expect(replica.readWindow(sid,0,10)).toHaveLength(1);
    expect(replica.readRowHeight(sid,1,rowHeightKey({revision:2,renderVersion:"v1",widthPx:600}))).toBeNull();
  });
  test("identity mismatch clears rows and establishes the new owner", () => {
    const {replica,storage}=engine(); replica.frames(sid,[frame(1)]);
    const second = new ReplicaEngine(storage);
    expect(second.openSession({sessionId:sid,userId:"qa_other",workspaceId:"qa_w"}).cleared?.reason).toBe("user_mismatch");
    expect(second.readWindow(sid,0,10)).toHaveLength(0);
    expect(storage.readMeta(META_USER_ID)).toBe("qa_other");
  });
  test("a corrected user identity must not wipe the fresh rows on every reconnect", () => {
    const {storage}=engine(), second=new ReplicaEngine(storage);
    second.openSession({sessionId:sid,userId:"qa_other",workspaceId:"qa_w"});
    second.frames(sid,[frame(1)]);
    const reopened=second.openSession({sessionId:sid,userId:"qa_other",workspaceId:"qa_w"});
    expect(reopened.cleared).toBeNull();
    expect(second.readWindow(sid,0,10)).toHaveLength(1);
  });
  test("schema upgrade clears metadata and rows then binds current identity", () => {
    const {replica,storage}=engine(); replica.frames(sid,[frame(1)]); storage.writeMeta(META_SCHEMA_VERSION,"0");
    replica.openSession({sessionId:sid,userId:"qa_u",workspaceId:"qa_w"});
    expect(replica.readWindow(sid,0,10)).toHaveLength(0);
    expect(storage.readMeta(META_SCHEMA_VERSION)).toBe(String(REPLICA_SCHEMA_VERSION));
    expect(storage.readMeta(META_USER_ID)).toBe("qa_u");
    expect(storage.readMeta(META_WORKSPACE_ID)).toBe("qa_w");
  });
  test("unchanged view and follower snapshots have stable object identity", () => {
    const view = new ReplicaView(); view.setWindow(sid,[row(1)],{head:1,fresh:true,ready:true});
    const follower = new ReplicaFollower({view,broadcast:()=>{},requestWindow:()=>{}});
    expect(view.getSnapshot(sid)).toBe(view.getSnapshot(sid));
    expect(follower.getSnapshot(sid)).toBe(follower.getSnapshot(sid));
  });

});

describe("QA independent leader lifecycle", () => {
  test("only the last of three closes unsubscribes", () => {
    const {leader,unsubs}=harness(); leader.open(sid);leader.open(sid);leader.open(sid);
    leader.close(sid);leader.close(sid);expect(unsubs).toHaveLength(0);
    leader.close(sid);expect(unsubs).toEqual([sid]);
  });
  test("a persisted head is the subscription cursor", () => {
    const {leader,subscriptions,requests}=harness();leader.open(sid);
    leader.handleWorkerMessage({...requests.at(-1),type:"opened",sessionId:sid,fromSeq:43,head:42,fresh:false,cleared:null,entries:[row(42)]});
    expect(subscriptions).toEqual([[sid,43]]);
  });
  test("version flip with no replay still revokes and restarts from reset head", async () => {
    const {replica,subs,reads}=await shared();replica.ack(sid,ack(3));replica.frames(sid,[frame(1),frame(2),frame(3)]);
    replica.resubscribe(sid);expect(subs.at(-1)).toBe(4);
    replica.ack(sid,ack(3,2)); await ticks();
    const snap=replica.port.getSnapshot(sid);
    expect(snap.fresh).toBe(false);
    expect(subs.at(-1)===1 || reads.some(r=>r.from===1&&r.to===3)).toBe(true);replica.dispose();
  });
});

describe.each(["logout", "user_mismatch", "schema_upgrade"] as const)("QA actual WorkerHost clear %s", (reason) => {
  test("clears whole store, broadcasts reason, and drops follower cache", async () => {
    const {ReplicaWorkerHost}=await import("./worker");
    const leaderView=new ReplicaView(), followerView=new ReplicaView(), broadcasts: any[]=[], responses: any[]=[];
    const follower=new ReplicaFollower({view:followerView,broadcast:()=>{},requestWindow:()=>{}});
    const leader=new ReplicaLeader({userId:"qa_u",workspaceId:"qa_w",tabId:"qa_tab",
      subscription:{subscribe:()=>{},unsubscribe:()=>{}}, readRange:async()=>[],
      worker:{postMessage:()=>{},onMessage:()=>()=>{}},view:leaderView,
      broadcast:m=>{broadcasts.push(m);follower.handle(m);}});
    const host=new ReplicaWorkerHost({storage:"memory",post:r=>{responses.push(r);leader.handleWorkerMessage(r);}});
    await host.enqueue({type:"init",userId:"qa_u",workspaceId:"qa_w",storage:"memory"});
    await host.enqueue({type:"open",sessionId:sid});
    await host.enqueue({type:"frames",sessionId:sid,frames:[frame(1)]});
    const backing=(host as any).engine.storage as MemoryReplicaStorage;
    backing.upsertEntries([row(1,{session_id:"qa_unopened_session"})]);
    followerView.setWindow(sid,[row(1)],{head:1,fresh:true,ready:true});
    if(reason==="logout") await host.enqueue({type:"clear",reason});
    else {
      backing.writeMeta(reason==="user_mismatch"?META_USER_ID:META_SCHEMA_VERSION,"qa_old");
      await host.enqueue({type:"open",sessionId:sid});
    }
    expect(responses.filter(r=>r.type==="error")).toHaveLength(0);
    expect(backing.readWindow("qa_unopened_session",0,10)).toHaveLength(0);
    expect(broadcasts.some(m=>m.type==="replica:cleared"&&m.reason===reason)).toBe(true);
    expect(followerView.getSnapshot(sid)).toMatchObject({entries:[],head:null,fresh:false});
  });
});

describe.each(["no-opfs","no-locks"])("QA fallback %s", (mode) => {
  async function memory() {
    const reads: Array<{from:number;to:number}>=[], cleared: string[]=[];
    const replica: BrowserReplica = await openBrowserReplica({userId:"qa_u",workspaceId:"qa_w",tabId:"qa_tab",
      subscribe:()=>{},unsubscribe:()=>{},onCleared:r=>cleared.push(r),
      readRange:async (_id,r)=>{reads.push(r);return Array.from({length:r.to-r.from+1},(_,n)=>row(r.from+n));},
      env:{hasOpfs:mode!=="no-opfs",locks:mode==="no-locks"?{} as never:undefined} });
    replica.open(sid);return {replica,reads,cleared};
  }
  test("ack gap actually triggers the range read", async () => {
    const {replica,reads}=await memory();replica.ack(sid,ack(3,1,{from:1,to:2}));replica.frames(sid,[frame(3)]);await ticks();
    expect(reads).toEqual([{from:1,to:2}]);expect(replica.port.getSnapshot(sid).head).toBe(3);replica.dispose();
  });
  test("logout emits the clear notification on the fallback path", async () => {
    const {replica,cleared}=await memory();replica.clear("logout");expect(cleared).toEqual(["logout"]);replica.dispose();
  });
});
