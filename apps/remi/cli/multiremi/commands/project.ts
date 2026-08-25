/** Administrative project-knowledge migration commands. */

import { type CliOptions, addQueryParam } from "../options.js";
import { multiremiApiConnection, multiremiApiRequest } from "../http.js";
import { printJson } from "../output.js";

export async function project(positional: string[], options: CliOptions): Promise<void> {
  if (positional[0] !== "knowledge") {
    // Only knowledge migration lives here; the project resource commands moved
    // to the native CLI in 0.2.47. Older binaries route `remi project` into
    // this handler, so name the canonical commands instead of a bare usage.
    throw new Error(
      "usage: multiremi project knowledge status|backfill|verify|retry-failed ...\n"
        + "project list|get|search|defaults are native CLI commands: run `remi project list|get|search|defaults ...`.\n"
        + "If that prints this same message, this remi binary predates 0.2.47 — update it (`remi update`).",
    );
  }
  await projectKnowledge(positional.slice(1), options);
}

export async function projectKnowledge(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "status";
  const projectId = positional[1]?.trim() || null;
  const workspaceId = multiremiApiConnection(options).workspaceId;
  if (action === "status") {
    const params = new URLSearchParams();
    addQueryParam(params, "workspace_id", workspaceId);
    const query = params.toString();
    printJson(await multiremiApiRequest(
      "GET",
      `/api/project-knowledge/migration${query ? `?${query}` : ""}`,
      undefined,
      options,
    ));
    return;
  }
  if (action === "backfill") {
    printJson(await multiremiApiRequest("POST", "/api/project-knowledge/migration/backfill", {
      project_id: projectId,
      workspace_id: workspaceId,
      dry_run: Boolean(options["dry-run"] ?? options.dryRun),
      resume: Boolean(options.resume),
    }, options));
    return;
  }
  if (action === "verify") {
    printJson(await multiremiApiRequest(
      "POST",
      "/api/project-knowledge/migration/verify",
      { project_id: projectId, workspace_id: workspaceId },
      options,
    ));
    return;
  }
  if (action === "retry-failed") {
    printJson(await multiremiApiRequest(
      "POST",
      "/api/project-knowledge/migration/retry-failed",
      { project_id: projectId, workspace_id: workspaceId },
      options,
    ));
    return;
  }
  throw new Error("usage: multiremi project knowledge status|backfill|verify|retry-failed [project-id] [--dry-run] [--resume]");
}
