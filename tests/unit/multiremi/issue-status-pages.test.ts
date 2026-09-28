import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createStatusPagesHarness, STATUS_PAGE_STATUSES as STATUSES } from "../../fixtures/multiremi/issue-status-pages-fixture.js";

describe(`MUL-395 status pages (${process.env.MULTIREMI_TEST_POSTGRES_URL ? "Postgres" : "SQLite"})`, () => {
  let h: Awaited<ReturnType<typeof createStatusPagesHarness>>;
  beforeAll(async () => { h = await createStatusPagesHarness(process.env.MULTIREMI_TEST_POSTGRES_URL); }, 20000);
  afterAll(async () => { await h?.close(); });

  async function equivalent(filter = "", statuses = STATUSES, limit = 50) {
    const grouped = await h.request(`/api/issues/status-pages?statuses=${statuses.join(",")}&limit=${limit}${filter}`);
    expect(grouped.status).toBe(200);
    expect(Object.keys(grouped.body.groups)).toEqual(statuses);
    for (const status of statuses) {
      const single = await h.request(`/api/issues?status=${status}&limit=${limit}&offset=0${filter}`);
      expect(single.status).toBe(200);
      const { issues, total, has_more } = grouped.body.groups[status];
      expect(JSON.stringify({ issues, total })).toBe(single.text);
      expect(has_more).toBe(issues.length < total);
    }
    return grouped.body;
  }

  it("matches all seven independent first pages byte for byte with 120 issues per status", async () => {
    const result = await equivalent("&project_id=prj_status_primary");
    for (const group of Object.values(result.groups) as any[]) {
      expect(group.issues).toHaveLength(50);
      expect(group.total).toBe(120);
    }
  });
  it("matches usr_, mem_, agt_ and untyped assignee references", async () => {
    for (const ref of [h.userId, h.memberId, "agt_status_pages", "Status reader"]) {
      await equivalent(`&project_id=prj_status_primary&assignee_id=${encodeURIComponent(ref)}`);
    }
    await equivalent("&assignee_types=agent&assignee_id=agt_status_pages");
  });
  it("keeps the existing sorting semantics, including tied timestamps", async () => {
    await equivalent("&project_id=prj_status_ties&sort_by=priority&sort_order=asc", STATUSES, 19);
    await equivalent("&project_id=prj_status_primary&sort_by=created_at&sort_order=desc");
  });
  it("matches project, priority, plural assignee and project, null and hierarchy filters", async () => {
    for (const filter of [
      "&project_id=prj_status_other&priority=high", "&project_ids=prj_status_primary,prj_status_other",
      `&assignee_ids=${h.memberId},agt_status_pages`, "&include_no_assignee=true", "&include_no_project=true",
      "&parent_id=iss_parent_status", "&top_level_only=true", "&parent_id=iss_parent_status&top_level_only=true",
    ]) await equivalent(filter);
  });
  it("matches metadata filters and archived page modes", async () => {
    await equivalent(`&metadata=${encodeURIComponent(JSON.stringify({ lane: 1, reviewed: true }))}`);
    await equivalent("&archived_only=true");
    await equivalent("&include_archived=true");
  });
  it("keeps empty buckets and totals with limit=0", async () => {
    const empty = await equivalent("&project_id=prj_absent");
    for (const group of Object.values(empty.groups)) expect(group).toEqual({ issues: [], total: 0, has_more: false });
    await equivalent("&project_id=prj_status_primary", STATUSES, 0);
  });
  it("only counts archives when requested, using the workspace-wide count", async () => {
    const without = await h.request("/api/issues/status-pages?statuses=todo&limit=50&project_id=prj_status_primary");
    const withCount = await h.request("/api/issues/status-pages?statuses=todo&limit=50&project_id=prj_status_primary&include_archived_total=true");
    const single = await h.request("/api/issues?archived_only=true&limit=0");
    expect(without.body).not.toHaveProperty("archived_total");
    expect(withCount.body.archived_total).toBe(single.body.total);
    expect(withCount.body.archived_total).toBe(21);
    expect(withCount.dbq).toBe(without.dbq + 1);
    expect(single.body).not.toHaveProperty("archived_total");
  });
  it("visibility: never returns or counts another workspace's issue", async () => {
    const grouped = await h.request("/api/issues/status-pages?statuses=todo&include_archived_total=true");
    const bucket = grouped.body.groups.todo;
    expect(bucket.issues.some((issue: any) => issue.id.startsWith("iss_hidden"))).toBe(false);
    expect(bucket.issues.every((issue: any) => issue.workspace_id === "local")).toBe(true);
    expect(bucket.total).toBe(h.store.countIssues({ workspaceId: "local", statuses: ["todo"] }));
    for (const path of ["/api/issues", "/api/issues/status-pages"]) {
      const response = await h.request(`${path}?workspace_id=foreign`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "workspace not found" });
    }
  });
  it("dbq golden: stays constant across 1/4/7 statuses and 1/60/300 issues per status", async () => {
    const measurements: number[] = [];
    for (const count of [1, 60, 300]) {
      for (const width of [1, 4, 7]) {
        const result = await h.request(`/api/issues/status-pages?statuses=${STATUSES.slice(0, width).join(",")}&project_id=prj_status_scale${count}&limit=50&include_archived_total=true`);
        expect(result.status).toBe(200);
        expect(Object.values(result.body.groups).map((group: any) => group.total)).toEqual(Array(width).fill(count));
        measurements.push(result.dbq);
      }
    }
    expect(new Set(measurements).size).toBe(1);
    const single = await h.request("/api/issues?status=todo&limit=50&project_id=prj_status_scale300");
    expect(measurements[8]!).toBeLessThanOrEqual(single.dbq * 2);
  });
  it("snapshot: state moves, labels and archives remain consistent across reads", async () => {
    const path = "/api/issues/status-pages?project_id=prj_status_primary&include_archived_total=true";
    const before = await h.request(path);
    const writer = h.writer();
    const id = "iss_primary_todo_119";
    let changed = false;
    h.probe.afterRead = (sql) => {
      if (changed || !sql.includes("UNION ALL")) return;
      changed = true;
      writer.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", "in_progress", "2026-09-28", id);
      writer.run("DELETE FROM multiremi_issue_to_labels WHERE issue_id = ?", id);
    };
    try {
      const during = await h.request(path);
      expect(changed).toBe(true);
      expect(during.status).toBe(200);
      expect(during.text).toBe(before.text);
      expect(h.store.countIssues({ workspaceId: "local", archivedOnly: true })).toBe(22);
    } finally {
      h.probe.afterRead = undefined;
      writer.run("UPDATE multiremi_issues SET status = ?, archived_at = NULL WHERE id = ?", "todo", id);
      writer.run("INSERT INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)", id, "lbl_status");
      writer.close();
    }
  });
  it("defaults to seven states, normalizes open and rejects later pages", async () => {
    const defaults = await h.request("/api/issues/status-pages");
    expect(Object.keys(defaults.body.groups)).toEqual(STATUSES);
    const open = await h.request("/api/issues/status-pages?statuses=open,todo");
    expect(Object.keys(open.body.groups)).toEqual(["todo"]);
    expect((await h.request("/api/issues/status-pages?offset=50")).status).toBe(400);
  });
});
