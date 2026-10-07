import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { createStartupCompose } from "../../../scripts/check-compose-startup.js";

const root = resolve(import.meta.dir, "../../..");
const template = parse(readFileSync(resolve(root, "deploy/docker/compose.application.yml"), "utf8"));

describe("real Docker startup reproduction fixture", () => {
  it("uses the template healthcheck verbatim in both API roles and changes only start_period for the control", () => {
    const positive = createStartupCompose(template, true);
    const control = createStartupCompose(template, false);
    for (const name of ["api", "api-runtime"] as const) {
      expect(positive.services[name].healthcheck).toEqual(template.services.api.healthcheck);
      expect(control.services[name].healthcheck.start_period).toBeUndefined();
      control.services[name].healthcheck.start_period = template.services.api.healthcheck.start_period;
    }
    expect(control).toEqual(positive);
    expect(positive.services["api-runtime"].profiles).toEqual(["split"]);
    expect(positive.services.api.command.join(" ")).toContain("Bun.sleep(150000)");
    expect(positive.services.api.command.join(" ")).toContain("port:6120");
    expect(positive.services.web.depends_on).toEqual(template.services.web.depends_on);
    expect(template.services.api.healthcheck.start_period).toBe("360s");
  });

  it("restricts the long Docker workflow to deployment/updater/script changes and manual dispatch", () => {
    const workflow = parse(readFileSync(resolve(root, ".github/workflows/platform-compose-startup.yml"), "utf8"));
    const paths = ["deploy/docker/**", "packages/platform-updater/**", "scripts/check-compose-startup.ts"];
    expect(workflow.on.pull_request.paths).toEqual(paths);
    expect(workflow.on.push.paths).toEqual(paths);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(workflow.jobs.startup.steps.some((step: { run?: string }) => step.run === "bun run scripts/check-compose-startup.ts")).toBe(true);
  });
});
