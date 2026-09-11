import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseDaemonWebSocketHeartbeat } from "@multiremi/api/realtime.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const summary = {
  key: ".",
  name: "directory-helper",
  description: "Read the selected directory",
  sourcePath: "/home/me/custom-skills",
  provider: "codex",
  fileCount: 1,
};

function fixture() {
  const store = createStore();
  const runtime = store.registerRuntime({ name: "Directory runtime", provider: "codex", workspaceId: "local" });
  const app = createMultiremiApp({ store });
  const post = (path: string, body?: unknown) => app.request(path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const completeScan = (root?: string) => {
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, root ? { root } : {});
    return store.reportRuntimeLocalSkillListResult(runtime.id, scan.id, {
      status: "completed", root, skills: [summary],
    });
  };
  return { store, runtime, app, post, completeScan };
}

describe("Runtime skill directories", () => {
  it("binds selected skills to the resolved scan root through heartbeat, report and import", async () => {
    const { store, runtime, app, post } = fixture();
    const response = await post(`/api/runtimes/${runtime.id}/local-skills`, { root: "~/.agents/custom-skills" });
    expect(response.status).toBe(200);
    const scan = await response.json();
    expect(scan.root).toBe("~/.agents/custom-skills");
    const heartbeat = await (await post("/api/daemon/heartbeat", {
      runtime_id: runtime.id, supports_skill_directory: true,
    })).json();
    expect(heartbeat.pending_local_skills).toEqual({ id: scan.id, root: "~/.agents/custom-skills" });
    expect((await post(`/api/daemon/runtimes/${runtime.id}/local-skills/${scan.id}/result`, {
      status: "completed",
      root: "/home/me/.agents/custom-skills",
      warnings: ["A nested directory could not be read"],
      skills: [
        { ...summary, source_path: "/home/me/.agents/custom-skills", file_count: 1 },
        { ...summary, key: "binary", name: "binary", error: "Contains unsupported binary files" },
      ],
    })).status).toBe(200);
    const result = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/${scan.id}`)).json();
    expect(result).toMatchObject({ status: "completed", root: "/home/me/.agents/custom-skills", warnings: ["A nested directory could not be read"] });
    expect(result.skills[1].error).toBe("Contains unsupported binary files");

    const imported = await (await post(`/api/runtimes/${runtime.id}/local-skills/import`, {
      scan_request_id: scan.id, skill_key: ".", root: "/untrusted/request/root",
    })).json();
    expect(imported.root).toBe("/home/me/.agents/custom-skills");
    const importHeartbeat = await (await post("/api/daemon/heartbeat", {
      runtime_id: runtime.id, supports_skill_directory: true, supports_batch_import: true,
    })).json();
    expect(importHeartbeat.pending_local_skill_import).toEqual({ id: imported.id, skill_key: ".", root: imported.root });
    expect(importHeartbeat.pending_local_skill_imports).toEqual([importHeartbeat.pending_local_skill_import]);
    expect((await post(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${imported.id}/result`, {
      status: "completed",
      skill: { name: summary.name, content: "# Directory helper", source_path: imported.root, files: [{ path: "notes.md", content: "# Directory notes" }] },
    })).status).toBe(200);
    const importResult = store.getRuntimeLocalSkillImportRequest(runtime.id, imported.id)!;
    expect(importResult.error).toBeNull();
    expect(importResult.status).toBe("completed");
    expect(store.getSkill(importResult.skillId!)?.config?.origin).toMatchObject({ source_path: imported.root, runtime_id: runtime.id });
  });

  it("rejects imports from another runtime, incomplete or unsupported scans, missing keys and blocked skills", async () => {
    const { store, runtime, post, completeScan } = fixture();
    const otherRuntime = store.registerRuntime({ name: "Other runtime", provider: "codex" });
    const completed = completeScan("/custom/skills");
    const pending = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/pending" });
    const unsupported = store.createRuntimeLocalSkillListRequest(runtime.id);
    store.reportRuntimeLocalSkillListResult(runtime.id, unsupported.id, { status: "completed", supported: false, skills: [summary] });
    const blocked = store.createRuntimeLocalSkillListRequest(runtime.id);
    store.reportRuntimeLocalSkillListResult(runtime.id, blocked.id, { status: "completed", skills: [{ ...summary, error: "Unreadable file" }] });
    for (const [runtimeId, scanId, key, error] of [
      [otherRuntime.id, completed.id, ".", "not found for this runtime"],
      [runtime.id, pending.id, ".", "completed and supported"],
      [runtime.id, unsupported.id, ".", "completed and supported"],
      [runtime.id, completed.id, "different", "not found in the selected scan"],
      [runtime.id, blocked.id, ".", "Unreadable file"],
    ]) {
      const response = await post(`/api/multiremi/runtimes/${runtimeId}/local-skills/import`, { scanRequestId: scanId, skillKey: key });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(error);
    }
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_local_skill_import_requests").get()).toEqual({ count: 0 });
  });

  it("preserves scan keys so whitespace directory names cannot alias a valid sibling", async () => {
    const { store, runtime, app, post } = fixture();
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/custom/skills" });
    expect((await post(`/api/daemon/runtimes/${runtime.id}/local-skills/${scan.id}/result`, {
      status: "completed",
      root: "/custom/skills",
      skills: [
        { ...summary, key: " helper", name: "leading helper", error: "Leading whitespace is unsupported" },
        { ...summary, key: "helper", name: "valid helper" },
        { ...summary, key: "helper ", name: "trailing helper", error: "Trailing whitespace is unsupported" },
      ],
    })).status).toBe(200);
    const result = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/${scan.id}`)).json();
    expect(result.skills.map((skill: { key: string }) => skill.key)).toEqual([" helper", "helper", "helper "]);
    const imported = await post(`/api/runtimes/${runtime.id}/local-skills/import`, { scan_request_id: scan.id, skill_key: "helper" });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ skill_key: "helper", root: "/custom/skills" });
    for (const [key, error] of [[" helper", "Leading whitespace"], ["helper ", "Trailing whitespace"]]) {
      const rejected = await post(`/api/runtimes/${runtime.id}/local-skills/import`, { scan_request_id: scan.id, skill_key: key });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error).toContain(error);
    }
    const missing = await post(`/api/runtimes/${runtime.id}/local-skills/import`, { scan_request_id: scan.id, skill_key: " helper " });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("not found in the selected scan");
    expect(store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: " legacy " }).skillKey).toBe("legacy");
  });

  it("fails custom requests for an old daemon while still delivering default-directory requests", async () => {
    const { store, runtime, post, completeScan } = fixture();
    const customScan = completeScan("/custom/skills");
    const customImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { scanRequestId: customScan.id, skillKey: "." });
    const customPending = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/custom/next" });
    const defaultList = store.createRuntimeLocalSkillListRequest(runtime.id);
    const defaultImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "legacy" });
    const heartbeat = await (await post("/api/daemon/heartbeat", { runtime_id: runtime.id })).json();
    expect(heartbeat.pending_local_skills).toEqual({ id: defaultList.id });
    expect(heartbeat.pending_local_skill_import).toEqual({ id: defaultImport.id, skill_key: "legacy" });
    for (const request of [
      store.getRuntimeLocalSkillListRequest(runtime.id, customPending.id)!,
      store.getRuntimeLocalSkillImportRequest(runtime.id, customImport.id)!,
    ]) {
      expect(request.status).toBe("failed");
      expect(request.error).toContain("upgrade the runtime daemon");
    }
    await post(`/api/daemon/runtimes/${runtime.id}/local-skills/${customPending.id}/result`, { status: "completed", root: "/wrong", skills: [summary] });
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, customPending.id)?.status).toBe("failed");
  });

  it("enforces directory capability on direct claim endpoints too", async () => {
    const { store, runtime, post, completeScan } = fixture();
    const completed = completeScan("/custom/skills");
    for (const supported of [false, true]) {
      const list = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/custom/next" });
      const imported = store.createRuntimeLocalSkillImportRequest(runtime.id, { scanRequestId: completed.id, skillKey: "." });
      const query = supported ? "?supports_skill_directory=true" : "";
      const claimedList = await (await post(`/api/daemon/runtimes/${runtime.id}/local-skills/claim${query}`)).json();
      const claimedImports = await (await post(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim${query}`)).json();
      if (supported) {
        expect(claimedList.request).toMatchObject({ id: list.id, root: "/custom/next", status: "running" });
        expect(claimedImports.requests).toHaveLength(1);
        expect(claimedImports.requests[0]).toMatchObject({ id: imported.id, root: "/custom/skills", status: "running" });
      } else {
        expect(claimedList.request).toBeNull();
        expect(claimedImports.requests).toEqual([]);
        expect(store.getRuntimeLocalSkillListRequest(runtime.id, list.id)?.status).toBe("failed");
        expect(store.getRuntimeLocalSkillImportRequest(runtime.id, imported.id)?.status).toBe("failed");
      }
    }
  });

  it("requires a resolved absolute root for custom scan completion and preserves legacy scan semantics", () => {
    const { store, runtime, completeScan } = fixture();
    for (const root of [undefined, "~/still-unresolved", "relative/path"]) {
      const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "~/custom" });
      const result = store.reportRuntimeLocalSkillListResult(runtime.id, scan.id, { status: "completed", root, skills: [summary] });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("absolute skill directory");
    }
    expect(completeScan("C:\\Users\\me\\skills").status).toBe("completed");
    const legacy = store.createRuntimeLocalSkillListRequest(runtime.id);
    const completedLegacy = store.reportRuntimeLocalSkillListResult(runtime.id, legacy.id, { status: "completed", root: "/ignored/default", skills: [summary] });
    expect(completedLegacy.root).toBeUndefined();
    const imported = store.createRuntimeLocalSkillImportRequest(runtime.id, { scanRequestId: legacy.id, skillKey: "." });
    expect(imported.root).toBeUndefined();
  });

  it("preserves whitespace in the resolved scan root through import dispatch", async () => {
    const { store, runtime, post } = fixture();
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/skills/link" });
    const root = "/skills/helper ";
    await post(`/api/daemon/runtimes/${runtime.id}/local-skills/${scan.id}/result`, {
      status: "completed", root, skills: [{ ...summary, source_path: root }],
    });
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, scan.id)?.root).toBe(root);
    const imported = await post(`/api/runtimes/${runtime.id}/local-skills/import`, {
      scan_request_id: scan.id, skill_key: ".",
    });
    expect(imported.status).toBe(200);
    expect((await imported.json()).root).toBe(root);
    const heartbeat = await (await post("/api/daemon/heartbeat", {
      runtime_id: runtime.id, supports_skill_directory: true,
    })).json();
    expect(heartbeat.pending_local_skill_import.root).toBe(root);
  });

  it("keeps private skill directories restricted to the runtime owner within a workspace", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ id: "bob", name: "Bob", role: "admin" });
    const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
    const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
    const runtime = store.registerRuntime({ name: "Alice public runtime", provider: "codex", ownerId: "alice", workspaceId: "local", visibility: "public", daemonId: "alice-daemon" });
    const daemon = await store.createAccessToken({ name: "Alice daemon", type: "daemon", userId: "alice", workspaceId: "local", daemonId: "alice-daemon" });
    const wrongDaemon = await store.createAccessToken({ name: "Wrong daemon", type: "daemon", userId: "bob", workspaceId: "local", daemonId: "bob-daemon" });
    const app = createMultiremiApp({ store, authToken: "directory-test-root" });
    const request = (path: string, token: string, body?: unknown) => app.request(path, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    const scanResponse = await request(`/api/runtimes/${runtime.id}/local-skills`, alice.token, { root: "/private/skills" });
    expect(scanResponse.status).toBe(200);
    const scan = await scanResponse.json();
    for (const prefix of ["/api/runtimes", "/api/multiremi/runtimes"]) {
      expect((await request(`${prefix}/${runtime.id}/local-skills`, bob.token, { root: "/private/skills" })).status).toBe(403);
      expect((await request(`${prefix}/${runtime.id}/local-skills/import`, bob.token, { scan_request_id: scan.id, skill_key: "." })).status).toBe(403);
      expect((await app.request(`${prefix}/${runtime.id}/local-skills/${scan.id}`, { headers: { Authorization: `Bearer ${bob.token}` } })).status).toBe(403);
    }
    const claim = `/api/daemon/runtimes/${runtime.id}/local-skills/claim?supports_skill_directory=true`;
    expect((await request(claim, wrongDaemon.token)).status).toBe(403);
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, scan.id)?.status).toBe("pending");
    expect((await request(claim, daemon.token)).status).toBe(200);
    expect((await request(`/api/daemon/runtimes/${runtime.id}/local-skills/${scan.id}/result`, wrongDaemon.token, { status: "failed", error: "not owner" })).status).toBe(403);
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, scan.id)?.status).toBe("running");
  });

  it("rejects malformed directory and scan inputs without silently selecting the default directory", async () => {
    const { runtime, post } = fixture();
    for (const prefix of ["/api/runtimes", "/api/multiremi/runtimes"]) {
      for (const input of [null, [], { root: 42 }]) {
        expect((await post(`${prefix}/${runtime.id}/local-skills`, input)).status).toBe(400);
      }
      for (const input of [null, [], { skill_key: "x", scan_request_id: "" }, { skill_key: "x", scan_request_id: null }, { skill_key: "x", scan_request_id: {} }]) {
        expect((await post(`${prefix}/${runtime.id}/local-skills/import`, input)).status).toBe(400);
      }
      expect((await post(`${prefix}/${runtime.id}/local-skills`)).status).toBe(200);
    }
  });

  it("recognizes the capability on both websocket heartbeat forms and the legacy HTTP heartbeat", async () => {
    const { store, runtime, post } = fixture();
    expect(parseDaemonWebSocketHeartbeat({ runtime_id: runtime.id, supports_skill_directory: true }).supportsSkillDirectory).toBe(true);
    expect(parseDaemonWebSocketHeartbeat({ payload: { runtime_id: runtime.id, supports_skill_directory: true } }).supportsSkillDirectory).toBe(true);
    expect(parseDaemonWebSocketHeartbeat({ runtime_id: runtime.id }).supportsSkillDirectory).toBe(false);
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/custom/skills" });
    const response = await (await post(`/api/multiremi/runtimes/${runtime.id}/heartbeat?supports_skill_directory=true`)).json();
    expect(response.pending_local_skills).toEqual({ id: scan.id, root: "/custom/skills" });
  });

  it("upgrades existing request tables while retaining queued legacy requests", () => {
    const { store, runtime } = fixture();
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id);
    const imported = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "legacy" });
    db!.run("ALTER TABLE multiremi_runtime_local_skill_list_requests DROP COLUMN root");
    db!.run("ALTER TABLE multiremi_runtime_local_skill_list_requests DROP COLUMN warnings");
    db!.run("ALTER TABLE multiremi_runtime_local_skill_import_requests DROP COLUMN root");
    const upgraded = new MultiremiStore(db!);
    expect(upgraded.getRuntimeLocalSkillListRequest(runtime.id, scan.id)?.status).toBe("pending");
    expect(upgraded.getRuntimeLocalSkillImportRequest(runtime.id, imported.id)?.status).toBe("pending");
    expect(upgraded.createRuntimeLocalSkillListRequest(runtime.id, { root: "/after/upgrade" }).root).toBe("/after/upgrade");
  });
});
