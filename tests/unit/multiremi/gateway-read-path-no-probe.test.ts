/**
 * MUL-338 round C — reading the model catalog must not probe the gateway.
 *
 * The agent model-selection surfaces used to refresh a stale snapshot on the
 * read path (`refreshStaleGatewayModels`, 1h TTL). That made a page view depend
 * on a third-party network round trip: a slow or unreachable gateway delayed the
 * dropdown, and an unreachable one rewrote the snapshot with an error the
 * operator never asked for. Discovery is now an explicit-action concern only —
 * saving the relay config, flipping the auto-discovery toggle, pressing 立即探测.
 *
 * How "no longer probes" is proven here. The read path does not import the
 * discovery module at all, so there is no seam to inject a counting transport
 * into (the architecture guard in tests/arch pins that). What is observable
 * instead is the *result* of a probe: every discovery run ends in
 * `saveGatewayModels`, which always rewrites the row (models, last_success_at,
 * last_error, updated_at). So a read that leaves the row byte-identical cannot
 * have probed — and the positive controls below show that the very same fixture
 * does change the row the moment an explicit action runs.
 *
 * Detection limitation, stated plainly: this is a behavioural proof, not a
 * transport-level one. It cannot distinguish "did not probe" from "probed and
 * wrote back exactly the same bytes", which for this snapshot shape is not
 * expressible — a failed run records `last_error`, a successful one moves
 * `last_success_at`, and both move `updated_at`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { probeGatewayModels } from "@multiremi/relay/discovery.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/** RFC 2606 reserved TLD: passses URL validation, never resolves. */
const UNREACHABLE_FRAG = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.invalid" } });
const STALE_AT = "2020-01-01T00:00:00.000Z";

const TOKEN = "sk-ant-do-not-leak";

interface SnapshotRow {
  models: string;
  source_revision: number;
  last_success_at: string | null;
  last_error: string | null;
  native_catalog_status: string | null;
  updated_at: string | null;
}

function snapshotRow(engine = "claude"): SnapshotRow | null {
  return db!.query(
    `SELECT models, source_revision, last_success_at, last_error, native_catalog_status, updated_at
       FROM multiremi_gateway_models WHERE workspace_id = ? AND engine = ?`,
  ).get("local", engine) as SnapshotRow | null;
}

/** Age the snapshot past any TTL the old read path may still be carrying. */
function backdate(engine = "claude"): void {
  db!.run(
    "UPDATE multiremi_gateway_models SET last_success_at = ?, updated_at = ? WHERE workspace_id = ? AND engine = ?",
    [STALE_AT, STALE_AT, "local", engine],
  );
}

function setup(options: { snapshot: "stale" | "failed" | "empty" }) {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: UNREACHABLE_FRAG, tokenOp: "set", authToken: TOKEN,
  });
  if (options.snapshot !== "empty") {
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision,
      models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }, { id: "deepseek-flash", label: "DeepSeek Flash" }],
    });
    if (options.snapshot === "failed") {
      store.saveGatewayModels("local", "claude", { sourceRevision: revision, error: "gateway HTTP 503" });
    } else {
      backdate();
    }
  }
  const runtime = store.registerRuntime({
    name: "claude-0", provider: "claude", workspaceId: "local",
    models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic", default: true }],
  });
  store.updateRuntime(runtime.id, { executionGroupId: "probe-group" });
  const agent = store.createAgent({ name: "reader", provider: "claude", model: "claude-fable-5-1" });
  return {
    store, runtime, agent,
    app: createMultiremiApp({ store, authToken: "MASTER" }),
    headers: { Authorization: "Bearer MASTER", "Content-Type": "application/json" },
  };
}

/** Every catalog surface the agent UI and the settings page read. */
function readPaths(fixture: ReturnType<typeof setup>) {
  return [
    "/api/models",
    "/api/multiremi/models",
    `/api/models?runtime_id=${fixture.runtime.id}&agent_id=${fixture.agent.id}`,
    `/api/models?execution_group_id=probe-group&agent_id=${fixture.agent.id}`,
    "/api/workspaces/local/relay-config/claude/reasoning-levels",
  ];
}

