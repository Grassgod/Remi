// MUL-205: Feishu ingestion runs inside the API container through lark-cli,
// so the deployment has no ingestion service, port, or endpoint registry left
// to get wrong. These assertions guard the invariants the API cannot enforce
// at runtime.
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
const apiEnvExample = readFileSync(resolve(repoRoot, "deploy/docker/api.env.example"), "utf8");
const apiDockerfile = readFileSync(resolve(repoRoot, "deploy/docker/Dockerfile.api"), "utf8");

describe("application compose stack", () => {
  test("ships no ingestion service, profile, or endpoint registry", () => {
    // The sidecar is retired. Anything left behind here — a service, a profile
    // to enable it, an endpoint name to point at it — would be config that
    // nothing reads, which is how an operator ends up debugging a dead process.
    expect(Object.keys(compose.services).sort()).toEqual(["api", "ssh-mesh-control-plane", "web"]);
    expect(compose.volumes).toBeUndefined();
    expect(envExample).not.toMatch(/^COMPOSE_PROFILES=/mu);
    expect(envExample).not.toMatch(/^REMI_FEISHU_SIDECAR/mu);
    for (const [name, service] of Object.entries(compose.services)) {
      const environment: Record<string, unknown> = service.environment ?? {};
      for (const key of Object.keys(environment)) {
        expect(key, `${name} env ${key}`).not.toContain("SIDECAR");
      }
    }
  });

  test("bakes a pinned, checksum-verified lark-cli into the API image", () => {
    // The Provider spawns `lark-cli` by name, so it has to be on PATH in the
    // API container. Pinning it keeps the image reproducible, and the digest
    // check is what makes downloading a binary at build time acceptable.
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_VERSION=\d+\.\d+\.\d+$/mu);
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_SHA256_AMD64=[a-f0-9]{64}$/mu);
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_SHA256_ARM64=[a-f0-9]{64}$/mu);
    expect(apiDockerfile).toContain("sha256sum -c -");
    expect(apiDockerfile).toContain("/usr/local/bin/lark-cli");
  });

  test("keeps the Feishu credential out of every file in this repository", () => {
    // lark-cli writes its credential into the container's home, which is a bind
    // mount an operator owns. It must never travel through Compose or an env
    // file, both of which are committed as examples and read by the whole team.
    const home = (compose.services.api!.volumes as string[])
      .find((entry) => entry.endsWith(":/srv/multiremi"));
    expect(home).toBe("${REMI_HOME_DIR:?set REMI_HOME_DIR}:/srv/multiremi");
    expect(compose.services.api!.environment.HOME).toBe("/srv/multiremi");
    for (const source of [envExample, apiEnvExample]) {
      expect(source).not.toMatch(/^[A-Z_]*LARK[A-Z_]*=/mu);
      expect(source).not.toMatch(/^MULTIREMI_FEISHU_(?:APP_SECRET|SIDECAR)[A-Z_]*=/mu);
    }
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
