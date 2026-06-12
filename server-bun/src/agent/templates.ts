/**
 * Agent template catalog — port of Go agenttmpl. The 25 hand-written templates
 * live as JSON under ./templates (copied verbatim from the Go embed). Each
 * pairs a persona (instructions) with a set of skill references; the picker
 * lists summaries and materialises one into a new agent. Loaded once + cached.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TemplateSkillRef {
  source_url: string;
  cached_name: string;
  cached_description: string;
}

export interface AgentTemplate {
  slug: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  accent?: string;
  instructions: string;
  skills: TemplateSkillRef[];
}

const TEMPLATES_DIR = join(import.meta.dir, "templates");

let cache: AgentTemplate[] | null = null;

/** Parse + cache every templates/*.json, sorted by slug (stable order). */
export function loadAgentTemplates(): AgentTemplate[] {
  if (cache) return cache;
  const out: AgentTemplate[] = [];
  for (const entry of readdirSync(TEMPLATES_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const t = JSON.parse(readFileSync(join(TEMPLATES_DIR, entry), "utf8")) as AgentTemplate;
    if (`${t.slug}.json` !== entry) {
      throw new Error(`agent template ${entry}: slug "${t.slug}" must match the filename`);
    }
    if (!Array.isArray(t.skills)) t.skills = [];
    out.push(t);
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  cache = out;
  return out;
}

/** One template by slug, or null. */
export function getAgentTemplate(slug: string): AgentTemplate | null {
  return loadAgentTemplates().find((t) => t.slug === slug) ?? null;
}
