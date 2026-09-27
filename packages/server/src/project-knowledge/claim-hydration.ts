import type { MultiremiTaskRepositoryWikiContext, MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import type { ProjectKnowledgeServiceContract } from "./service.js";
import type { RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";

/**
 * Upper bound on the Wiki body bytes a single claim may carry.
 *
 * A claim is one synchronous hop through the Postgres bridge plus one HTTP response, and the
 * daemon only needs the bodies to materialize its local working copy — it can always fetch a
 * page on demand with `remi wiki`. Without a bound, one large Project grows the claim until the
 * bridge copy, the JSON parse and the daemon's start-up all pay for content the turn may never
 * read (MUL-383 C.5 measured 5.0 MB and 3.9 s for a single claim).
 *
 * 512 KiB leaves realistic Issues fully hydrated — this repository's own Wiki is far under it —
 * while keeping the worst case bounded.
 */
export const CLAIM_KNOWLEDGE_BYTE_CAP = 512 * 1024;

/**
 * One budget covers both stores. Failures are explicit prompt warnings, never fabricated knowledge.
 *
 * After both stores resolve, the bodies are capped as a whole. Docs are walked in the order the
 * stores returned them and any doc that does not fit is skipped — never truncated — so what does
 * arrive is always a complete document.
 *
 * The two stores degrade differently on purpose, because the daemon treats them differently:
 *
 * - **Project Wiki**: an over-cap doc is dropped whole. The daemon's Issue working copy removes a
 *   local file that is unmodified and keeps an edited one, so a dropped doc costs at most a
 *   single `remi wiki` fetch, and — critically — an empty body can never reach the baseline that
 *   `remi wiki push` merges from.
 * - **Repository Wiki**: the doc keeps its metadata with `status: "unavailable"` and an empty
 *   body. The daemon's existing `repositoryWikiDocUnavailable` check then keeps the prior local
 *   copy and skips the write, which is a stronger guarantee than dropping the entry (the page
 *   stays in the manifest and in the prompt's page list).
 */
export async function hydrateClaimKnowledge(
  task: MultiremiTaskWithAgent,
  project: ProjectKnowledgeServiceContract,
  repository: RepositoryWikiServiceContract,
  budgetMs = 5_000,
  byteCap = CLAIM_KNOWLEDGE_BYTE_CAP,
): Promise<MultiremiTaskWithAgent> {
  const abort = new AbortController();
  let expire!: () => void;
  const expired = new Promise<null>(resolve => { expire = () => { abort.abort(); resolve(null); }; });
  const timer = setTimeout(expire, budgetMs);
  let result = task;
  const warnings: string[] = [];
  try {
    const projectResult = await Promise.race([
      project.hydrateTaskKnowledge(result, abort.signal).catch(() => null), expired,
    ]);
    if (projectResult) result = projectResult;
    else {
      warnings.push("Project Wiki loading failed or exceeded the startup budget. Project Wiki content was not loaded; retrieve it with remi wiki commands when needed.");
      result = { ...result, projectDocs: null, projectWikiDocs: [],
        projectContexts: result.projectContexts.map(context => ({ ...context, docs: [] })) };
    }
    const repositoryResult = abort.signal.aborted ? null : await Promise.race([
      repository.hydrateTaskWiki(result, abort.signal).catch(() => null), expired,
    ]);
    if (repositoryResult) result = repositoryResult;
    else {
      warnings.push("Repository Wiki loading failed or exceeded the startup budget. Repository Wiki content was not loaded; use remi wiki repository commands to retrieve it when needed. Do not claim to have read unavailable pages.");
      result = { ...result, repositoryWikiContexts: [] };
    }
    const capped = applyClaimKnowledgeByteCap(result, byteCap);
    warnings.push(...capped.warnings);
    return { ...capped.task, knowledgeWarnings: [...(task.knowledgeWarnings ?? []), ...warnings] };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Body bytes of one Wiki document, as they cross the bridge and the response. */
function docBodyBytes(doc: { body?: string | null }): number {
  return Buffer.byteLength(String(doc.body ?? ""), "utf8");
}

/** Drop whole docs that do not fit, walking in the order the stores returned them. */
function fitDocsInOrder<T extends { body?: string | null; title?: string | null; path?: string | null; slug?: string | null }>(
  docs: readonly T[],
  budget: { remaining: number },
  label: (doc: T) => string,
): { kept: T[]; omitted: string[] } {
  const kept: T[] = [];
  const omitted: string[] = [];
  for (const doc of docs) {
    const bytes = docBodyBytes(doc);
    if (bytes > budget.remaining) {
      omitted.push(`${label(doc)} (${bytes} bytes)`);
      continue;
    }
    budget.remaining -= bytes;
    kept.push(doc);
  }
  return { kept, omitted };
}

/**
 * Enforce the cap across every Wiki body on the claim.
 *
 * Exported so the acceptance tests can drive it directly with fixture documents instead of
 * building a store large enough to cross the cap.
 */
export function applyClaimKnowledgeByteCap(
  task: MultiremiTaskWithAgent,
  byteCap = CLAIM_KNOWLEDGE_BYTE_CAP,
): { task: MultiremiTaskWithAgent; warnings: string[] } {
  if (!Number.isFinite(byteCap) || byteCap <= 0) return { task, warnings: [] };
  const budget = { remaining: byteCap };
  const warnings: string[] = [];

  // Project Wiki: dropped whole, and never sent with an empty body. The main list and the
  // Intake `projectContexts` carry the same documents, so a doc is decided once: whichever
  // entry is seen first claims the bytes, and every other appearance of that id follows it.
  const projectWikiDocs = task.projectWikiDocs ?? [];
  const projectFit = fitDocsInOrder(projectWikiDocs, budget,
    (doc) => doc.path ?? doc.slug ?? doc.title ?? doc.id ?? "<untitled>");
  const omittedProjectIds = new Set(projectWikiDocs
    .filter((doc) => !projectFit.kept.includes(doc))
    .map((doc) => doc.id));
  const projectContexts = task.projectContexts.map((context) => ({
    ...context,
    docs: (context.docs ?? []).filter((doc) => !omittedProjectIds.has(doc.id)),
  }));

  // Repository Wiki: keep metadata, mark unavailable, never keep a body. The daemon's
  // `repositoryWikiDocUnavailable` check then keeps the prior local copy and skips the write,
  // so the page stays in the manifest and in the prompt's page list.
  const repositoryWikiContexts: MultiremiTaskRepositoryWikiContext[] = (task.repositoryWikiContexts ?? []).map((context) => {
    const fit = fitDocsInOrder(context.docs, budget,
      (doc) => `${context.repository.name}/${doc.path ?? doc.id}`);
    const keptIds = new Set(fit.kept.map((doc) => doc.id));
    const omittedMessage = `Repository Wiki body omitted from this claim: it exceeds the ${byteCap}-byte claim budget. Fetch it with remi wiki.`;
    return {
      ...context,
      // The daemon reads `status` as an open string and its `repositoryWikiDocUnavailable`
      // check treats `unavailable` as "keep the prior copy, do not write". The control-plane
      // type is narrower than the wire, so the marker is applied through one assertion at the
      // boundary rather than by widening the shared contracts type.
      docs: context.docs.map((doc) => keptIds.has(doc.id) ? doc : ({
        ...doc,
        body: "",
        status: "unavailable" as unknown as typeof doc.status,
        statusMessage: omittedMessage,
      })),
    };
  });
  const repositoryOmitted = (task.repositoryWikiContexts ?? []).flatMap((context) =>
    context.docs
      .filter((doc) => byteCap !== Infinity && !(docBodyBytes(doc) <= byteCap))
      .map((doc) => `${context.repository.name}/${doc.path ?? doc.id} (${docBodyBytes(doc)} bytes)`));

  const droppedProjectNames = projectWikiDocs
    .filter((doc) => omittedProjectIds.has(doc.id))
    .map((doc) => `${doc.path ?? doc.slug ?? doc.id} (${docBodyBytes(doc)} bytes)`);
  if (droppedProjectNames.length || repositoryOmitted.length) {
    const named = [
      ...droppedProjectNames,
      ...repositoryOmitted,
    ];
    warnings.push([
      `Wiki bodies omitted from this claim to keep it under the ${byteCap}-byte budget:`,
      `${named.join("; ")}.`,
      "Fetch any of them on demand with `remi wiki` (Project Wiki) or `remi wiki repository` (Repository Wiki) before relying on their content.",
      "A Repository Wiki page listed as unavailable keeps its previous local copy.",
    ].join(" "));
  }

  return {
    task: {
      ...task,
      projectWikiDocs: projectFit.kept,
      projectContexts,
      repositoryWikiContexts,
    },
    warnings,
  };
}
