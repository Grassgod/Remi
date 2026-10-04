import type { SessionLogEntry } from "@multiremi/core/replica";
import { quotePreview } from "../../issues/utils/quote-preview";

export const INTERNAL_ID_PREFIXES = [
  "act", "ane", "apb", "apl", "aps", "apv", "agt", "att", "aut", "batch", "chat", "clog", "cmt_env", "cmt", "crn", "cses",
  "dcs", "dec", "dep", "dlg", "dws", "evt", "fba", "fbo", "fbr", "fbs", "fcb", "fdb", "fhrp", "flease", "foc", "fop_claim", "fop", "fout", "frp", "fsrc",
  "hrq", "inb", "inv", "ises", "iss", "kout", "krun", "ksrc", "ksub", "lbl", "mconn", "mem", "mlease", "mout", "msg", "msrc",
  "nch", "ndl", "orga", "paud", "pdoc", "pdrev", "pin", "pop", "prj", "prov", "rck", "repo", "res", "rt", "run", "rwbatch", "rwdoc",
  "rwjob", "rwlease", "rwrev", "rws", "rxn", "sar", "sce", "scm", "scr", "scv", "sdl", "sev", "sevt", "sfx", "sil", "skf", "skl",
  "spart", "sqd", "sqm", "srb", "sres", "sshinvalidate", "sshprobe", "sshrekey", "steer", "sub", "trg", "tsk", "usr", "whd", "ws",
] as const;
const INTERNAL_ID = new RegExp(`\\b(?:${INTERNAL_ID_PREFIXES.join("|")})_[a-zA-Z0-9][a-zA-Z0-9_-]*\\b`, "g");

export function eventSummary(markdown: string, maxChars = 120): string {
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) continue;
    const plain = quotePreview(line.replace(INTERNAL_ID, "")
      .replace(/^\s*\d+[.)]\s+/, "").replace(/<[^>]*>/g, ""), Number.MAX_SAFE_INTEGER)
      .replace(/\(\s*\)|\[\s*\]/g, "").trim();
    if (plain) return plain.length > maxChars ? `${plain.slice(0, maxChars)}…` : plain;
  }
  return "";
}

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function metadataString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isInboxTurn(markdown: string): boolean {
  return eventSummary(markdown).startsWith("读收件箱");
}

export function reportOutcome(value: unknown): "completed" | "failed" | "cancelled" | null {
  if (value === "done" || value === "completed") return "completed";
  return value === "failed" || value === "cancelled" ? value : null;
}

export function envelopeType(value: unknown): string {
  const envelope = metadataRecord(value);
  const prefix = metadataString(envelope.dedupeKey).split(":", 1)[0];
  switch (prefix) {
    case "delegation_terminal": return "delegation";
    case "delegation_progress": return "delegation_progress";
    case "child_status": return "child";
    case "dependency_failed": return "dependency_failed";
    case "dependency_ready": return "dependency_ready";
    case "decision_request": return "decision_needed";
    case "decision_answer": case "decision_overturn": return "decision_answer";
    case "relay": return "relay";
  }
  const role = metadataRecord(envelope.to).role;
  switch (envelope.kind) {
    case "child_status": return "child";
    case "dependency_failed": return "dependency_failed";
    case "decision_needed": return "decision_needed";
    case "lifecycle": return "dependency_ready";
    case "reply": return role === "delegator" ? "delegation_progress" : "decision_answer";
    case "report": return role === "delegator" ? "delegation"
      : role === "parent_owner" ? "child" : role === "relay" ? "relay" : "generic";
    default: return "generic";
  }
}

// Do not reuse measurements left by the old full-body or inline disclosure UI.
export function eventLayoutEntry(entry: SessionLogEntry): SessionLogEntry {
  return { ...entry, render_version: `${entry.render_version ?? ""}:issue-event-v2` };
}
