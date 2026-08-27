// MUL-155: the application Compose stack is the only controlled path that can
// wire the Feishu ingestion sidecar. These assertions guard the deployment
// invariants that the API cannot enforce at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dir, "../..");
const compose = parse(readFileSync(resolve(repoRoot, "deploy/docker/compose.application.yml"), "utf8")) as {
  services: Record<string, Record<string, any>>;
  volumes?: Record<string, unknown>;
};
const envExample = readFileSync(resolve(repoRoot, "deploy/docker/application.env.example"), "utf8");

describe("application compose stack", () => {
  test("keeps the Feishu sidecar profile-gated and off by default", () => {
    const sidecar = compose.services["feishu-sidecar"];
    expect(sidecar?.profiles).toEqual(["feishu-sidecar"]);
    // An existing installation that never sets COMPOSE_PROFILES must keep the
    // exact API/Web/control-plane topology it has today.
    expect(envExample).not.toMatch(/^COMPOSE_PROFILES=/mu);
    expect(envExample).not.toMatch(/^REMI_FEISHU_SIDECAR_ENDPOINTS=/mu);
  });

  test("binds the sidecar to the API network namespace with no reachable surface", () => {
    const sidecar = compose.services["feishu-sidecar"]!;
    expect(sidecar.network_mode).toBe("service:api");
    // The sidecar listens on loopback only. Publishing or bridging it would
    // both break that contract and expose an unauthenticated agent API.
    expect(sidecar.ports).toBeUndefined();
    expect(sidecar.expose).toBeUndefined();
    expect(sidecar.networks).toBeUndefined();
    expect(sidecar.healthcheck.test.join(" ")).toContain("http://127.0.0.1:8042/healthz");
  });

  test("passes the endpoint registry as deployment configuration, defaulting to fail-closed", () => {
    // The registry maps a name to an internal URL server-side. Nothing in the
    // browser may supply a URL, so it can only arrive through this file.
    expect(compose.services.api!.environment.MULTIREMI_FEISHU_SIDECAR_ENDPOINTS)
      .toBe("${REMI_FEISHU_SIDECAR_ENDPOINTS:-}");
    expect(envExample).toContain("REMI_FEISHU_SIDECAR_ENDPOINTS=personal=http://127.0.0.1:8042");
  });

  test("grants no container the Docker socket or host control", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      const volumes: string[] = (service.volumes ?? []).filter((entry: unknown) => typeof entry === "string");
      for (const volume of volumes) {
        expect(volume, `${name} volume ${volume}`).not.toContain("docker.sock");
        expect(volume, `${name} volume ${volume}`).not.toContain("/run/systemd");
      }
      expect(service.privileged, `${name} privileged`).toBeUndefined();
    }
    // Host networking stays limited to the control plane, which needs the host
    // sshd and host keys.
    const hostNetworked = Object.entries(compose.services)
      .filter(([, service]) => service.network_mode === "host")
      .map(([name]) => name);
    expect(hostNetworked).toEqual(["ssh-mesh-control-plane"]);
  });
});
