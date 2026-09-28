import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DaemonV1ReleaseHarness } from "../fixtures/daemon-v1-release.js";
import { waitFor } from "../integration/daemon-protocol-v2/harness.js";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: bun tests/manual/probe-daemon-v1-release.ts <verified-release-archive>");
const daemon = DaemonV1ReleaseHarness.prepare(archive);
let db: Database | undefined;
let server: ReturnType<typeof startMultiremiServer> | undefined;
try {
  db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const credential = await store.createAccessToken({ name: "release fixture", type: "daemon", workspaceId: "local", daemonId: "dmn_release_fixture" });
  server = startMultiremiServer({ store, authToken: "isolated-release-fixture", backgroundJobs: false, apiRole: "all", peerChannel: null, daemonDirectBaseUrl: null, hostname: "127.0.0.1", port: 0 });
  daemon.start(`http://127.0.0.1:${server.port}`, credential.token);
  await waitFor(() => daemon.localPort() !== null, "legacy release local server");
  await waitFor(() => store.listRuntimes().some(runtime => runtime.daemonId === "dmn_release_fixture"), "legacy release registration");
  assert.equal((await daemon.health())?.cli_version, "v0.2.82");
  assert.equal(store.listRuntimes().find(runtime => runtime.daemonId === "dmn_release_fixture")?.metadata.cli_version, "v0.2.82");
  console.log("v0.2.82 verified release: local daemon started and registered; business assertions await MUL-419/MUL-421");
} finally {
  try { await daemon.dispose(); } finally {
    try { if (server) await waitFor(() => server!.pendingRequests === 0, "legacy release server requests to drain"); } finally {
      try { void server?.stop(true); } finally { db?.close(); }
    }
  }
}
