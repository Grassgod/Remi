/**
 * Multiremi CLI — request body and query field builders shared by the REST
 * command handlers.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { readFileSync } from "node:fs";
import {
  type CliOptions,
  camelizeOptionKey,
  hasOption,
  rawStringOption,
  stringListOption,
  stringOpt,
} from "../options.js";
import { isHttpUrl } from "../http.js";

export const VALID_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];

export const VALID_ISSUE_ASSIGNEE_TYPES = ["agent", "member", "squad"];

/**
 * `--ref issue:MUL-12` / `--ref task:tsk_1` / `--ref url:https://…`, repeatable.
 * A bare http(s) URL is accepted as a url ref so the caller does not have to
 * prefix it; anything else without a type prefix is a usage error. On update the
 * parsed list replaces the target's refs wholesale.
 *
 * Shared by project docs and published Session results — both carry the same
 * `{type, value}` citation shape.
 */
export function citationRefsOption(options: CliOptions): Array<{ type: string; value: string }> | null {
  if (!hasOption(options, "ref")) return null;
  const refs: Array<{ type: string; value: string }> = [];
  for (const raw of stringListOption(options, "ref")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (isHttpUrl(entry)) {
      refs.push({ type: "url", value: entry });
      continue;
    }
    const separator = entry.indexOf(":");
    const type = separator > 0 ? entry.slice(0, separator).trim() : "";
    const value = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!type || !value) {
      throw new Error(`--ref ${JSON.stringify(raw)} must be <type>:<value> (issue:<id>, task:<id>, url:<url>) or an http(s) URL`);
    }
    refs.push({ type, value });
  }
  return refs;
}

export function parseMetadataValue(raw: string, forcedType: string | null): string | number | boolean {
  switch (forcedType) {
    case "string":
      return raw;
    case "number": {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`value ${JSON.stringify(raw)} is not a valid number`);
      return number;
    }
    case "bool":
      if (raw !== "true" && raw !== "false") throw new Error(`value ${JSON.stringify(raw)} is not a valid bool (expected true or false)`);
      return raw === "true";
    case null:
      break;
    default:
      throw new Error(`unknown --type ${JSON.stringify(forcedType)} (expected string, number, or bool)`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return parsed;
  } catch {}
  return raw;
}

export async function readOptionalTextBody(options: CliOptions, name: string): Promise<{ set: boolean; value: string }> {
  const stdinKey = `${name}-stdin`;
  const fileKey = `${name}-file`;
  const camelFileKey = `${name}File`;
  const sources = [hasOption(options, name), hasOption(options, stdinKey), hasOption(options, fileKey) || hasOption(options, camelFileKey)]
    .filter(Boolean).length;
  if (sources === 0) return { set: false, value: "" };
  if (sources > 1) throw new Error(`--${name}, --${stdinKey}, and --${fileKey} are mutually exclusive`);
  if (hasOption(options, stdinKey)) return { set: true, value: await readStdin() };
  const file = rawStringOption(options, fileKey, camelFileKey);
  if (file != null) return { set: true, value: readFileSync(file, "utf8") };
  const inline = rawStringOption(options, name);
  if (inline == null) throw new Error(`--${name} requires a value`);
  return { set: true, value: inline };
}

export function addStringBodyField(
  body: Record<string, unknown>,
  options: CliOptions,
  bodyKey: string,
  optionKey: string,
  validateStatus = false,
  includeEmptyAsNull = false,
): void {
  if (!hasOption(options, optionKey)) return;
  const value = rawStringOption(options, optionKey);
  if (value == null) throw new Error(`--${optionKey} requires a value`);
  if (validateStatus && value && !VALID_ISSUE_STATUSES.includes(value)) {
    throw new Error(`invalid status ${JSON.stringify(value)}; valid values: ${VALID_ISSUE_STATUSES.join(", ")}`);
  }
  body[bodyKey] = value === "" && includeEmptyAsNull ? null : value;
}

export function addAssigneeBodyFields(
  body: Record<string, unknown>,
  options: CliOptions,
  idKey: string,
  typeKey: string,
  nameKey: string,
): void {
  const id = rawStringOption(options, idKey, camelizeOptionKey(idKey)) ?? rawStringOption(options, nameKey);
  if (id == null) return;
  if (!id.trim()) throw new Error(`--${idKey} requires a value`);
  const type = rawStringOption(options, typeKey, camelizeOptionKey(typeKey)) ?? inferAssigneeTypeFromId(id);
  if (type && !VALID_ISSUE_ASSIGNEE_TYPES.includes(type)) {
    throw new Error(`invalid --${typeKey} ${JSON.stringify(type)}; expected agent, member, or squad`);
  }
  if (type) body.assignee_type = type;
  body.assignee_id = id;
}

export function inferAssigneeTypeFromId(id: string): string | null {
  if (/^agt_/i.test(id)) return "agent";
  if (/^mem_/i.test(id)) return "member";
  if (/^sqd_/i.test(id)) return "squad";
  return null;
}

export function subscriberBodyFromOptions(options: CliOptions): Record<string, unknown> {
  const memberId = rawStringOption(options, "user-id", "userId", "member-id", "memberId", "user");
  const body: Record<string, unknown> = {};
  if (memberId) body.member_id = memberId;
  return body;
}

export function actorBodyFromOptions(options: CliOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const actorType = rawStringOption(options, "actor-type", "actorType");
  const actorId = rawStringOption(options, "actor-id", "actorId");
  if (actorType) body.actor_type = actorType;
  if (actorId) body.actor_id = actorId;
  return body;
}

export function metadataFilterFromOptions(options: CliOptions): Record<string, string | number | boolean> | null {
  const raw = rawStringOption(options, "metadata");
  if (!raw) return null;
  const filter: Record<string, string | number | boolean> = {};
  for (const pair of raw.split(",")) {
    if (!pair.trim()) continue;
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`--metadata ${JSON.stringify(pair)} must be in key=value form`);
    const key = pair.slice(0, index).trim();
    if (key in filter) throw new Error(`--metadata key ${JSON.stringify(key)} given more than once`);
    filter[key] = parseMetadataValue(pair.slice(index + 1), null);
  }
  return Object.keys(filter).length ? filter : null;
}

export async function readCommentBody(options: CliOptions): Promise<string> {
  return readContentBody(options, "comment body");
}

export async function readContentBody(options: CliOptions, label: string): Promise<string> {
  const content = stringOpt(options.content, undefined);
  if (content != null) return content;
  const contentFile = stringOpt(options.contentFile ?? options["content-file"], undefined);
  if (contentFile) return readFileSync(contentFile, "utf8");
  if (Boolean(options.contentStdin ?? options["content-stdin"])) return await readStdin();
  throw new Error(`${label} is required: pass --content, --content-file, or --content-stdin`);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
