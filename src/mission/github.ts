/**
 * MR status polling for Mission Board.
 * Supports GitHub (gh CLI) and ByteDance Codebase (bytedcli).
 */

import { MissionStore } from "./store.js";
import { createLogger } from "../logger.js";
import type { Remi } from "../core.js";

const log = createLogger("mission:mr-poll");

/**
 * Poll all missions with open MR status.
 * If MR is merged, trigger summary step.
 */
export async function pollMRStatus(remi: Remi): Promise<void> {
  const store = new MissionStore();
  const missions = store.listByMRStatus("open");

  if (missions.length === 0) return;

  log.info(`Polling ${missions.length} open MR(s)...`);

  for (const m of missions) {
    if (!m.mrUrl) continue;

    try {
      const status = await getMRStatus(m.mrUrl);
      if (!status) continue;

      if (status === "merged") {
        store.updateMR(m.id, m.mrUrl, "merged");
        store.updateStatus(m.id, "done");
        await remi.queue.enqueueMission({ missionId: m.id, step: "summary" });
        log.info(`Mission ${m.id} MR merged → done, summary triggered`);
      } else if (status === "closed") {
        store.updateMR(m.id, m.mrUrl, "closed");
        store.updateStatus(m.id, "blocked");
        log.info(`Mission ${m.id} MR closed without merge → blocked`);
      }
    } catch (err) {
      log.warn(`Failed to poll MR for mission ${m.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Check if a specific MR URL has been merged.
 */
export async function checkMRMerged(mrUrl: string): Promise<boolean> {
  const status = await getMRStatus(mrUrl);
  return status === "merged";
}

// ── Internal ──

async function getMRStatus(mrUrl: string): Promise<"open" | "merged" | "closed" | null> {
  const github = parseGitHubPRUrl(mrUrl);
  if (github) return getGitHubPRStatus(github);

  const codebase = parseCodebaseUrl(mrUrl);
  if (codebase) return getCodebaseMRStatus(codebase);

  return null;
}

// ── GitHub ──

async function getGitHubPRStatus(pr: { owner: string; repo: string; number: string }): Promise<"open" | "merged" | "closed"> {
  const proc = Bun.spawn(
    ["gh", "api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, "--jq", ".state + \" \" + (.merged | tostring)"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(proc.stdout).text();
  const [state, merged] = output.trim().split(" ");

  if (state === "closed" && merged === "true") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

function parseGitHubPRUrl(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

// ── ByteDance Codebase ──

async function getCodebaseMRStatus(mr: { repoName: string; number: string }): Promise<"open" | "merged" | "closed"> {
  const proc = Bun.spawn(
    ["bytedcli", "--json", "codebase", "get-merge-request", "--repo-name", mr.repoName, mr.number],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(proc.stdout).text();
  const data = JSON.parse(output);

  const status = data?.data?.merge_request?.Status?.toLowerCase();
  if (status === "merged") return "merged";
  if (status === "closed") return "closed";
  return "open";
}

function parseCodebaseUrl(url: string): { repoName: string; number: string } | null {
  // https://code.byted.org/bytedance/lark_parser/merge_requests/21
  // https://code.byted.org/bytedance/lark_parser/-/merge_requests/21
  const match = url.match(/code\.byted\.org\/([^/]+\/[^/]+)(?:\/-)?\/merge_requests\/(\d+)/);
  if (!match) return null;
  return { repoName: match[1], number: match[2] };
}