describe("MUL-338 round C: catalog reads never probe the gateway", () => {
  for (const shape of ["stale", "failed"] as const) {
    it(`leaves a ${shape} snapshot byte-identical across every read shape`, async () => {
      const fixture = setup({ snapshot: shape });
      const before = snapshotRow();
      expect(before).not.toBeNull();

      for (const path of readPaths(fixture)) {
        const response = await fixture.app.request(path, { headers: fixture.headers });
        expect(response.status, path).toBe(200);
        // Even a stale snapshot keeps being reported: reads serve what is stored
        // instead of silently refreshing it behind the operator's back.
        expect(snapshotRow(), path).toEqual(before);
      }

      // The failure shape keeps its error exactly as recorded, and the stale one
      // keeps its (old) success timestamp — neither is rewritten by a read.
      if (shape === "failed") {
        expect(snapshotRow()?.last_error).toBe("gateway HTTP 503");
      } else {
        expect(snapshotRow()?.last_success_at).toBe(STALE_AT);
        expect(snapshotRow()?.last_error).toBeNull();
      }
    });
  }

  it("does not invent a snapshot when none was ever taken", async () => {
    const fixture = setup({ snapshot: "empty" });
    expect(snapshotRow()).toBeNull();

    for (const path of readPaths(fixture)) {
      const response = await fixture.app.request(path, { headers: fixture.headers });
      expect(response.status, path).toBe(200);
      expect(snapshotRow(), path).toBeNull();
    }
  });

  it("still probes when an explicit action asks for it", async () => {
    const fixture = setup({ snapshot: "stale" });
    // Positive control #1: the discovery entry the probe endpoint and the
    // config-save path call. The transport is injected here so the proof does
    // not depend on the sandbox having a resolver.
    const urls: string[] = [];
    await probeGatewayModels(fixture.store, "local", "claude", {
      httpGet: async (url) => {
        urls.push(url);
        return { status: 200, text: JSON.stringify({ data: [{ id: "fresh-model", display_name: "Fresh" }] }) };
      },
    });

    expect(urls).toEqual(["https://gateway.invalid/v1/models"]);
    expect(snapshotRow()?.models).toContain("fresh-model");
    expect(snapshotRow()?.updated_at).not.toBe(STALE_AT);
  }, 20_000);

  it("still probes from the 立即探测 endpoint", async () => {
    const fixture = setup({ snapshot: "stale" });
    const before = snapshotRow();
    expect(before?.last_error).toBeNull();

    const response = await fixture.app.request("/api/workspaces/local/relay-config/claude/probe", {
      method: "POST", headers: fixture.headers, body: "{}",
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; error: string | null };
    // The endpoint reaches the real transport, which fails on the reserved TLD:
    // the recorded error is the observable proof that a probe ran.
    expect(body.status).toBe("error");
    expect(body.error).toBeTruthy();
    expect(snapshotRow()).not.toEqual(before);
    expect(snapshotRow()?.last_error).toBe(body.error);
    expect(JSON.stringify(snapshotRow())).not.toContain(TOKEN);
    // The previous catalog survives the failed attempt, so a read right after a
    // failed probe still lists the models.
    expect(snapshotRow()?.models).toContain("claude-fable-5-1");
  }, 20_000);

  it("still probes when the relay config is saved", async () => {
    const fixture = setup({ snapshot: "stale" });
    const before = snapshotRow();
    expect(before?.last_error).toBeNull();

    const response = await fixture.app.request("/api/workspaces/local/relay-config/claude", {
      method: "PUT", headers: fixture.headers,
      body: JSON.stringify({ fragment: UNREACHABLE_FRAG, token_op: "keep" }),
    });

    expect(response.status).toBe(200);
    expect(snapshotRow()).not.toEqual(before);
    expect(snapshotRow()?.last_error).toBeTruthy();
    expect(JSON.stringify(snapshotRow())).not.toContain(TOKEN);
  }, 20_000);
});
