// components/missions/mission-constants.ts

export interface StatusConfig {
  key: string;
  label: string;
  color: string;
  bgColor: string;
  textColor: string;
  defaultCollapsed: boolean;
}

export const STATUS_ORDER: StatusConfig[] = [
  { key: "blocked",     label: "Blocked",     color: "#f87171", bgColor: "#450a0a", textColor: "#f87171", defaultCollapsed: false },
  { key: "in_progress", label: "In Progress", color: "#fb923c", bgColor: "#422006", textColor: "#fb923c", defaultCollapsed: false },
  { key: "inbox",       label: "Inbox",       color: "#a1a1aa", bgColor: "#27272a", textColor: "#a1a1aa", defaultCollapsed: false },
  { key: "in_review",   label: "In Review",   color: "#a78bfa", bgColor: "#1e1b4b", textColor: "#a78bfa", defaultCollapsed: false },
  { key: "approved",    label: "Approved",    color: "#60a5fa", bgColor: "#172554", textColor: "#60a5fa", defaultCollapsed: false },
  { key: "done",        label: "Done",        color: "#4ade80", bgColor: "#052e16", textColor: "#4ade80", defaultCollapsed: true },
  { key: "rejected",    label: "Rejected",    color: "#f87171", bgColor: "#450a0a", textColor: "#f87171", defaultCollapsed: true },
];

export const KANBAN_COLUMNS = ["inbox", "in_progress", "in_review", "done"] as const;

export const STEP_LABELS: Record<string, string> = {
  intake: "Intake",
  rfc: "RFC",
  decompose: "Decompose",
  execute: "Execute",
  eval: "Eval",
  summary: "Summary",
};

export const PIPELINE_STEPS = ["intake", "rfc", "decompose", "execute", "eval", "summary"] as const;

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_ORDER.find(s => s.key === status) ?? STATUS_ORDER[2]; // default to inbox
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatNum(n: number): string {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
