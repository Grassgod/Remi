import type { SessionLogEntry } from "@multiremi/core/replica";
import { quotePreview } from "../../issues/utils/quote-preview";

const INTERNAL_ID = /\b(?:cmt_env|cmt|ises|tsk|sevt|chat|cses|agt|iss|sres|res|att|dlg|prj|repo|rt)_[a-zA-Z0-9][a-zA-Z0-9_-]*\b/g;

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

export function delegationReporter(markdown: string): string {
  const firstLine = markdown.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(/^(.+?) (?:completed|could not complete) a task you delegated\.$/)
    ?? firstLine.match(/^A task you delegated to (.+?) was cancelled\.$/);
  return match ? eventSummary(match[1]!) : "";
}

export function delegationBodyOutcome(markdown: string): "completed" | "failed" | "cancelled" | null {
  const firstLine = markdown.trim().split(/\r?\n/, 1)[0] ?? "";
  if (/ completed a task you delegated\.$/.test(firstLine)) return "completed";
  if (/ could not complete a task you delegated\.$/.test(firstLine)) return "failed";
  if (/^A task you delegated to .+ was cancelled\.$/.test(firstLine)) return "cancelled";
  return reportOutcome(markdown.match(/^Status:\s*(completed|failed|cancelled)\s*$/m)?.[1]);
}

export function chatIssueUpdate(markdown: string, metadata: unknown) {
  const key = markdown.match(/^\s*([A-Z][A-Z0-9]*-\d+)\s+有新日志[：:]/)?.[1];
  if (!key) return null;
  const envelope = metadataRecord(metadataRecord(metadata).envelope);
  const source = metadataRecord(envelope.source);
  const bodyStatus = markdown.match(/状态\s+(completed|failed|cancelled)\b/)?.[1];
  return { key, issueId: metadataString(source.issueId),
    outcome: reportOutcome(envelope.outcome) ?? reportOutcome(bodyStatus) };
}

// Summary and expanded bodies must never reuse each other's measured heights,
// or heights left in the replica by the previous full-markdown presentation.
export function eventLayoutEntry(entry: SessionLogEntry, view: "issue" | "chat", expanded = false): SessionLogEntry {
  return { ...entry, render_version: `${entry.render_version ?? ""}:${view}-event-v1:${expanded ? "expanded" : "summary"}` };
}
