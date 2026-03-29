/**
 * GitHub MR status polling for Mission Board.
 * Checks open MRs and updates mission status when merged.
 */

import { MissionStore } from "./store.js";
import { createLogger } from "../logger.js";
import type { Remi } from "../core.js";

const log = createLogger("mission:github");

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
      const parsed = parseGitHubPRUrl(m.mrUrl);
      if (!parsed) continue;

      const proc = Bun.spawn(
        ["gh", "api", `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`, "--jq", ".state + \" \" + (.merged | tostring)"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(proc.stdout).text();
      const [state, merged] = output.trim().split(" ");

      if (state === "closed" && merged === "true") {
        store.updateMR(m.id, m.mrUrl, "merged");
        store.updateStatus(m.id, "done");
        // Trigger summary step
        await remi.queue.enqueueMission({ missionId: m.id, step: "summary" });
        log.info(`Mission ${m.id} MR merged → done, summary triggered`);
      } else if (state === "closed") {
        store.updateMR(m.id, m.mrUrl, "closed");
        store.updateStatus(m.id, "blocked");
        log.info(`Mission ${m.id} MR closed without merge → blocked`);
      }
    } catch (err) {
      log.warn(`Failed to poll MR for mission ${m.id}: ${(err as Error).message}`);
    }
  }
}

function parseGitHubPRUrl(url: string): { owner: string; repo: string; number: string } | null {
  // https://github.com/owner/repo/pull/123
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}
