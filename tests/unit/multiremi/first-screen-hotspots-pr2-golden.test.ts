import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { AUTH_COOKIE_NAME } from "@multiremi/api/helpers/login.js";
import { createPr2Harness, capturePr2Responses, capturePr2QueryCounts, reportPr2Usage } from "../../fixtures/multiremi/first-screen-hotspots-pr2-fixture.js";

const fixtureDir = `${import.meta.dir}/../../fixtures/multiremi`;

it("matches the protocol-aware wire response golden byte for byte", async () => {
  expect(`${JSON.stringify(await capturePr2Responses(), null, 2)}\n`)
    .toBe(readFileSync(`${fixtureDir}/first-screen-hotspots-pr2-golden.json`, "utf8"));
}, 20000);

const dbqGolden = JSON.parse(readFileSync(`${fixtureDir}/first-screen-hotspots-pr2-dbq-golden.json`, "utf8"));
for (const point of [0, 1, 2]) {
  it(`matches the dbq golden at scale ${point + 1}, with constant queries`, async () => {
    const observed = await capturePr2QueryCounts(point);
    expect(`${JSON.stringify(observed, null, 2)}\n`).toBe(`${JSON.stringify([dbqGolden[point]], null, 2)}\n`);
    for (const route of Object.keys(observed[0]!.routes)) {
      expect(observed[0]!.routes[route]).toBe(dbqGolden[0].routes[route]);
    }
  }, 20000);
}

it("authorizes private attachments before comparing even a correct ETag", async () => {
  const harness = await createPr2Harness();
  try {
    const path = `/api/attachments/${harness.privateAttachmentId}/content`;
    const allowed = await harness.app.request(path, { headers: harness.headers });
    expect(allowed.status).toBe(200);
    const etag = allowed.headers.get("etag");
    expect(etag).toBe(`"${harness.privateAttachmentId}"`);
    await allowed.arrayBuffer();
    const baseline = JSON.parse(readFileSync(`${fixtureDir}/first-screen-hotspots-pr2-golden.json`, "utf8"));
    const denied = await harness.app.request(path, { headers: { ...harness.viewerHeaders, "If-None-Match": etag! } });
    expect({ status: denied.status, body: await denied.text() }).toEqual(baseline.denied);
    expect(denied.headers.get("etag")).toBeNull();
    const cookieHeaders = (credentials: typeof harness.headers) => ({
      Cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(credentials.Authorization.slice(7))}`,
      "X-Workspace-ID": credentials["X-Workspace-ID"], "If-None-Match": etag!,
    });
    const cookieDenied = await harness.app.request(path, { headers: cookieHeaders(harness.viewerHeaders) });
    expect({ status: cookieDenied.status, body: await cookieDenied.text() }).toEqual(baseline.denied);
    expect(cookieDenied.headers.get("etag")).toBeNull();
    const cookieAllowed = await harness.app.request(path, { headers: cookieHeaders(harness.headers) });
    expect(cookieAllowed.status).toBe(304);
    expect(await cookieAllowed.text()).toBe("");
    expect(cookieAllowed.headers.get("vary")?.toLowerCase()).toContain("authorization");
    expect(cookieAllowed.headers.get("vary")?.toLowerCase()).toContain("cookie");
    for (const validator of [etag!, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const matched = await harness.app.request(path, { headers: { ...harness.headers, "If-None-Match": validator } });
      expect(matched.status).toBe(304);
      expect(await matched.text()).toBe("");
      expect(matched.headers.get("content-length")).toBeNull();
    }
    const unsigned = await harness.app.request(path, { headers: { "If-None-Match": etag! } });
    expect(unsigned.status).toBe(401);
  } finally { await harness.dispose(); }
}, 20000);

it("hydrates usage, groups and models exactly like the old per-runtime reads", async () => {
  const harness = await createPr2Harness();
  try {
    const expected = new Map(harness.runtimeIds.map(id => [id, harness.store.getRuntime(id)]));
    harness.probe.reset();
    const runtimes = harness.store.listRuntimesForWorkspace("local");
    expect(harness.probe.statements).toBe(4);
    expect(runtimes).toHaveLength(harness.runtimeIds.length);
    for (const runtime of runtimes) expect(runtime).toEqual(expected.get(runtime.id)!);
    // Rewriting the audit-only JSON must not change the canonical facts.
    harness.db.run("UPDATE multiremi_tasks SET usage = ? WHERE id = ?", JSON.stringify([{ input_tokens: 73, output_tokens: 91 }]), harness.fixture.taskIds[1]!);
    expect(harness.store.listRuntimesForWorkspace("local")).toEqual(runtimes);
    // A newer canonical revision must be visible on the next list, including settled usage.
    reportPr2Usage(harness.store, harness.fixture.taskIds[1]!, 1, 73, 91, 2);
    const updated = harness.store.listRuntimesForWorkspace("local").find(runtime => runtime.id === "rt_pr2_1");
    expect(updated).toEqual(harness.store.getRuntime("rt_pr2_1")!);
    expect(updated!.inputTokens).toBeGreaterThanOrEqual(73);
  } finally { await harness.dispose(); }
}, 20000);

it("orders equal-timestamp runtimes by id DESC on both list paths, excluding foreign rows", async () => {
  const harness = await createPr2Harness({ runtimes: 10, foreignRuntimes: 50 });
  try {
    harness.db.run("UPDATE multiremi_runtimes SET updated_at = ?", "2026-09-26T08:00:00.000Z");
    // The old PG query's observed tie order is now an explicit cross-backend contract.
    const expected = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => `rt_pr2_${n}`).concat("rt_hotspot");
    const legacy = harness.store.listRuntimes();
    expect(legacy.map(runtime => runtime.id)).toEqual([...legacy.map(runtime => runtime.id)].sort().reverse());
    expect(legacy.filter(runtime => runtime.workspaceId === "local").map(runtime => runtime.id)).toEqual(expected);
    expect(harness.store.listRuntimesForWorkspace("local").map(runtime => runtime.id)).toEqual(expected);
    await (await harness.app.request("/api/runtimes", { headers: harness.headers })).arrayBuffer();
    harness.probe.reset();
    const response = await harness.app.request("/api/runtimes", { headers: harness.headers });
    expect(response.status).toBe(200);
    expect((await response.json() as Array<{ id: string }>).map(runtime => runtime.id)).toEqual(expected);
    expect(harness.probe.statements).toBe(6);
  } finally { await harness.dispose(); }
}, 20000);
