import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rehearseUnifiedModelCopy, validateCopyDatabaseUrl } from "../../../scripts/rehearse-unified-model-copy.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";

const dirs: string[] = [];
const output = () => { const dir = mkdtempSync(join(tmpdir(), "mul493-copy-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("rehearsal refuses production, local, alternate-role and query-overridden targets before connecting", () => {
  const copy = "postgresql://mul493_rehearsal@mul493-copy-postgres:5432/mul493_rehearsal";
  expect(validateCopyDatabaseUrl(copy)).toBe(copy);
  for (const value of [undefined, "invalid", copy.replace("mul493-copy-postgres", "n37-117-209.byted.org"),
    copy.replace("mul493-copy-postgres", "127.0.0.1"), copy.replace("@", ":secret@"),
    copy.replace("5432", "5433"), copy.replace("/mul493_rehearsal", "/multiremi"),
    copy.replace("mul493_rehearsal@", "postgres@"), `${copy}?host=production`, `${copy}#fragment`]) {
    expect(() => validateCopyDatabaseUrl(value)).toThrow();
  }
});

unifiedModelBackendTests("MUL-493 offline copy rehearsal", fixture => {
  test("keeps retry identities, provider checkpoints and partial real read progress across full startup and restart", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "copy worker", provider: "codex" });
    const issue = store.createIssue({ title: "copy", assigneeType: "member", assigneeId: "mem_local_local" });
    db.run("UPDATE multiremi_issues SET status='backlog' WHERE id=?", [issue.id]);
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "first" });
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", parentTaskId: first.id, attempt: 2 });
    db.run("UPDATE multiremi_tasks SET status='failed' WHERE id=?", [first.id]);
    db.run("UPDATE multiremi_tasks SET status='completed' WHERE id=?", [second.id]);
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db.run(`INSERT INTO multiremi_issue_decisions(id,workspace_id,issue_id,source_issue_id,kind,title,body,options,
      status,created_by_agent_id,created_at,updated_at)
      VALUES('dec_copy','local',?,?,'question','Choose','copy decision','[]','pending',?,?,?)`,
      [issue.id, issue.id, agent.id, first.createdAt, first.createdAt]);
    db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq=2,parent_cursor_seq=1,provider_session_id='checkpoint',work_dir='/copy/work',generation=3 WHERE session_id=? AND agent_id=?", [session.id, agent.id]);
    db.run("UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?", [JSON.stringify({ [agent.id]: { seq: 1, offset: 17 } }), session.id]);
    const dir = output();
    const result = rehearseUnifiedModelCopy(db, dir);
    expect(result.mismatches).toEqual([]);
    expect(result.counts.attempts).toBe(2);
    expect(result.counts.turns).toBe(1);
    expect(result.partial_read_count).toBe(1);
    expect(result.counts.decisions).toBe(1);
    expect(db.query("SELECT l.cursor_seq,h.head_seq FROM multiremi_session_lanes l JOIN multiremi_conversation_heads h ON h.session_id=l.session_id WHERE l.reader_type='member'").all()
      .every((row: any) => row.cursor_seq === row.head_seq)).toBe(true);
    expect(result.issue_sampling).toBe("manual review required");
    expect(db.query("SELECT cursor_seq,cursor_offset,provider_cursor_seq,parent_cursor_seq,provider_session_id FROM multiremi_session_lanes WHERE reader_type='agent' AND reader_id=?").get(agent.id))
      .toEqual({ cursor_seq: 1, cursor_offset: 17, provider_cursor_seq: 2, parent_cursor_seq: 1, provider_session_id: "checkpoint" });
    const report = JSON.parse(readFileSync(join(dir, "copy-reconciliation.json"), "utf8"));
    expect(report.issue_samples[0].turns[0].attempts).toBe(2);
    expect(report.issue_samples[0].status).toBe("backlog");
    expect(result.migrationMs).toBeGreaterThan(0);
    expect(result.restartMs).toBeGreaterThan(0);
    expect(() => rehearseUnifiedModelCopy(db, output())).toThrow("already migrated");
  });

  test("refuses an undrained copy without changing its task or schema", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "blocked copy", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "running" });
    db.run("UPDATE multiremi_tasks SET status='running' WHERE id=?", [task.id]);
    const dir = output();
    expect(() => rehearseUnifiedModelCopy(db, dir)).toThrow("Copy is not drained");
    expect(db.query("SELECT status FROM multiremi_tasks WHERE id=?").get(task.id)?.status).toBe("running");
    expect(() => db.query("SELECT * FROM multiremi_turn_attempts").all()).toThrow();
    expect(JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8")).find((c: any) => c.name === "undrained_tasks").count).toBe(1);
  });
});
