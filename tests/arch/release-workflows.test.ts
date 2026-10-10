import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dir, "../..");

function readWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8"));
}

describe("release workflows", () => {
  test("release publication uses a prepared snapshot and exact-commit full CI before building", () => {
    const release = readWorkflow("release.yml");
    const steps = release.jobs.release.steps;
    const gate = steps.findIndex((step: any) => step.run?.includes("release:check --tag"));
    const build = steps.findIndex((step: any) => step.run?.includes("bun run build:multiremi"));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
    const candidate = steps.findIndex((step: any) => step.run?.includes("scripts/release-candidate.ts resolve"));
    expect(candidate).toBeGreaterThan(gate);
    expect(candidate).toBeLessThan(build);
    expect(steps[candidate].run).toContain("--kind cli");
    expect(steps[build].if).toBe("steps.candidate.outputs.reused != 'true'");
    const resolver = readFileSync(resolve(repoRoot, "scripts/release-candidate.ts"), "utf8");
    expect(resolver).toContain("runs?head_sha=${sha}&branch=main&status=success");
    expect(resolver).toContain('["push", "workflow_dispatch"].includes(run.event)');
    expect(resolver).toContain('job.name === "backend-evidence"');
    expect(resolver).toContain('job.name === "backend-retry"');
    expect(resolver).toContain("if (candidate) return false");
    expect(release.jobs.release.permissions.actions).toBe("read");
    expect(JSON.stringify(release)).not.toContain("release:prepare");
    const ci = readWorkflow("release-build-check.yml");
    expect(JSON.stringify(ci.jobs.guards.steps)).toContain("release:check --base-ref");
    expect(ci.jobs.guards.steps[0].with["fetch-depth"]).toBe(0);
    expect(ci.jobs["session-archive-platform"].strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(JSON.stringify(ci)).toContain("runtime prepare --provider claude --provider codex");
  });

  test("parallel backend remains an exact-coverage gate with independent services", () => {
    const ci = readWorkflow("release-build-check.yml");
    expect(ci.jobs.backend.strategy.matrix.shard).toEqual([0, 1, 2, 3]);
    expect(ci.jobs.backend.strategy["fail-fast"]).toBe(false);
    expect(ci.jobs.backend.services.postgres.image).toBe("pgvector/pgvector:pg17");
    const shard = ci.jobs.backend.steps.find((step: any) => step.name === "Backend test shard");
    expect(shard.env.MULTIREMI_TEST_POSTGRES_URL).toBe("postgres://multimira:multimira@localhost:5432/postgres");
    expect(shard.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL).toBe("1");
    expect(ci.jobs.build.if).toBe("always()");
    expect(ci.jobs.build.needs).toContain("backend-evidence");
    expect(ci.jobs.build.needs).toContain("backend-retry");
    const summary = ci.jobs.build.steps[0].run;
    expect(summary).toContain("result == expected");
    expect(summary).toContain("verified-retry");
    expect(JSON.stringify(ci.jobs["backend-evidence"])).toContain("scripts/ci-backend.ts verify");
    expect(JSON.stringify(ci.jobs["backend-retry"])).toContain("scripts/retry-failed-backend-tests.ts");
  });

  test("candidate producer shares one checked main flag and retains full validation and immutable OCI inputs", () => {
    const ci = readWorkflow("release-build-check.yml");
    expect(ci.on.workflow_dispatch.inputs.release_candidate.default).toBe(false);
    expect(ci.jobs.guards.outputs.candidate).toBe("${{ steps.candidate.outputs.enabled }}");
    expect(ci.jobs["candidate-package"].needs).toEqual(["build", "guards"]);
    expect(ci.jobs["candidate-package"].if).toBe("needs.guards.outputs.candidate == 'true'");
    const create = ci.jobs["candidate-package"].steps.find((step: any) => step.run?.includes("scripts/release-candidate.ts create"));
    expect(create.env.RELEASE_BASE_SHA).toBe("${{ github.event.before }}");
    expect(create.env.RELEASE_CANDIDATE_REQUEST).toBe("${{ inputs.release_candidate }}");
    expect(create.env.RETRY_BACKEND_RUN_ID).toBe("${{ inputs.retry_backend_run_id }}");
    expect(ci.jobs["candidate-package"].steps[0].with["fetch-depth"]).toBe(0);
    expect(JSON.stringify(ci.jobs["candidate-package"])).toContain("scripts/release-candidate.ts create");
    const finalUpload = ci.jobs["candidate-package"].steps.find((step: any) => step.uses === "actions/upload-artifact@v4");
    expect(finalUpload.with.path).toBe("candidate/release-candidate.json");
    expect(finalUpload.with["retention-days"]).toBe(30);
    for (const kind of ["cli", "api", "web"]) {
      expect(ci.jobs[`${kind}-build`].needs).toBe("guards");
      const version = ci.jobs[`${kind}-build`].steps.find((step: any) => step.env?.CANDIDATE);
      expect(version.env.CANDIDATE).toBe("${{ needs.guards.outputs.candidate }}");
      const upload = ci.jobs[`${kind}-build`].steps.find((step: any) => step.uses === "actions/upload-artifact@v4");
      expect(upload.if).toBe(ci.jobs["candidate-package"].if);
      expect(upload.with["retention-days"]).toBe(30);
      expect(upload.with["compression-level"]).toBe(0);
    }
    for (const kind of ["api", "web"]) {
      const image = ci.jobs[`${kind}-build`].steps.find((step: any) => step.uses === "docker/build-push-action@v6");
      expect(image.with.platforms).toBe("linux/amd64");
      expect(image.with.provenance).toBe(false);
      expect(image.with.outputs).toContain("oci-mediatypes=true");
      expect(image.with.outputs).toContain("needs.guards.outputs.candidate == 'true'");
      expect(image.with.labels).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    }
    const platform = readWorkflow("platform-release.yml");
    const publish = platform.jobs.publish.steps.find((step: any) => step.name === "Publish verified candidate images without rebuilding");
    expect(publish.run).toContain("--preserve-digests");
  });

  test("real candidate selection enables new-version main pushes and manual requests without PR or retry promotion", () => {
    const ci = readWorkflow("release-build-check.yml");
    const select = ci.jobs.guards.steps.find((step: any) => step.id === "candidate");
    const reject = ci.jobs.guards.steps.find((step: any) => step.name === "Reject invalid candidate requests");
    expect(reject.if).toBe("inputs.release_candidate");
    expect(select.env.VERSION_CHANGED).toBe("${{ steps.release.outputs.version_changed }}");
    const directory = mkdtempSync(join(tmpdir(), "release-candidate-selection-"));
    const output = join(directory, "output");
    try {
      for (const [event, ref, changed, requested, retry, enabled, rejected] of [
        ["push", "refs/heads/main", "true", "", "", true, false],
        ["push", "refs/heads/main", "false", "", "", false, false],
        ["push", "refs/heads/main", "", "", "", false, false],
        ["push", "refs/heads/feature", "true", "", "", false, false],
        ["pull_request", "refs/pull/1/merge", "true", "", "", false, false],
        ["workflow_dispatch", "refs/heads/main", "false", "true", "", true, false],
        ["workflow_dispatch", "refs/heads/main", "true", "false", "", false, false],
        ["workflow_dispatch", "refs/heads/main", "true", "", "123", false, false],
        ["workflow_dispatch", "refs/heads/main", "true", "true", "123", false, true],
        ["workflow_dispatch", "refs/heads/feature", "true", "true", "", false, true],
      ] as const) {
        writeFileSync(output, "");
        const env = { ...process.env, EVENT: event, REF: ref, VERSION_CHANGED: changed, REQUESTED: requested, RETRY: retry, GITHUB_OUTPUT: output };
        const run = (script: string) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd: directory, env, encoding: "utf8" });
        if (requested === "true") {
          const result = run(reject.run);
          expect(result.error).toBeUndefined();
          expect(result.status === 0).toBe(!rejected);
          if (rejected) {
            expect(readFileSync(output, "utf8")).toBe("");
            continue;
          }
        }
        const result = run(select.run);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`enabled=${enabled}\n`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("PR guards exercise only the bounded CI orchestration regressions in GitHub log mode", () => {
    const ci = readWorkflow("release-build-check.yml");
    const step = ci.jobs.guards.steps.find((step: any) => step.name === "CI orchestration regression tests");
    expect(step.if).toBeUndefined();
    expect(step.env).toEqual({ CI: "true", GITHUB_ACTIONS: "true" });
    expect(step.run.trim().split(/\s+/)).toEqual(["bun", "run", "test", ...[
      "ci-backend", "run-tests", "run-tests-signals", "retry-failed-backend-tests", "release-candidate",
    ].map(name => `tests/unit/scripts/${name}.test.ts`)]);
    expect(ci.jobs["backend-plan"].if).toContain("github.event_name != 'pull_request'");
  });

  test("publishes the platform automatically after the tag release", () => {
    const release = readWorkflow("release.yml");
    expect(release.on.push.tags).toContain("v*");
    expect(release.jobs.platform.needs).toBe("release");
    expect(release.jobs.platform.uses).toBe("./.github/workflows/platform-release.yml");
    expect(release.jobs.platform.with.tag).toBe("${{ github.ref_name }}");
    expect(release.jobs.platform.permissions.packages).toBe("write");
    expect(release.jobs.platform.permissions.attestations).toBe("write");
  });

  test("keeps platform publication manually recoverable and source-bound", () => {
    const platform = readWorkflow("platform-release.yml");
    expect(platform.on.workflow_call.inputs.tag.type).toBe("string");
    expect(platform.on.workflow_dispatch.inputs.tag.type).toBe("string");

    const gate = platform.jobs.publish.steps.find((step: any) => step.run?.includes("scripts/release-candidate.ts resolve"));
    expect(gate?.run).toContain('--sha "${{ needs.validate.outputs.sha }}"');
    expect(gate?.run).toContain("--kind images");
    expect(gate?.env.GH_TOKEN).toBe("${{ github.token }}");

    const serialized = JSON.stringify(platform);
    expect(serialized).toContain("remi-api:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("remi-web:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("steps.images.outputs.api_digest");
    expect(serialized).toContain("steps.images.outputs.web_digest");
    expect(serialized).toContain("--clobber");
  });

  test("published image verification writes digests only after both image pairs are valid", () => {
    const platform = readWorkflow("platform-release.yml");
    const step = platform.jobs.publish.steps.find((step: any) => step.name === "Verify published image identity");
    const directory = mkdtempSync(join(tmpdir(), "release-image-verification-"));
    const output = join(directory, "outputs");
    const apiDigest = `sha256:${"a".repeat(64)}`, webDigest = `sha256:${"b".repeat(64)}`;
    try {
      writeFileSync(join(directory, "docker"), `#!/bin/sh
case "$4" in
  */remi-api:*) kind=api; digest="$API_DIGEST" ;;
  */remi-web:*) kind=web; digest="$WEB_DIGEST" ;;
  *) exit 90 ;;
esac
case "$4" in *:sha-*) ref=source ;; *) ref=version ;; esac
if [ "$kind/$ref" = "$FAIL_TARGET" ] || [ "$kind/both" = "$FAIL_TARGET" ]; then
  case "$SCENARIO" in
    mismatch) digest="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" ;;
    inspect-failure) printf '{"digest":"%s"}\\n' "$digest"; exit 17 ;;
    malformed) printf 'invalid JSON\\n'; exit 0 ;;
    missing) printf '{}\\n'; exit 0 ;;
    empty) digest= ;;
    invalid) digest="sha256:invalid" ;;
  esac
fi
printf '{"digest":"%s"}\\n' "$digest"
`, { mode: 0o755 });
      const cases = [{ scenario: "success", target: "" }, ...["mismatch", "inspect-failure", "malformed", "missing", "empty", "invalid"].flatMap(scenario => {
        // Identical invalid values must fail even though the tag pair agrees.
        const targets = ["empty", "invalid"].includes(scenario) ? ["api/both", "web/both"] : ["api/version", "api/source", "web/version", "web/source"];
        return targets.map(target => ({ scenario, target }));
      })];
      for (const { scenario, target } of cases) {
        writeFileSync(output, "");
        const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run], {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, REGISTRY: "ghcr.io", GITHUB_REPOSITORY_OWNER: "Example",
            TAG: "v1.2.3", SHA: "d".repeat(40), GITHUB_OUTPUT: output, API_DIGEST: apiDigest, WEB_DIGEST: webDigest, SCENARIO: scenario, FAIL_TARGET: target },
        });
        expect(result.error).toBeUndefined();
        const outputs = readFileSync(output, "utf8");
        if (scenario === "success") {
          expect(result.status).toBe(0);
          expect(outputs).toBe(`api_digest=${apiDigest}\nweb_digest=${webDigest}\n`);
        } else {
          expect({ scenario, target, failed: result.status !== 0, outputs }).toEqual({ scenario, target, failed: true, outputs: "" });
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
