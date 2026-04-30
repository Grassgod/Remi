import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { MissionStore } from "../../src/mission/store.js";
import type { Mission, MissionStatus, PipelineStep } from "../../src/mission/model.js";
import { createLogger } from "../../src/logger.js";
import { getDb } from "../../src/db/index.js";
import { execSync } from "child_process";

const store = new MissionStore();
const log = createLogger("missions-handler");

const BOARD_PORT = process.env.REMI_BOARD_PORT ?? "8090";

/** Enqueue a mission step via the Board server (runs in remi process with BunQueue). */
export function enqueueViaBoard(missionId: string, step: string): void {
  fetch(`http://127.0.0.1:${BOARD_PORT}/api/internal/enqueue-intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ missionId, step }),
  })
    .then((res) => {
      if (!res.ok) log.warn(`enqueue-intake returned ${res.status} for ${missionId}`);
      else log.info(`Mission ${missionId} step=${step} enqueued via board`);
    })
    .catch((err) => log.warn(`enqueue-intake failed for ${missionId}: ${err}`));
}

export function registerMissionsHandlers(app: Hono, _data: RemiData) {
  // GET /api/v1/missions — List missions with optional filters
  app.get("/api/v1/missions", (c) => {
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");

    let missions;
    if (projectId) {
      missions = store.listByProject(projectId);
      if (status) {
        missions = missions.filter((m) => m.status === status);
      }
    } else if (status) {
      missions = store.listByStatus(status as MissionStatus);
    } else {
      // No filters — list all missions ordered by updated_at desc
      const db = getDb();
      const rows = db
        .query("SELECT * FROM missions ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];
      missions = rows.map((row) => store.getById(row.id as string)!);
    }

    return c.json(missions);
  });

  // GET /api/v1/missions/stats — Project stats (must be before :id route)
  app.get("/api/v1/missions/stats", (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId query param is required" }, 400);
    }
    const stats = store.getProjectStats(projectId);
    return c.json(stats);
  });

  // GET /api/v1/missions/:id — Get single mission
  app.get("/api/v1/missions/:id", (c) => {
    const id = c.req.param("id");
    const mission = store.getById(id);
    if (!mission) {
      return c.json({ error: "Mission not found" }, 404);
    }
    return c.json(mission);
  });

  // POST /api/v1/missions — Create mission
  app.post("/api/v1/missions", async (c) => {
    const body = await c.req.json();
    const { title, projectId, threadId, description, createdBy, createdByName } = body;
    let { chatId } = body;

    if (!title || !projectId) {
      return c.json(
        { error: "title and projectId are required" },
        400,
      );
    }

    // Auto-resolve chatId from project if not provided
    if (!chatId) {
      try {
        const { ProjectStore } = require("../../src/project/store.js");
        const project = new ProjectStore().getById(projectId);
        chatId = project?.chatId;
      } catch {}
    }
    if (!chatId) {
      return c.json({ error: "chatId required (not found on project either)" }, 400);
    }

    const mission = await store.createWithThread({
      title,
      projectId,
      chatId,
      threadId,
      description,
      createdBy,
      createdByName,
    });

    // Trigger intake pipeline step (cross-process via HTTP to remi daemon)
    enqueueViaBoard(mission.id, "intake");

    return c.json(mission, 201);
  });

  // PATCH /api/v1/missions/:id — Update mission
  app.patch("/api/v1/missions/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.getById(id);
    if (!existing) {
      return c.json({ error: "Mission not found" }, 404);
    }

    const body = await c.req.json();
    const fields: Partial<{
      title: string;
      description: string;
      status: MissionStatus;
      currentStep: PipelineStep;
    }> = {};

    if (body.status !== undefined) fields.status = body.status;
    if (body.title !== undefined) fields.title = body.title;
    if (body.description !== undefined) fields.description = body.description;
    if (body.currentStep !== undefined) fields.currentStep = body.currentStep;

    store.update(id, fields);

    // If status changed to "approved" or "in_progress" from inbox, trigger pipeline
    if ((fields.status === "approved" || fields.status === "in_progress") && existing.status === "inbox") {
      store.update(id, { status: "in_progress" as any });
      enqueueViaBoard(id, "rfc");
    }

    return c.json({ ok: true });
  });

  // DELETE /api/v1/missions/:id — Delete mission
  app.delete("/api/v1/missions/:id", (c) => {
    const id = c.req.param("id");
    const existing = store.getById(id);
    if (!existing) {
      return c.json({ error: "Mission not found" }, 404);
    }

    store.delete(id);
    return c.json({ ok: true });
  });

  // POST /api/v1/missions/:id/request-changes — Review feedback → re-execute
  app.post("/api/v1/missions/:id/request-changes", async (c) => {
    const id = c.req.param("id");
    const mission = store.getById(id);
    if (!mission) return c.json({ error: "Mission not found" }, 404);
    if (mission.status !== "in_review") return c.json({ error: "Mission is not in review" }, 400);

    const body = await c.req.json();
    const comments = body.comments as string || "";

    store.updateStatus(id, "in_progress");
    store.updateStep(id, "execute");
    store.recordFeedback(id, "eval" as PipelineStep, "review", "review_revision", comments);

    // Notify thread and enqueue execute with review feedback
    try {
      const { sendToThread } = await import("../../src/connectors/feishu/thread.js");
      if (mission.chatId && mission.threadId) {
        await sendToThread(mission.chatId, mission.threadId, `── **Review 意见** ──\n\n${comments}`);
      }
    } catch {}

    enqueueViaBoard(id, "execute");
    log.info(`Mission ${id} request-changes: re-enqueue execute with review feedback`);

    return c.json({ ok: true });
  });

  // POST /api/v1/missions/:id/create-mr — Create MR for mission
  app.post("/api/v1/missions/:id/create-mr", (c) => {
    const id = c.req.param("id");
    const mission = store.getById(id);
    if (!mission) return c.json({ error: "Mission not found" }, 404);
    if (mission.status !== "in_review") return c.json({ error: "Mission is not in review" }, 400);
    if (mission.mrUrl) return c.json({ mrUrl: mission.mrUrl }); // Already created

    const { ProjectStore } = require("../../src/project/store.js");
    const project = new ProjectStore().getById(mission.projectId);
    if (!project?.cwd) return c.json({ error: "Project has no cwd" }, 400);

    const cfg = (project.pipelineConfig as any) ?? {};
    const releaseBranch = cfg?.pipeline?.releaseBranch as string;
    if (!releaseBranch) return c.json({ error: "releaseBranch not configured" }, 400);

    const sourceBranch = `mission/${id}`;

    try {
      // Push the mission branch
      execSync(`git push origin ${sourceBranch}`, {
        cwd: project.cwd, encoding: "utf-8", timeout: 30000,
      });

      const remoteUrl = execSync("git remote get-url origin", {
        cwd: project.cwd, encoding: "utf-8",
      }).trim();

      let result: string;

      const gitlabHost = process.env.REMI_GITLAB_HOST ?? "code.byted.org";
      if (remoteUrl.includes(gitlabHost)) {
        const hostEsc = gitlabHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const repoName = remoteUrl
          .replace(new RegExp(`.*${hostEsc}[:/]`), "")
          .replace(/\.git$/, "");
        const reviewers = process.env.REMI_GITLAB_REVIEWERS ?? "";
        const reviewerArg = reviewers ? ` --reviewer-ids "${reviewers}"` : "";
        try {
          result = execSync(
            `bytedcli codebase create-mr --repo-name "${repoName}" --source-branch ${sourceBranch} --target-branch ${releaseBranch} --title "Mission: ${mission.title}" --description "Contract 验证通过，请审核合入。" --squash-commits --remove-source-branch${reviewerArg}`,
            { cwd: project.cwd, encoding: "utf-8", timeout: 30000 },
          ).trim();
        } catch (mrErr: any) {
          if (mrErr.message?.includes("AlreadyExists")) {
            // Find existing MR by scanning recent MRs
            for (let n = 50; n >= 1; n--) {
              try {
                const info = execSync(
                  `bytedcli codebase get-merge-request ${n} --repo-name "${repoName}" 2>&1`,
                  { cwd: project.cwd, encoding: "utf-8", timeout: 10000 },
                );
                if (info.includes(sourceBranch) && (info.includes("open") || info.includes("Open"))) {
                  result = `https://${gitlabHost}/${repoName}/merge_requests/${n}`;
                  break;
                }
              } catch { continue; }
            }
            result ??= `MR already exists for ${sourceBranch}`;
          } else {
            throw mrErr;
          }
        }
      } else {
        result = execSync(
          `gh pr create --base ${releaseBranch} --head ${sourceBranch} --title "Mission: ${mission.title}" --body "Contract 验证通过，请审核合入。"`,
          { cwd: project.cwd, encoding: "utf-8", timeout: 30000 },
        ).trim();
      }

      const urlMatch = result.match(/https:\/\/[^\s)]+/);
      const mrUrl = urlMatch ? urlMatch[0] : result;

      store.updateMR(id, mrUrl, "open");
      log.info(`Mission ${id} MR created: ${mrUrl}`);

      return c.json({ mrUrl });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to create MR" }, 500);
    }
  });

  // POST /api/v1/missions/:id/done — Confirm MR merged, mark mission complete
  app.post("/api/v1/missions/:id/done", async (c) => {
    const id = c.req.param("id");
    const mission = store.getById(id);
    if (!mission) return c.json({ error: "Mission not found" }, 404);

    // If MR exists and not yet merged, verify merge status
    if (mission.mrUrl && mission.mrStatus === "open") {
      const { checkMRMerged } = await import("../../src/mission/github.js");
      const merged = await checkMRMerged(mission.mrUrl);
      if (!merged) return c.json({ error: "MR has not been merged yet" }, 400);
      store.updateMR(id, mission.mrUrl, "merged");
    }

    store.updateStatus(id, "done");
    log.info(`Mission ${id} marked done, enqueuing summary`);
    enqueueViaBoard(id, "summary");

    return c.json({ ok: true });
  });

  // POST /api/internal/enqueue-intake — Proxy to Board server for re-enqueue
  app.post("/api/internal/enqueue-intake", async (c) => {
    const body = await c.req.json();
    try {
      const res = await fetch(`http://127.0.0.1:${BOARD_PORT}/api/internal/enqueue-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return c.json(data, res.status as any);
    } catch (err) {
      return c.json({ error: `Board server unreachable: ${err}` }, 503);
    }
  });
}
