import type { MultiremiWorkspace } from "@multiremi/contracts/types.js";

export type OrganizerMode = "report_only" | "act";

export class OrganizerActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 409 = 403,
  ) {
    super(message);
    this.name = "OrganizerActionError";
  }
}

export function readOrganizerMode(workspace: Pick<MultiremiWorkspace, "settings"> | null | undefined): OrganizerMode {
  const organizer = workspace?.settings?.organizer;
  if (!organizer || typeof organizer !== "object" || Array.isArray(organizer)) return "report_only";
  return (organizer as Record<string, unknown>).mode === "act" ? "act" : "report_only";
}

export function organizerSettings(
  workspace: Pick<MultiremiWorkspace, "settings">,
  mode: OrganizerMode,
): Record<string, unknown> {
  const current = workspace.settings.organizer;
  const organizer = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return { ...workspace.settings, organizer: { ...organizer, mode } };
}

export function parseOrganizerMode(value: unknown): OrganizerMode | null {
  return value === "report_only" || value === "act" ? value : null;
}
