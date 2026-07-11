import adrWriter from "./agent-templates/adr-writer.json";
import brainstormer from "./agent-templates/brainstormer.json";
import bugFixer from "./agent-templates/bug-fixer.json";
import codeExplainer from "./agent-templates/code-explainer.json";
import codeReviewer from "./agent-templates/code-reviewer.json";
import commitMessage from "./agent-templates/commit-message.json";
import emailReply from "./agent-templates/email-reply.json";
import frontendBuilder from "./agent-templates/frontend-builder.json";
import frontendDesigner from "./agent-templates/frontend-designer.json";
import htmlSlides from "./agent-templates/html-slides.json";
import jdWriter from "./agent-templates/jd-writer.json";
import okrDrafter from "./agent-templates/okr-drafter.json";
import onePager from "./agent-templates/one-pager.json";
import prDescription from "./agent-templates/pr-description.json";
import prdCritic from "./agent-templates/prd-critic.json";
import prdDrafter from "./agent-templates/prd-drafter.json";
import rcaWriter from "./agent-templates/rca-writer.json";
import releaseNotes from "./agent-templates/release-notes.json";
import summarizer from "./agent-templates/summarizer.json";
import translatorZhEn from "./agent-templates/translator-zh-en.json";
import tutor from "./agent-templates/tutor.json";
import userStoryWriter from "./agent-templates/user-story-writer.json";
import uxCopywriter from "./agent-templates/ux-copywriter.json";
import webappTester from "./agent-templates/webapp-tester.json";
import writingCritic from "./agent-templates/writing-critic.json";
import { buildImportedSkillInput } from "@daemon/agent-runtime/skills/skill-import.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import type {
  CreateAgentFromTemplateInput,
  CreateAgentFromTemplateResult,
  CreateSkillInput,
  MultiremiAgentTemplate,
  MultiremiAgentTemplateSkill,
  MultiremiAgentTemplateSummary,
  MultiremiAgentProvider,
  MultiremiSkill,
} from "@multiremi/contracts/types.js";

type RawTemplateSkill = {
  source_url?: string;
  cached_name?: string;
  cached_description?: string;
};

type RawTemplate = {
  slug?: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  accent?: string;
  instructions?: string;
  skills?: RawTemplateSkill[];
};

export class AgentTemplateError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 | 502 = 400, readonly failedUrls: string[] = []) {
    super(message);
    this.name = "AgentTemplateError";
  }
}

const RAW_TEMPLATES: RawTemplate[] = [
  adrWriter,
  brainstormer,
  bugFixer,
  codeExplainer,
  codeReviewer,
  commitMessage,
  emailReply,
  frontendBuilder,
  frontendDesigner,
  htmlSlides,
  jdWriter,
  okrDrafter,
  onePager,
  prDescription,
  prdCritic,
  prdDrafter,
  rcaWriter,
  releaseNotes,
  summarizer,
  translatorZhEn,
  tutor,
  userStoryWriter,
  uxCopywriter,
  webappTester,
  writingCritic,
];

const TEMPLATE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_TEMPLATES = loadAgentTemplates(RAW_TEMPLATES);

export function listAgentTemplates(): MultiremiAgentTemplateSummary[] {
  return AGENT_TEMPLATES.map(templateSummary);
}

export function getAgentTemplate(slug: string): MultiremiAgentTemplate | null {
  const template = AGENT_TEMPLATES.find((item) => item.slug === slug);
  return template ? templateDetail(template) : null;
}

export async function createAgentFromTemplate(
  store: MultiremiStore,
  input: CreateAgentFromTemplateInput,
): Promise<CreateAgentFromTemplateResult> {
  const templateSlug = String(input.templateSlug ?? input.template_slug ?? "").trim();
  if (!templateSlug) throw new AgentTemplateError("template_slug is required", 400);
  const template = getAgentTemplate(templateSlug);
  if (!template) throw new AgentTemplateError(`template not found: ${templateSlug}`, 400);
  const name = String(input.name ?? "").trim();
  if (!name) throw new AgentTemplateError("name is required", 400);
  const provider = normalizeAgentTemplateProvider(input.provider);
  const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
  const createdBy = input.ownerId ?? input.owner_id ?? null;
  const extraSkillIds = input.extraSkillIds ?? input.extra_skill_ids ?? [];

  const importedSkillIds: string[] = [];
  const reusedSkillIds: string[] = [];
  const attachedSkillIds: string[] = [];
  const failedUrls: string[] = [];

  for (const skillRef of template.skills) {
    const existing = findSkillByTemplateRef(store, workspaceId, skillRef);
    if (existing?.id) {
      reusedSkillIds.push(existing.id);
      attachedSkillIds.push(existing.id);
      continue;
    }
    const sourceUrl = skillRef.sourceUrl;
    try {
      const imported = await buildImportedSkillInput({
        url: sourceUrl,
        workspaceId,
        createdBy,
      });
      const importedName = String(imported.skillInput.name ?? "").trim();
      const existingByImportedName = importedName ? findSkillByName(store, workspaceId, importedName) : null;
      if (existingByImportedName?.id) {
        reusedSkillIds.push(existingByImportedName.id);
        attachedSkillIds.push(existingByImportedName.id);
        continue;
      }
      const skillInput: CreateSkillInput = {
        ...imported.skillInput,
        config: {
          ...(imported.skillInput.config ?? {}),
          origin: {
            ...((imported.skillInput.config?.origin as Record<string, unknown> | undefined) ?? {}),
            type: "agent_template",
            template_slug: template.slug,
            source_url: imported.sourceUrl,
          },
        },
      };
      const skill = store.createSkill(skillInput);
      if (skill.id) {
        importedSkillIds.push(skill.id);
        attachedSkillIds.push(skill.id);
      }
    } catch (error) {
      failedUrls.push(sourceUrl);
    }
  }

  if (failedUrls.length) {
    throw new AgentTemplateError("one or more skill sources are unavailable", 422, failedUrls);
  }

  for (const skillId of extraSkillIds) {
    const skill = store.getSkill(skillId);
    if (!skill || skill.workspaceId !== workspaceId) continue;
    attachedSkillIds.push(skillId);
  }

  const agent = store.createAgent({
    name,
    description: input.description ?? template.description,
    provider,
    workspaceId,
    ownerId: createdBy,
    visibility: input.visibility ?? "private",
    avatarUrl: templateAvatarUrl(input),
    instructions: input.instructions ?? template.instructions,
    model: input.model ?? null,
    maxConcurrentTasks: normalizeTemplateMaxConcurrentTasks(input.maxConcurrentTasks ?? input.max_concurrent_tasks),
    skills: [],
  });
  const skills = store.setAgentSkills(agent.id, uniqueStrings(attachedSkillIds));
  const hydratedAgent = { ...store.getAgent(agent.id)!, skills };
  return {
    agent: hydratedAgent,
    importedSkillIds,
    imported_skill_ids: importedSkillIds,
    reusedSkillIds,
    reused_skill_ids: reusedSkillIds,
  };
}

