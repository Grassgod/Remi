import type { AutopilotRunTriggerSummary } from "@multiremi/api/wire/autopilots.js";

export type AutopilotOutcomeKind = "no_change" | "changes" | "failed" | "unknown";

export interface AutopilotOutcomeLink {
  kind: "pull_request" | "merge_request";
  url: string;
  number?: number;
}

export interface AutopilotOutcome {
  kind: AutopilotOutcomeKind;
  text: string | null;
  links: AutopilotOutcomeLink[];
  counts: Record<string, number> | null;
}

const NO_CHANGE_PATTERN = /(?:\bno changes?\b|\balready up[ -]to[ -]date\b|\bnothing to update\b|\bworking copy remains clean\b|无变更|没有变化|无需更新)/iu;
const PROCESS_NARRATION_PATTERN = /^(?:let me\b|now\s+let(?:'|’)s\b|i(?:'|’)ll\b|checking\b|good\s*[,，]|next\s*[,，])/iu;
const COMPLETE_SENTENCE_END_PATTERN = /[.!?。！？](?:["'”’）)\]}]+)?$/u;
const LINK_PATTERN = /https?:\/\/(?:www\.)?(github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)|code\.byted\.org\/[^\s]+?\/merge_requests\/(\d+))(?=$|[\s`)\]}>.,!?，。！？])/giu;

export function summarizeAutopilotOutcome(
  value: string | null | undefined,
  options: { failed?: boolean } = {},
): AutopilotOutcome {
  const normalized = value?.replace(/\r\n?/g, "\n").trim() ?? "";
  const links = extractOutcomeLinks(normalized);
  const text = summarizeCompleteSentences(normalized);
  const counts = outcomeCounts(links);

  if (options.failed) return { kind: "failed", text, links, counts };
  if (links.length > 0) return { kind: "changes", text, links, counts };
  if (NO_CHANGE_PATTERN.test(normalized)) {
    return { kind: "no_change", text: null, links: [], counts: null };
  }
  return { kind: text ? "changes" : "unknown", text, links: [], counts: null };
}

export function autopilotTriggerObjectLabel(
  trigger: AutopilotRunTriggerSummary | null,
  source: string,
  triggeredAt: string,
): string | null {
  if (trigger?.repository_name) {
    if (trigger.change_number != null) {
      return `${trigger.repository_name} #${trigger.change_number}`;
    }
    return trigger.target_branch
      ? `${trigger.repository_name}@${trigger.target_branch}`
      : trigger.repository_name;
  }
  if (source === "schedule" || trigger?.event_type === "schedule") {
    const time = isoTime(triggeredAt);
    return time ? `Scheduled ${time}` : "Scheduled run";
  }
  return null;
}

export function autopilotOutcomeBody(
  outcome: AutopilotOutcome,
  durationSeconds: number,
): string {
  const prefix = outcome.kind === "failed"
    ? `Failed after ${durationSeconds}s`
    : `Completed in ${durationSeconds}s`;
  if (outcome.kind === "no_change") return `${prefix} | No changes.`;
  if (outcome.kind === "unknown") return `${prefix} | Run completed.`;
  if (outcome.kind === "failed") return `${prefix} | ${outcome.text ?? "Run failed."}`;

  const linkSummary = outcome.links.length > 0
    ? `Created ${outcome.links.length} change${outcome.links.length === 1 ? "" : "s"}: ${outcome.links.map((link) => link.url).join(", ")}.`
    : null;
  return `${prefix} | ${linkSummary ?? outcome.text ?? "Run completed."}`;
}

function extractOutcomeLinks(value: string): AutopilotOutcomeLink[] {
  const links: AutopilotOutcomeLink[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(LINK_PATTERN)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const pullNumber = match[2] ? Number(match[2]) : null;
    const mergeNumber = match[3] ? Number(match[3]) : null;
    links.push({
      kind: pullNumber != null ? "pull_request" : "merge_request",
      url,
      ...((pullNumber ?? mergeNumber) != null ? { number: pullNumber ?? mergeNumber ?? undefined } : {}),
    });
  }
  return links;
}

function outcomeCounts(links: AutopilotOutcomeLink[]): Record<string, number> | null {
  if (links.length === 0) return null;
  const pullRequests = links.filter((link) => link.kind === "pull_request").length;
  const mergeRequests = links.length - pullRequests;
  return {
    changes: links.length,
    ...(pullRequests > 0 ? { pull_requests: pullRequests } : {}),
    ...(mergeRequests > 0 ? { merge_requests: mergeRequests } : {}),
  };
}

function summarizeCompleteSentences(value: string): string | null {
  const sentences = value
    .split(/\n+/u)
    .flatMap(splitLineIntoSentences)
    .map(cleanSentence)
    .filter((sentence): sentence is string => Boolean(sentence))
    .filter((sentence) => !PROCESS_NARRATION_PATTERN.test(sentence));

  const selected: string[] = [];
  let length = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]!;
    if (sentence.length > 240) continue;
    const nextLength = length === 0 ? sentence.length : length + sentence.length + 1;
    if (nextLength > 240) break;
    selected.unshift(sentence);
    length = nextLength;
  }
  return selected.length > 0 ? selected.join(" ") : null;
}

function splitLineIntoSentences(line: string): string[] {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.split(/(?<=[.!?。！？])\s+/u);
}

function cleanSentence(value: string): string | null {
  const sentence = value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!sentence) return null;
  return COMPLETE_SENTENCE_END_PATTERN.test(sentence) ? sentence : `${sentence}.`;
}

function isoTime(value: string): string | null {
  const match = value.match(/T(\d{2}:\d{2})/u);
  return match?.[1] ? `${match[1]} UTC` : null;
}
