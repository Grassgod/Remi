import { createHash } from "node:crypto";

const MIN_DESCRIPTION_LENGTH = 20;
const MIN_IDLE_MS = 5 * 60 * 1_000;
const MAX_AUTO_RETITLES = 3;
const GENERIC_TITLES = ["remi", "任务", "test", "测试"];

export interface IssueTitleEligibilityContext {
  description?: string | null;
  projectName?: string | null;
  agentName?: string | null;
}

export interface AutoTitleMetadata {
  locked?: boolean;
  content_hash?: string;
  count?: number;
}

export interface AutoRetitleIssue extends IssueTitleEligibilityContext {
  title: string;
  archivedAt?: string | null;
  archived_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[\*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function issueTitleContentHash(description: string): string {
  return createHash("sha256").update(stripMarkdown(description)).digest("hex");
}

export function isLowQualityTitle(title: string, ctx: IssueTitleEligibilityContext = {}): boolean {
  const trimmed = title.trim();
  if ([...trimmed].length < 8 || [...trimmed].length > 80) return true;
  if (/\r|\n/.test(title) || /!\[[^\]]*\]\([^)]*\)/.test(title)) return true;

  const firstDescriptionLine = (ctx.description ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const quickCreateBase = trimmed.endsWith("...") ? trimmed.slice(0, -3).trimEnd() : trimmed;
  if (firstDescriptionLine && (
    trimmed === firstDescriptionLine
    || firstDescriptionLine.startsWith(quickCreateBase)
  )) return true;

  const normalized = trimmed.toLocaleLowerCase();
  return [...GENERIC_TITLES, ctx.projectName ?? "", ctx.agentName ?? ""]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export function shouldAutoRetitle(issue: AutoRetitleIssue, now: Date): boolean {
  if (issue.archivedAt ?? issue.archived_at) return false;
  const autoTitle = readAutoTitleMetadata(issue.metadata?.auto_title);
  if (autoTitle.locked === true || (autoTitle.count ?? 0) >= MAX_AUTO_RETITLES) return false;

  const description = issue.description ?? "";
  if ([...stripMarkdown(description)].length < MIN_DESCRIPTION_LENGTH) return false;

  const updatedAt = issue.updatedAt ?? issue.updated_at;
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs) || now.getTime() - updatedAtMs < MIN_IDLE_MS) return false;

  const lowQuality = isLowQualityTitle(issue.title, issue);
  const contentChanged = Boolean(autoTitle.content_hash)
    && autoTitle.content_hash !== issueTitleContentHash(description);
  return lowQuality || contentChanged;
}

export function readAutoTitleMetadata(value: unknown): AutoTitleMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    locked: raw.locked === true,
    content_hash: typeof raw.content_hash === "string" ? raw.content_hash : undefined,
    count: typeof raw.count === "number" && Number.isFinite(raw.count) ? raw.count : undefined,
  };
}
