/** Shared by lifecycle writers and the heartbeat claim path; independent of API roles. */
export function backgroundJobsEnabled(): boolean {
  return !["0", "false", "no", "off"].includes(process.env.MULTIREMI_BACKGROUND_JOBS?.trim().toLowerCase() ?? "");
}

/** Stop splitting new Tasks during rollback; already pinned split Tasks still drain. */
export function feishuOutboundKindsEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.MULTIREMI_FEISHU_OUTBOUND_KINDS ?? "").trim().toLowerCase());
}
