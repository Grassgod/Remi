import { createResponsibleTestIssue, acceptTestIssueDelivery, prepareTestIssueDelivery } from './helpers.js';
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const previousScmKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const databaseName = `multiremi_mul457_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.skipIf(!adminUrl)("MUL-457 PostgreSQL grant and merge paths", () => {
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: MultiremiStore;

  beforeAll(async () => {
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    database = new PostgresSyncDatabase(databaseUrl(databaseName));
    store = new MultiremiStore(database);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    database?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.end();
    if (previousScmKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
    else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = previousScmKey;
  });

  it("migrates old rows twice and keeps grant, revocation and agent closure at depth one", () => {
    const owner = store.createAgent({ name: "PG parent owner", provider: "codex" });
    const parent = createResponsibleTestIssue(store, { title: "PG parent", status: "in_progress", assigneeType: "agent", assigneeId: owner.id });
    const child = createResponsibleTestIssue(store, { title: "PG child", status: "in_progress", parentIssueId: parent.id,assigneeType:'agent',assigneeId:owner.id });
    expect(store.getIssue(parent.id)).toMatchObject({ parentDoneGrantAt: null, parentDoneGrantBy: null, parentDoneGrantAgentId: null });
    const secondConnection = new PostgresSyncDatabase(databaseUrl(databaseName));
    new MultiremiStore(secondConnection);
    secondConnection.close();
    store.grantParentDone(parent.id, "local");
    expect(store.issueParentDoneGrantView(store.getIssue(parent.id)!)).toMatchObject({ effective: true, agent_id: owner.id });
    store.revokeParentDone(parent.id, "local");
    expect(store.issueParentDoneGrantView(store.getIssue(parent.id)!)).toBeNull();
    store.grantParentDone(parent.id, "local");
    acceptTestIssueDelivery(store,child.id);
    store.createIssueComment(parent.id, { body: "PG summary", authorType: "agent", authorId: owner.id });
    expect(()=>store.updateIssue(parent.id,{status:'done',actorType:'agent',actorId:owner.id})).toThrow('specific delivery');
    const prepared=prepareTestIssueDelivery(store,parent.id);
    store.authorizeIssueDelivery(parent.id,prepared.delivery.id,owner.id,prepared.delivery.responsibilityRevision,prepared.actor);
    database.resetTransactionDepthStats();
    store.respondIssueDelivery(parent.id,prepared.delivery.id,{action:'accept',revision:prepared.delivery.responsibilityRevision},
      {type:'agent',id:owner.id,taskId:prepared.executionTask.id});
    expect(database.maxTransactionDepth).toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe('done');
    expect(store.listIssueActivity(parent.id).find((entry) => entry.type === "parent_done_grant_used")?.data)
      .toMatchObject({ source: "api", agentId: owner.id });
  });

  it("settles SCM receipt holds with and without summaries, then explicitly accepts the concrete delivery", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const owner = store.createAgent({ name: "PG SCM owner", provider: "codex" });
    store.updateWorkspace("local", {
      repos: [{ id: "repo_mul457", name: "mul457", url: "git@github.com:acme/mul457.git", source: "github", default_branch: "main" }],
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    const connection = store.createScmConnection({
      workspaceId: "local", name: "PG SCM", provider: "github", mode: "poll",
      accessToken: "test-only-token", repositoryIds: ["repo_mul457"],
    });
    for (const summary of [false, true]) {
      const parent = createResponsibleTestIssue(store, { title: `PG SCM parent ${summary}`, status: "in_progress", assigneeType: "agent", assigneeId: owner.id });
      const child = createResponsibleTestIssue(store, { title: `PG SCM child ${summary}`, status: "in_progress", parentIssueId: parent.id,assigneeType:'agent',assigneeId:owner.id });
      acceptTestIssueDelivery(store,child.id);
      store.grantParentDone(parent.id, "local");
      if (summary) store.createIssueComment(parent.id, { body: "PG merge summary", authorType: "agent", authorId: owner.id });
      const number = summary ? 4572 : 4571;
      store.advanceScmEntitySnapshot({
        connectionId: connection.id, repositoryId: "repo_mul457", entityType: "change_request",
        externalId: String(number), revisionAt: new Date().toISOString(), revision: `v${number}`,
        contentHash: `mul457-${number}`,
        payload: { number, title: `${parent.key} delivery`, state: "merged", source_branch: `agent/${parent.key}` },
      });
      store.recordScmCanonicalEvent({
        workspaceId: "local", connectionId: connection.id, repositoryId: "repo_mul457",
        type: "change.merged", subjectType: "change_request", subjectId: String(number),
        logicalKey: `change.merged:${number}`, fidelity: "exact",
        payload: { number, branch: "main", mergeSha: `sha-${number}` },
        evidence: { source: "poll", dedupeKey: `poll:${number}` },
      });
      expect(store.getIssue(parent.id)?.status).not.toBe('done');
      const activity = store.listIssueActivity(parent.id);
      expect(activity.filter(entry=>entry.type==='parent_done_grant_used')).toHaveLength(0);
      expect(activity.find((entry) => entry.type === "parent_status_held")?.data)
        .toMatchObject({ reason: summary ? "issue_delivery_acceptance_required" : "final_summary_missing", source: "scm_merge" });
      expect(activity.filter(entry=>entry.type==='parent_status_held')).toHaveLength(1);
      expect(database.query('SELECT status,last_error FROM multiremi_scm_effects WHERE issue_id=?').get(parent.id))
        .toMatchObject({status:'applied',last_error:null});
      const prepared=prepareTestIssueDelivery(store,parent.id);
      store.authorizeIssueDelivery(parent.id,prepared.delivery.id,owner.id,prepared.delivery.responsibilityRevision,prepared.actor);
      database.resetTransactionDepthStats();
      store.respondIssueDelivery(parent.id,prepared.delivery.id,{action:'accept',revision:prepared.delivery.responsibilityRevision},
        {type:'agent',id:owner.id,taskId:prepared.executionTask.id});
      expect(database.maxTransactionDepth).toBe(1);
      expect(store.getIssue(parent.id)?.status).toBe('done');
      expect(store.listIssueActivity(parent.id).filter(entry=>entry.type==='parent_done_grant_used')).toHaveLength(1);
    }
  });
});