function loadAgentTemplates(rawTemplates: RawTemplate[]): MultiremiAgentTemplate[] {
  const templates = rawTemplates.map(normalizeTemplate);
  const seen = new Set<string>();
  for (const template of templates) {
    if (seen.has(template.slug)) throw new Error(`duplicate agent template slug: ${template.slug}`);
    seen.add(template.slug);
  }
  return templates.sort((left, right) => left.slug.localeCompare(right.slug));
}

function normalizeTemplate(raw: RawTemplate): MultiremiAgentTemplate {
  const slug = String(raw.slug ?? "").trim();
  if (!TEMPLATE_SLUG_RE.test(slug)) throw new Error(`invalid agent template slug: ${slug}`);
  const name = String(raw.name ?? "").trim();
  const instructions = String(raw.instructions ?? "").trim();
  if (!name) throw new Error(`agent template ${slug} is missing name`);
  if (!instructions) throw new Error(`agent template ${slug} is missing instructions`);
  return {
    slug,
    name,
    description: String(raw.description ?? ""),
    category: stringOrUndefined(raw.category),
    icon: stringOrUndefined(raw.icon),
    accent: stringOrUndefined(raw.accent),
    instructions,
    skills: (raw.skills ?? []).map(normalizeTemplateSkill),
  };
}

function normalizeTemplateSkill(raw: RawTemplateSkill): MultiremiAgentTemplateSkill {
  const sourceUrl = String(raw.source_url ?? "").trim();
  if (!sourceUrl) throw new Error("agent template skill is missing source_url");
  const cachedName = String(raw.cached_name ?? "").trim();
  const cachedDescription = String(raw.cached_description ?? "");
  return {
    sourceUrl,
    source_url: sourceUrl,
    cachedName,
    cached_name: cachedName,
    cachedDescription,
    cached_description: cachedDescription,
  };
}

function templateSummary(template: MultiremiAgentTemplate): MultiremiAgentTemplateSummary {
  const { instructions: _instructions, ...summary } = template;
  return {
    ...summary,
    skills: template.skills.map((skill) => ({ ...skill })),
  };
}

function templateDetail(template: MultiremiAgentTemplate): MultiremiAgentTemplate {
  return {
    ...template,
    skills: template.skills.map((skill) => ({ ...skill })),
  };
}

function findSkillByTemplateRef(store: MultiremiStore, workspaceId: string, skillRef: MultiremiAgentTemplateSkill): MultiremiSkill | null {
  const cachedName = skillRef.cachedName.trim();
  if (!cachedName) return null;
  return findSkillByName(store, workspaceId, cachedName);
}

function findSkillByName(store: MultiremiStore, workspaceId: string, name: string): MultiremiSkill | null {
  return store.listSkills(workspaceId, { includeFiles: false }).find((skill) => skill.name === name) ?? null;
}

function normalizeAgentTemplateProvider(value: MultiremiAgentProvider | null | undefined): MultiremiAgentProvider {
  const provider = String(value ?? "claude").trim();
  if (!provider || provider === "any") return "claude";
  return provider;
}

function normalizeTemplateMaxConcurrentTasks(value: unknown): number {
  const concurrency = Number(value ?? 0);
  if (!concurrency) return 6;
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new AgentTemplateError("max_concurrent_tasks must be at least 1", 400);
  return Math.trunc(concurrency);
}

function templateAvatarUrl(input: CreateAgentFromTemplateInput): string | null {
  const value = input.avatarUrl ?? input.avatar_url;
  return typeof value === "string" && value !== "" ? value : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}
