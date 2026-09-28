/** Shared by lifecycle writers and the heartbeat claim path; independent of API roles. */
export function backgroundJobsEnabled(): boolean {
  return !["0", "false", "no", "off"].includes(process.env.MULTIREMI_BACKGROUND_JOBS?.trim().toLowerCase() ?? "");
}
