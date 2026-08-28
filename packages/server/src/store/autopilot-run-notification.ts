import type { AutopilotRunTriggerSummary } from "@multiremi/api/wire/autopilots.js";

export type AutopilotOutcomeKind = "no_change" | "changes" | "failed" | "unknown";

export interface AutopilotOutcomeLink {
  kind: "pull_request" | "merge_request";
  url: string;
  number?: number;
}

export type AutopilotOutcomeActionKind = "none" | "review" | "retry" | "investigate";

export interface AutopilotOutcomeAction {
  kind: AutopilotOutcomeActionKind;
  text: string | null;
}

export interface AutopilotOutcome {
  kind: AutopilotOutcomeKind;
  text: string | null;
  links: AutopilotOutcomeLink[];
  counts: Record<string, number> | null;
  risks: string[];
  action: AutopilotOutcomeAction;
}

const NO_CHANGE_PATTERN = /(?:\bno changes?\b|\balready up[ -]to[ -]date\b|\bnothing to update\b|\bworking copy remains clean\b|无变更|没有变化|无需更新)/iu;
const PROCESS_NARRATION_PATTERN = /^(?:let me\b|now\s+let(?:'|’)s\b|i(?:'|’)ll\b|checking\b|good\s*[,，]|next\s*[,，])/iu;
const COMPLETE_SENTENCE_END_PATTERN = /[.!?。！？](?:["'”’）)\]}]+)?$/u;
const LINK_PATTERN = /https?:\/\/(?:www\.)?(github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)|code\.byted\.org\/[^\s]+?\/merge_requests\/(\d+))(?=$|[\s`)\]}>.,!?，。！？])/giu;
const RISK_SIGNAL_PATTERN = /(?:未能完成|无法检出|检出失败|失败|拒绝|建议(?:重新)?运行|建议重跑|需要人工|\bfailed\b|\bunable to\b|\bpermission denied\b|\bpublickey\b|\b503\b|\bno available accounts\b|\btime(?:d\s+out|out)\b|\brate limit(?:ed|s)?\b)/iu;
const TRANSIENT_FAILURE_PATTERN = /(?:\b503\b|\bno available accounts\b|\btime(?:d\s+out|out)\b|\brate limit(?:ed|s)?\b|\bpublickey\b)/iu;

export function summarizeAutopilotOutcome(
  value: string | null | undefined,
  options: { failed?: boolean } = {},
): AutopilotOutcome {
  const normalized = value?.replace(/\r\n?/g, "\n").trim() ?? "";
  const links = extractOutcomeLinks(normalized);
  const sentences = usefulSentences(normalized);
  const text = summarizeCompleteSentences(sentences);
  const counts = outcomeCounts(links);
  const risks = extractRisks(sentences);
  const kind: AutopilotOutcomeKind = options.failed
    ? "failed"
    : links.length > 0
      ? "changes"
      : NO_CHANGE_PATTERN.test(normalized)
        && !RISK_SIGNAL_PATTERN.test(normalized)
        && risks.length === 0
        ? "no_change"
        : "unknown";
  const action = deriveAction(kind, links, risks, sentences[0] ?? null);

  return {
    kind,
    text: kind === "no_change" ? null : text,
    links,
    counts,
    risks,
    action,
  };
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
  const duration = formatAutopilotDuration(durationSeconds);
  const prefix = outcome.kind === "failed"
    ? `Failed after ${duration}`
    : `Completed in ${duration}`;
  let summary: string;
  if (outcome.kind === "no_change") summary = "No changes.";
  else if (outcome.kind === "unknown") summary = outcome.text ?? "Run completed.";
  else if (outcome.kind === "failed") summary = outcome.text ?? "Run failed.";
  else {
    summary = outcome.links.length > 0
      ? `Created ${outcome.links.length} change${outcome.links.length === 1 ? "" : "s"}: ${outcome.links.map((link) => link.url).join(", ")}.`
      : outcome.text ?? "Run completed.";
  }

  const action = outcome.action.kind === "none" ? null : actionHint(outcome.action);
  return [prefix, summary, action].filter(Boolean).join(" | ");
}

export function formatAutopilotDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
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

function usefulSentences(value: string): string[] {
  return value
    .split(/\n\s*\n+|\n(?=\s*(?:[-*+]\s+|\d+[.)]\s+))/u)
    .flatMap(splitParagraphIntoSentences)
    .map(cleanSentence)
    .filter((sentence): sentence is string => Boolean(sentence))
    .filter((sentence) => !PROCESS_NARRATION_PATTERN.test(sentence));
}

function summarizeCompleteSentences(sentences: string[]): string | null {
  const selected: string[] = [];
  let length = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]!;
    if (sentence.length > 240) {
      if (selected.length === 0) selected.unshift(truncateSentenceEnd(sentence, 240));
      break;
    }
    const nextLength = length === 0 ? sentence.length : length + sentence.length + 1;
    if (nextLength > 240) break;
    selected.unshift(sentence);
    length = nextLength;
  }
  return selected.length > 0 ? selected.join(" ") : null;
}

function extractRisks(sentences: string[]): string[] {
  const risks: string[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (!RISK_SIGNAL_PATTERN.test(sentence)) continue;
    const risk = truncateSentenceEnd(sentence, 160);
    if (seen.has(risk)) continue;
    seen.add(risk);
    risks.push(risk);
    if (risks.length === 3) break;
  }
  return risks;
}

function deriveAction(
  kind: AutopilotOutcomeKind,
  links: AutopilotOutcomeLink[],
  risks: string[],
  failureFirstSentence: string | null,
): AutopilotOutcomeAction {
  if (kind === "failed") {
    return {
      kind: TRANSIENT_FAILURE_PATTERN.test(risks.join(" ")) ? "retry" : "investigate",
      text: risks[0] ?? failureFirstSentence,
    };
  }
  if (risks.length > 0) return { kind: "investigate", text: risks[0]! };
  if (links.length > 0) return { kind: "review", text: null };
  return { kind: "none", text: null };
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.split(/(?<=[.!?。！？])\s+/u);
}

function truncateSentenceEnd(sentence: string, maxLength: number): string {
  const characters = Array.from(sentence);
  if (characters.length <= maxLength) return sentence;

  const limit = Math.max(1, maxLength - 1);
  let prefix = characters.slice(0, limit).join("");
  const nextCharacter = characters[limit] ?? "";
  if (/[A-Za-z0-9]/u.test(prefix.at(-1) ?? "") && /[A-Za-z0-9]/u.test(nextCharacter)) {
    const wordBoundary = prefix.lastIndexOf(" ");
    if (wordBoundary >= Math.floor(limit / 2)) prefix = prefix.slice(0, wordBoundary);
  }
  return `${prefix.trimEnd()}…`;
}

function cleanSentence(value: string): string | null {
  const sentence = value
    .replace(/^\s*#{1,6}\s*/u, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!sentence) return null;
  if (/^.{1,40}[：:]$/u.test(sentence)) return null;
  if (COMPLETE_SENTENCE_END_PATTERN.test(sentence)) return sentence;
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(sentence)
    ? `${sentence}。`
    : `${sentence}.`;
}

function actionHint(action: AutopilotOutcomeAction): string {
  const detail = action.text ? ` ${action.text}` : "";
  if (action.kind === "review") return "Action: Review the linked change.";
  if (action.kind === "retry") return `Action: Retry this run.${detail}`;
  return `Action: Investigate this run.${detail}`;
}

function isoTime(value: string): string | null {
  const match = value.match(/T(\d{2}:\d{2})/u);
  return match?.[1] ? `${match[1]} UTC` : null;
}
