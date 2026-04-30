import type { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonSafe<T = unknown>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listJsonFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Types (lightweight, matching JSON on disk)
// ---------------------------------------------------------------------------

interface ClarifyDimension {
  维度名称: string;
  score: number;
  reason: string;
}

interface ClarifyResult {
  ground_truth_feat?: string;
  "打分维度/分类"?: ClarifyDimension[];
  split_feat?: string;
  mr_change_intent?: string;
  total_score?: number;
  reason?: string;
  improvement_suggestion?: string;
}

interface RfcDimension {
  维度名称: string;
  score: number;
  max_score: number;
  detail?: unknown;
  reason?: string;
}

interface RfcGap {
  gap_type: string;
  description: string;
  severity: string;
  mr_evidence?: string;
}

interface RfcResult {
  uniq_id?: string;
  clarify_gt_summary?: string;
  rfc_summary?: string;
  mr_summary?: string;
  打分维度?: RfcDimension[];
  total_score?: number;
  max_total_score?: number;
  overall_reason?: string;
  improvement_suggestion?: string;
  critical_gaps?: RfcGap[];
}

interface RegistryCase {
  case_id: string;
  types: string[];
  repo: string;
  tags?: string[];
  valid?: boolean;
}

interface EvalCase {
  id: string;
  prd_url: string;
  meego_url: string;
  platform: string;
  mr_list: string[];
  repo: string;
  gt: string;
  original_gt: string;
  revised_gt: string;
  code_snippets: string;
  status: string;
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

interface Registry {
  cases: (RegistryCase | EvalCase)[];
}

/** Type guard: new-format cases have `id`; old-format have `case_id` */
function isEvalCase(c: RegistryCase | EvalCase): c is EvalCase {
  return "id" in c && !("case_id" in c);
}

/** Normalise a registry entry to an id string regardless of format */
function caseId(c: RegistryCase | EvalCase): string {
  return isEvalCase(c) ? c.id : c.case_id;
}

function writeJsonSafe(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function defaultEvalCase(partial: Partial<EvalCase>): EvalCase {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? `eval-${Date.now()}`,
    prd_url: partial.prd_url ?? "",
    meego_url: partial.meego_url ?? "",
    platform: partial.platform ?? "",
    mr_list: partial.mr_list ?? [],
    repo: partial.repo ?? "",
    gt: partial.gt ?? "",
    original_gt: partial.original_gt ?? "",
    revised_gt: partial.revised_gt ?? "",
    code_snippets: partial.code_snippets ?? "",
    status: partial.status ?? "pending",
    tags: partial.tags ?? [],
    notes: partial.notes ?? "",
    created_at: partial.created_at ?? now,
    updated_at: partial.updated_at ?? now,
  };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerEvalHandlers(app: Hono, evalRoot: string) {
  const casesDir = join(evalRoot, "cases");
  const baselineDir = join(evalRoot, "baseline");
  const resultsDir = join(evalRoot, "results");
  const harnessDir = join(evalRoot, "harness");

  // -----------------------------------------------------------------------
  // 1. GET /api/v1/eval/overview
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/overview", (c) => {
    // Baseline clarify (with_mr)
    const clarifyDir = join(baselineDir, "clarify", "with_mr");
    const clarifyFiles = listJsonFiles(clarifyDir);
    const clarifyResults: ClarifyResult[] = [];
    for (const f of clarifyFiles) {
      const r = readJsonSafe<ClarifyResult>(join(clarifyDir, f));
      if (r) clarifyResults.push(r);
    }

    // Baseline rfc
    const rfcDir = join(baselineDir, "rfc");
    const rfcFiles = listJsonFiles(rfcDir);
    const rfcResults: RfcResult[] = [];
    for (const f of rfcFiles) {
      const r = readJsonSafe<RfcResult>(join(rfcDir, f));
      if (r) rfcResults.push(r);
    }

    // Average scores
    const clarifyAvg =
      clarifyResults.length > 0
        ? clarifyResults.reduce((s, r) => s + (r.total_score ?? 0), 0) / clarifyResults.length
        : 0;
    const rfcAvg =
      rfcResults.length > 0
        ? rfcResults.reduce((s, r) => s + (r.total_score ?? 0), 0) / rfcResults.length
        : 0;

    // Per-dimension averages — clarify
    const clarifyDimMap: Record<string, { sum: number; count: number }> = {};
    for (const r of clarifyResults) {
      for (const d of r["打分维度/分类"] ?? []) {
        const entry = (clarifyDimMap[d.维度名称] ??= { sum: 0, count: 0 });
        entry.sum += d.score;
        entry.count += 1;
      }
    }
    const clarifyDimAvg = Object.entries(clarifyDimMap).map(([name, v]) => ({
      dimension: name,
      avg: +(v.sum / v.count).toFixed(2),
      count: v.count,
    }));

    // Per-dimension averages — rfc
    const rfcDimMap: Record<string, { sum: number; maxSum: number; count: number }> = {};
    for (const r of rfcResults) {
      for (const d of r.打分维度 ?? []) {
        const entry = (rfcDimMap[d.维度名称] ??= { sum: 0, maxSum: 0, count: 0 });
        entry.sum += d.score;
        entry.maxSum += d.max_score;
        entry.count += 1;
      }
    }
    const rfcDimAvg = Object.entries(rfcDimMap).map(([name, v]) => ({
      dimension: name,
      avg: +(v.sum / v.count).toFixed(2),
      maxAvg: +(v.maxSum / v.count).toFixed(2),
      count: v.count,
    }));

    // Critical gaps by severity
    const gapsBySeverity: Record<string, number> = {};
    for (const r of rfcResults) {
      for (const g of r.critical_gaps ?? []) {
        gapsBySeverity[g.severity] = (gapsBySeverity[g.severity] ?? 0) + 1;
      }
    }

    // Latest run (if any)
    let latestRun: unknown = null;
    const dateDirs = listDirs(resultsDir).sort().reverse();
    if (dateDirs.length > 0) {
      const latestDate = dateDirs[0];
      const runs = listDirs(join(resultsDir, latestDate));
      if (runs.length > 0) {
        const runId = runs[runs.length - 1];
        const meta = readJsonSafe(join(resultsDir, latestDate, runId, "meta.json"));
        latestRun = { date: latestDate, runId, meta };
      }
    }

    return c.json({
      baseline: {
        clarify: {
          count: clarifyResults.length,
          avgScore: +clarifyAvg.toFixed(2),
          dimensions: clarifyDimAvg,
        },
        rfc: {
          count: rfcResults.length,
          avgScore: +rfcAvg.toFixed(2),
          dimensions: rfcDimAvg,
        },
      },
      gapsBySeverity,
      latestRun,
    });
  });

  // -----------------------------------------------------------------------
  // 2. GET /api/v1/eval/cases
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/cases", (c) => {
    const registry = readJsonSafe<Registry>(join(casesDir, "registry.json"));
    if (!registry) {
      return c.json({ error: "registry.json not found or invalid" }, 404);
    }

    const cases = registry.cases.map((rc) => {
      // New-format EvalCase entries — return enriched with completeness info
      if (isEvalCase(rc)) {
        const id = rc.id;
        const clarifyDir = join(casesDir, "clarify", id);
        const rfcDir = join(casesDir, "rfc", id);
        const completeness: Record<string, boolean> = {
          "clarify/gt.md": existsSync(join(clarifyDir, "gt.md")),
          "clarify/metadata.json": existsSync(join(clarifyDir, "metadata.json")),
          "rfc/gt.md": existsSync(join(rfcDir, "gt.md")),
          "rfc/metadata.json": existsSync(join(rfcDir, "metadata.json")),
        };
        const complete = Object.values(completeness).every(Boolean);
        return { ...rc, completeness, complete };
      }

      // Old-format RegistryCase entries — keep backward compat
      const typeDir = (rc as RegistryCase).types?.includes("rfc") ? "rfc" : "clarify";
      const caseDir = join(casesDir, typeDir, (rc as RegistryCase).case_id);

      const completeness: Record<string, boolean> = {
        "gt.md": existsSync(join(caseDir, "gt.md")),
        "metadata.json": existsSync(join(caseDir, "metadata.json")),
        "mr_diff.json": existsSync(join(caseDir, "mr_diff.json")),
      };

      if (typeDir === "clarify") {
        completeness["clarify.md"] = existsSync(join(caseDir, "clarify.md"));
      }
      if (typeDir === "rfc" || (rc as RegistryCase).types?.includes("rfc")) {
        completeness["design.md"] = existsSync(join(caseDir, "design.md"));
        completeness["tasks.md"] = existsSync(join(caseDir, "tasks.md"));
      }

      const complete = Object.values(completeness).every(Boolean);

      return { ...rc, completeness, complete };
    });

    return c.json({ cases });
  });

  // -----------------------------------------------------------------------
  // 3. GET /api/v1/eval/cases/:id
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/cases/:id", (c) => {
    const id = c.req.param("id");
    const registry = readJsonSafe<Registry>(join(casesDir, "registry.json"));
    const entry = registry?.cases.find((rc) => caseId(rc) === id);
    if (!entry) {
      return c.json({ error: "Case not found" }, 404);
    }

    // Determine case directory based on format
    let caseDir: string;
    if (isEvalCase(entry)) {
      // New format — read from clarify dir by default
      caseDir = join(casesDir, "clarify", id);
    } else {
      const typeDir = entry.types?.includes("rfc") ? "rfc" : "clarify";
      caseDir = join(casesDir, typeDir, id);
    }

    const metadata = readJsonSafe(join(caseDir, "metadata.json"));
    const gt = readTextSafe(join(caseDir, "gt.md"));
    const clarifyMd = readTextSafe(join(caseDir, "clarify.md"));
    const designMd = readTextSafe(join(caseDir, "design.md"));
    const tasksMd = readTextSafe(join(caseDir, "tasks.md"));

    // Baseline results
    const clarifyBaseline =
      readJsonSafe(join(baselineDir, "clarify", "with_mr", `${id}.json`)) ??
      readJsonSafe(join(baselineDir, "clarify", "without_mr", `${id}.json`));
    const rfcBaseline = readJsonSafe(join(baselineDir, "rfc", `${id}.json`));

    return c.json({
      ...entry,
      metadata,
      content: { gt, clarify: clarifyMd, design: designMd, tasks: tasksMd },
      baseline: { clarify: clarifyBaseline, rfc: rfcBaseline },
    });
  });

  // -----------------------------------------------------------------------
  // 3b. POST /api/v1/eval/cases — Create a new case
  // -----------------------------------------------------------------------
  app.post("/api/v1/eval/cases", async (c) => {
    const body = await c.req.json<Partial<EvalCase>>();
    const newCase = defaultEvalCase(body);

    // Read existing registry (or start fresh)
    const registryPath = join(casesDir, "registry.json");
    const registry = readJsonSafe<Registry>(registryPath) ?? { cases: [] };

    // Append
    registry.cases.push(newCase);
    writeJsonSafe(registryPath, registry);

    // Create case directories
    const clarifyDir = join(casesDir, "clarify", newCase.id);
    const rfcDir = join(casesDir, "rfc", newCase.id);
    mkdirSync(clarifyDir, { recursive: true });
    mkdirSync(rfcDir, { recursive: true });

    // Write gt.md if provided
    if (newCase.gt) {
      writeFileSync(join(clarifyDir, "gt.md"), newCase.gt, "utf-8");
      writeFileSync(join(rfcDir, "gt.md"), newCase.gt, "utf-8");
    }

    // Write metadata.json in both dirs (harness-compatible format)
    const metadata = {
      case_id: newCase.id,
      mr_list: newCase.mr_list,
      repo: newCase.repo,
      valid: true,
      story_url: newCase.meego_url,
    };
    writeJsonSafe(join(clarifyDir, "metadata.json"), metadata);
    writeJsonSafe(join(rfcDir, "metadata.json"), metadata);

    return c.json({ ok: true, id: newCase.id });
  });

  // -----------------------------------------------------------------------
  // 3c. PATCH /api/v1/eval/cases/:id — Update an existing case
  // -----------------------------------------------------------------------
  app.patch("/api/v1/eval/cases/:id", async (c) => {
    const id = c.req.param("id");
    const registryPath = join(casesDir, "registry.json");
    const registry = readJsonSafe<Registry>(registryPath);
    if (!registry) {
      return c.json({ error: "registry.json not found or invalid" }, 404);
    }

    const idx = registry.cases.findIndex((rc) => caseId(rc) === id);
    if (idx === -1) {
      return c.json({ error: "Case not found" }, 404);
    }

    const body = await c.req.json<Partial<EvalCase>>();
    const existing = registry.cases[idx];

    // Merge fields into existing case
    const merged: EvalCase = {
      ...(isEvalCase(existing) ? existing : defaultEvalCase({ id: (existing as RegistryCase).case_id })),
      ...body,
      id, // preserve id
      updated_at: new Date().toISOString(),
    };

    registry.cases[idx] = merged;
    writeJsonSafe(registryPath, registry);

    // If gt changed, re-write gt.md files
    if (body.gt !== undefined) {
      const clarifyDir = join(casesDir, "clarify", id);
      const rfcDir = join(casesDir, "rfc", id);
      mkdirSync(clarifyDir, { recursive: true });
      mkdirSync(rfcDir, { recursive: true });
      writeFileSync(join(clarifyDir, "gt.md"), merged.gt, "utf-8");
      writeFileSync(join(rfcDir, "gt.md"), merged.gt, "utf-8");
    }

    // If mr_list or repo changed, re-write metadata.json files
    if (body.mr_list !== undefined || body.repo !== undefined) {
      const metadata = {
        case_id: id,
        mr_list: merged.mr_list,
        repo: merged.repo,
        valid: true,
        story_url: merged.meego_url,
      };
      const clarifyDir = join(casesDir, "clarify", id);
      const rfcDir = join(casesDir, "rfc", id);
      mkdirSync(clarifyDir, { recursive: true });
      mkdirSync(rfcDir, { recursive: true });
      writeJsonSafe(join(clarifyDir, "metadata.json"), metadata);
      writeJsonSafe(join(rfcDir, "metadata.json"), metadata);
    }

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // 3d. DELETE /api/v1/eval/cases/:id — Remove case from registry
  // -----------------------------------------------------------------------
  app.delete("/api/v1/eval/cases/:id", (c) => {
    const id = c.req.param("id");
    const registryPath = join(casesDir, "registry.json");
    const registry = readJsonSafe<Registry>(registryPath);
    if (!registry) {
      return c.json({ error: "registry.json not found or invalid" }, 404);
    }

    const idx = registry.cases.findIndex((rc) => caseId(rc) === id);
    if (idx === -1) {
      return c.json({ error: "Case not found" }, 404);
    }

    // Remove from registry and delete directories
    registry.cases.splice(idx, 1);
    writeJsonSafe(registryPath, registry);

    // Clean up case directories
    const { rmSync } = require("node:fs");
    for (const sub of ["clarify", "rfc"]) {
      const dir = join(casesDir, sub, id);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // 4. GET /api/v1/eval/baseline
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/baseline", (c) => {
    // Clarify with_mr
    const clarifyWithMrDir = join(baselineDir, "clarify", "with_mr");
    const clarifyWithMr: Record<string, unknown> = {};
    for (const f of listJsonFiles(clarifyWithMrDir)) {
      const key = f.replace(/\.json$/, "");
      clarifyWithMr[key] = readJsonSafe(join(clarifyWithMrDir, f));
    }

    // Clarify without_mr
    const clarifyWithoutMrDir = join(baselineDir, "clarify", "without_mr");
    const clarifyWithoutMr: Record<string, unknown> = {};
    for (const f of listJsonFiles(clarifyWithoutMrDir)) {
      const key = f.replace(/\.json$/, "");
      clarifyWithoutMr[key] = readJsonSafe(join(clarifyWithoutMrDir, f));
    }

    // RFC
    const rfcDir = join(baselineDir, "rfc");
    const rfc: Record<string, unknown> = {};
    for (const f of listJsonFiles(rfcDir)) {
      const key = f.replace(/\.json$/, "");
      rfc[key] = readJsonSafe(join(rfcDir, f));
    }

    return c.json({
      clarify: { with_mr: clarifyWithMr, without_mr: clarifyWithoutMr },
      rfc,
    });
  });

  // -----------------------------------------------------------------------
  // 5. GET /api/v1/eval/runs
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/runs", (c) => {
    const runs: { date: string; runId: string; meta: unknown; caseCount: number }[] = [];

    for (const dateDir of listDirs(resultsDir).sort().reverse()) {
      const datePath = join(resultsDir, dateDir);
      for (const runId of listDirs(datePath)) {
        const runPath = join(datePath, runId);
        const meta = readJsonSafe(join(runPath, "meta.json"));

        // Count result JSONs (clarify + rfc sub-dirs)
        let caseCount = 0;
        const clarifyRunDir = join(runPath, "clarify");
        const rfcRunDir = join(runPath, "rfc");
        caseCount += listJsonFiles(clarifyRunDir).length;
        caseCount += listJsonFiles(rfcRunDir).length;

        runs.push({ date: dateDir, runId, meta, caseCount });
      }
    }

    return c.json({ runs });
  });

  // -----------------------------------------------------------------------
  // 6. GET /api/v1/eval/runs/:runId
  // -----------------------------------------------------------------------
  app.get("/api/v1/eval/runs/:runId", (c) => {
    const runId = c.req.param("runId");

    // Find the run directory (search all date dirs)
    let runPath: string | null = null;
    let runDate: string | null = null;
    for (const dateDir of listDirs(resultsDir)) {
      const candidate = join(resultsDir, dateDir, runId);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        runPath = candidate;
        runDate = dateDir;
        break;
      }
    }

    if (!runPath) {
      return c.json({ error: "Run not found" }, 404);
    }

    const meta = readJsonSafe(join(runPath, "meta.json"));
    const report = readTextSafe(join(runPath, "report.md"));

    // Collect result JSONs
    const clarifyResults: Record<string, unknown> = {};
    const clarifyRunDir = join(runPath, "clarify");
    for (const f of listJsonFiles(clarifyRunDir)) {
      const key = f.replace(/\.json$/, "");
      clarifyResults[key] = readJsonSafe(join(clarifyRunDir, f));
    }

    const rfcResults: Record<string, unknown> = {};
    const rfcRunDir = join(runPath, "rfc");
    for (const f of listJsonFiles(rfcRunDir)) {
      const key = f.replace(/\.json$/, "");
      rfcResults[key] = readJsonSafe(join(rfcRunDir, f));
    }

    return c.json({
      date: runDate,
      runId,
      meta,
      report,
      results: { clarify: clarifyResults, rfc: rfcResults },
    });
  });

  // -----------------------------------------------------------------------
  // 7. Job execution — spawn script, write to log file, poll for output
  // -----------------------------------------------------------------------

  const jobsDir = join(evalRoot, "jobs");
  try { mkdirSync(jobsDir, { recursive: true }); } catch {}

  // In-memory job status tracker
  const jobs = new Map<string, { status: string; pid?: number }>();

  function startJob(jobId: string, script: string, args: string[]): string {
    const logFile = join(jobsDir, `${jobId}.log`);
    const statusFile = join(jobsDir, `${jobId}.status`);
    const { openSync, closeSync } = require("node:fs");

    // Init files
    writeFileSync(logFile, "");
    writeFileSync(statusFile, "running");
    jobs.set(jobId, { status: "running" });

    const fd = openSync(logFile, "a");
    const child = spawn("bash", [script, ...args], {
      cwd: evalRoot,
      env: { ...process.env, EVAL_DATE: new Date().toISOString().slice(5, 10).replace("-", "") },
      stdio: ["ignore", fd, fd],
    });

    jobs.set(jobId, { status: "running", pid: child.pid });

    child.on("close", (code: number | null) => {
      closeSync(fd);
      const s = code === 0 ? "done" : `failed (exit ${code})`;
      writeFileSync(statusFile, s);
      jobs.set(jobId, { status: s });
    });

    child.on("error", (err: Error) => {
      try { closeSync(fd); } catch {}
      const s = `error: ${err.message}`;
      writeFileSync(statusFile, s);
      jobs.set(jobId, { status: s });
    });

    return jobId;
  }

  // POST /api/v1/eval/exec — Start a job (run or prepare)
  app.post("/api/v1/eval/exec", async (c) => {
    const body = await c.req.json<{
      command: "run" | "check" | "fetch-mr" | "clone-repos";
      cases?: string[];
    }>();
    const cmd = body.command;
    const cases = body.cases ?? [];
    const jobId = `${cmd}-${Date.now()}`;

    if (cmd === "run") {
      const script = join(harnessDir, "run.sh");
      if (!existsSync(script)) return c.json({ error: "run.sh not found" }, 404);
      const args = cases.length > 0 ? cases : ["all"];
      startJob(jobId, script, args);
    } else {
      const script = join(harnessDir, "prepare.sh");
      if (!existsSync(script)) return c.json({ error: "prepare.sh not found" }, 404);
      startJob(jobId, script, [cmd, ...(cases.length === 1 ? cases : [])]);
    }

    return c.json({ ok: true, jobId });
  });

  // GET /api/v1/eval/job/:id — Poll log content + status
  app.get("/api/v1/eval/job/:id", (c) => {
    const id = c.req.param("id");
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const logFile = join(jobsDir, `${id}.log`);
    const statusFile = join(jobsDir, `${id}.status`);

    if (!existsSync(logFile)) return c.json({ error: "job not found" }, 404);

    const content = readTextSafe(logFile) || "";
    const newContent = content.slice(offset);
    const status = readTextSafe(statusFile) || "unknown";

    return c.json({
      log: newContent,
      offset: content.length,
      status: status.trim(),
    });
  });

  // GET /api/v1/eval/jobs — List recent jobs
  app.get("/api/v1/eval/jobs", (c) => {
    const files = listDir(jobsDir).filter((f: string) => f.endsWith(".status"));
    const result = files.map((f: string) => {
      const id = f.replace(".status", "");
      const status = (readTextSafe(join(jobsDir, f)) || "unknown").trim();
      const logPath = join(jobsDir, `${id}.log`);
      const stat = existsSync(logPath) ? statSync(logPath) : null;
      return { id, status, updatedAt: stat?.mtime?.toISOString() || "" };
    }).sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));

    return c.json({ jobs: result });
  });

  function listDir(dir: string): string[] {
    try { return existsSync(dir) ? readdirSync(dir) : []; } catch { return []; }
  }
}
