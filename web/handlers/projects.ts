import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ProjectStore } from "../../src/project/store.js";
import { GroupConfigStore } from "../../src/group/store.js";
import { execSync } from "node:child_process";

export function registerProjectHandlers(app: Hono, _data: RemiData) {
  const store = new ProjectStore();
  const gcStore = new GroupConfigStore();

  // List all projects with group counts
  app.get("/api/v1/projects", (c) => {
    const projects = store.list();
    const groupCounts = gcStore.countByProject();
    return c.json(
      projects.map((p) => ({
        ...p,
        groupCount: groupCounts[p.id] ?? 0,
      })),
    );
  });

  // Simple create (alias + path, for backward compat)
  app.post("/api/v1/projects", async (c) => {
    const { alias, path } = (await c.req.json()) as { alias: string; path: string };
    if (!alias || !path) return c.json({ error: "alias and path required" }, 400);

    const existing = store.getById(alias);
    if (existing) {
      store.updateField(alias, "cwd", path);
    } else {
      store.create({
        alias,
        name: alias,
        dirMode: "existing",
        existingPath: path,
      });
      store.updateInitStatus(alias, "completed");
    }
    return c.json({ ok: true });
  });

  // Update path
  app.put("/api/v1/projects/:alias", async (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const { path } = (await c.req.json()) as { path: string };
    if (!path) return c.json({ error: "path required" }, 400);

    const existing = store.getById(alias);
    if (!existing) return c.json({ error: "not found" }, 404);

    store.updateField(alias, "cwd", path);
    return c.json({ ok: true });
  });

  // Delete (soft)
  app.delete("/api/v1/projects/:alias", (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const ok = store.delete(alias);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Get project pipeline config
  app.get("/api/v1/projects/:id/config", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);

    const defaultConfig = {
      notifications: {
        dailyChangelog: { enabled: true, targets: [] },
        missionProgress: { enabled: true, targets: [] },
        evalReport: { enabled: true, targets: [] },
      },
      pipeline: {
        releaseBranch: "",
        skipRfc: false,
        skipDecompose: false,
        testCommand: "bun test",
        lintCommand: "",
        buildCommand: "",
      },
    };

    return c.json(project.pipelineConfig ?? defaultConfig);
  });

  // Update project pipeline config
  app.put("/api/v1/projects/:id/config", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const config = await c.req.json();

    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);

    store.updatePipelineConfig(id, config);
    return c.json({ ok: true });
  });

  // Create release PR: release branch → main
  app.post("/api/v1/projects/:id/release", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!project.cwd) return c.json({ error: "project has no cwd" }, 400);

    const cfg = (project.pipelineConfig as any) ?? {};
    const releaseBranch = cfg?.pipeline?.releaseBranch;
    if (!releaseBranch) return c.json({ error: "releaseBranch not configured" }, 400);

    try {
      // Extract version from branch name (e.g., "release/v2.0.7" → "v2.0.7", "release/1.2.0" → "v1.2.0")
      const version = releaseBranch.replace(/^release\//, "").replace(/^(?!v)/, "v");
      const semver = version.replace(/^v/, ""); // "2.0.7"

      // Bump version in pyproject.toml on release branch before creating MR
      try {
        execSync(`git checkout ${releaseBranch} && git pull origin ${releaseBranch}`, {
          cwd: project.cwd, encoding: "utf-8", timeout: 15000,
        });
        const pyprojectPath = require("node:path").join(project.cwd!, "pyproject.toml");
        if (require("node:fs").existsSync(pyprojectPath)) {
          const content = require("node:fs").readFileSync(pyprojectPath, "utf-8");
          const updated = content.replace(/^version\s*=\s*"[^"]*"/m, `version = "${semver}"`);
          if (updated !== content) {
            require("node:fs").writeFileSync(pyprojectPath, updated, "utf-8");
            execSync(`git add pyproject.toml && git commit -m "chore: bump version to ${semver}" && git push origin ${releaseBranch}`, {
              cwd: project.cwd, encoding: "utf-8", timeout: 15000,
            });
          }
        }
      } catch {
        // Non-blocking: version bump failure shouldn't prevent MR creation
      }

      const remoteUrl = execSync("git remote get-url origin", {
        cwd: project.cwd,
        encoding: "utf-8",
      }).trim();

      let result: string;

      if (remoteUrl.includes("code.byted.org")) {
        // ByteDance GitLab — use bytedcli
        const repoName = remoteUrl
          .replace(/.*code\.byted\.org[:/]/, "")
          .replace(/\.git$/, "");
        try {
          result = execSync(
            `bytedcli codebase create-mr --repo-name "${repoName}" --source-branch ${releaseBranch} --target-branch main --title "Release ${version}" --description "Merge ${releaseBranch} into main." --squash-commits --remove-source-branch --reviewer-ids "hehuajie"`,
            { cwd: project.cwd, encoding: "utf-8", timeout: 30000 },
          ).trim();
        } catch (mrErr: any) {
          if (mrErr.message?.includes("AlreadyExists")) {
            // MR already exists — find existing MR number via bytedcli
            try {
              // Try recent MR numbers (newest first) to find the one matching our source branch
              for (let n = 30; n >= 1; n--) {
                try {
                  const info = execSync(
                    `bytedcli codebase get-merge-request ${n} --repo-name "${repoName}" 2>&1`,
                    { cwd: project.cwd, encoding: "utf-8", timeout: 10000 },
                  );
                  if (info.includes(releaseBranch) && info.includes("open")) {
                    result = `https://code.byted.org/${repoName}/merge_requests/${n}`;
                    break;
                  }
                } catch { continue; }
              }
            } catch {}
            if (!result) result = `MR already exists for ${releaseBranch}`;
          } else {
            throw mrErr;
          }
        }
      } else {
        // GitHub — use gh CLI
        result = execSync(
          `gh pr create --base main --head ${releaseBranch} --title "Release ${version}" --body "$(cat <<'PREOF'\n## Release ${version}\n\nMerge ${releaseBranch} into main.\nPREOF\n)"`,
          { cwd: project.cwd, encoding: "utf-8", timeout: 30000 },
        ).trim();
      }

      const urlMatch = result.match(/https:\/\/[^\s)]+/);
      const prUrl = urlMatch ? urlMatch[0] : result;
      const prMatch = prUrl.match(/\/(\d+)$/);
      const prNumber = prMatch ? Number(prMatch[1]) : 0;

      return c.json({ prUrl, prNumber });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to create PR" }, 500);
    }
  });

  // Confirm release merge: verify PR merged, create new release branch
  app.post("/api/v1/projects/:id/release/confirm", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!project.cwd) return c.json({ error: "project has no cwd" }, 400);

    const cfg = (project.pipelineConfig as any) ?? {};
    const releaseBranch = cfg?.pipeline?.releaseBranch as string;
    if (!releaseBranch) return c.json({ error: "releaseBranch not configured" }, 400);

    try {
      // Verify the release branch has been merged into main
      execSync("git fetch origin", { cwd: project.cwd, encoding: "utf-8", timeout: 30000 });

      // Check if release branch is merged into main (supports squash merge)
      const branchMerged = execSync(
        `git branch -r --merged origin/main | grep "origin/${releaseBranch}" || true`,
        { cwd: project.cwd, encoding: "utf-8" },
      ).trim();
      const squashMerged = branchMerged ? true : execSync(
        `git log origin/main --oneline -20 | grep -i "${releaseBranch.replace(/\//g, "\\/")}" || true`,
        { cwd: project.cwd, encoding: "utf-8" },
      ).trim();

      if (!branchMerged && !squashMerged) {
        return c.json({ error: `${releaseBranch} has not been merged into main yet` }, 400);
      }

      // Bump version: release/v2.0.7 → release/v2.0.8, release/1.2.0 → release/1.2.1
      const versionMatch = releaseBranch.match(/release\/(v?)(\d+)\.(\d+)\.(\d+)/);
      if (!versionMatch) return c.json({ error: "Cannot parse version from branch name" }, 400);

      const [, prefix, major, minor, patch] = versionMatch;
      const newVersion = `${major}.${minor}.${Number(patch) + 1}`;
      const newBranch = `release/${prefix}${newVersion}`;

      // Create new release branch from main
      execSync(`git checkout main && git pull origin main && git checkout -b ${newBranch} && git push origin ${newBranch}`, {
        cwd: project.cwd,
        encoding: "utf-8",
        timeout: 30000,
      });

      // Tag current release version on main (triggers Luban deploy via v* tag)
      const currentVersion = releaseBranch.replace(/^release\/v?/, "");
      execSync(`git tag v${currentVersion} main && git push origin v${currentVersion}`, {
        cwd: project.cwd,
        encoding: "utf-8",
        timeout: 15000,
      });

      // Update config with new release branch
      const updatedConfig = { ...cfg, pipeline: { ...cfg.pipeline, releaseBranch: newBranch } };
      store.updatePipelineConfig(id, updatedConfig);

      // Enqueue AI-generated release notes (async, non-blocking)
      const pushTargets: string[] =
        cfg?.notifications?.dailyChangelog?.targets?.length
          ? cfg.notifications.dailyChangelog.targets
          : project.chatId ? [project.chatId] : [];

      if (pushTargets.length > 0) {
        const BOARD_PORT = process.env.REMI_BOARD_PORT ?? "8090";
        fetch(`http://127.0.0.1:${BOARD_PORT}/api/internal/enqueue-cron`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: `release-notes-${id}-v${currentVersion}`,
            handler: "release-notes:generate",
            handlerConfig: {
              projectId: id,
              projectName: project.name,
              cwd: project.cwd,
              version: currentVersion,
              releaseBranch,
              newBranch,
              pushTargets,
            },
          }),
        }).catch(() => {}); // Fire-and-forget
      }

      return c.json({ newBranch, newVersion });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to confirm release" }, 500);
    }
  });
}
