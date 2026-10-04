import type { AgentTask, AgentTaskProjectDoc, AgentTaskRepositoryWikiDoc } from "@daemon/contracts/types.js";
import { readWikiFetchCache } from "./wiki.js";
import { createHash } from "node:crypto";

type Doc = AgentTaskProjectDoc | AgentTaskRepositoryWikiDoc;
type ReadDoc = (path: string) => Promise<Record<string, any>>;

/** Download complete pages before the existing materializer sees their bodies. */
export async function fetchTaskWikiBodies(workDir: string, task: AgentTask, read: ReadDoc): Promise<void> {
  const cache = readWikiFetchCache(workDir);
  const warnings = task.knowledgeWarnings ??= [];
  const fetchDoc = async <T extends Doc>(doc: T, path: string): Promise<T | null> => {
    const prior = cache.get(doc.id);
    if (prior && prior.version === doc.version && (!doc.content_sha256 || prior.contentSha256 === doc.content_sha256)) {
      return { ...doc, body: prior.body };
    }
    try {
      const response = await read(path);
      const fetched = response.doc;
      if (!fetched || fetched.id !== doc.id || typeof fetched.body !== "string") throw new Error("Wiki body missing");
      return { ...doc, body: fetched.body, version: fetched.version ?? doc.version,
        content_sha256: fetched.content_sha256 ?? createHash("sha256").update(fetched.body).digest("hex"),
        ...(fetched.status ? { status: fetched.status } : {}) };
    } catch {
      warnings.push(`Wiki page ${doc.id} could not be fetched; retaining the last successfully loaded local version. Fetch it with remi wiki.`);
      return prior ? { ...doc, ...prior.doc, body: prior.body, version: prior.version, content_sha256: prior.contentSha256 } as T : null;
    }
  };
  const fetchDocs = async <T extends Doc>(docs: T[], path: (doc: T) => string): Promise<T[]> => {
    const loaded: T[] = [];
    for (let index = 0; index < docs.length; index += 16) {
      const batch = await Promise.all(docs.slice(index, index + 16).map(doc => fetchDoc(doc, path(doc))));
      for (const doc of batch) if (doc !== null) loaded.push(doc as T);
    }
    return loaded;
  };
  const projectDocs = task.projectWikiDocs ?? task.project_wiki_docs ?? [];
  const loaded: AgentTaskProjectDoc[] = [];
  if (warnings.some(warning => warning.startsWith("Project Wiki loading failed"))) {
    for (const prior of cache.values()) {
      if ("kind" in prior.doc && prior.doc.projectId === task.project?.id) loaded.push(prior.doc as AgentTaskProjectDoc);
    }
  }
  loaded.push(...await fetchDocs(projectDocs.filter(doc => doc.projectId ?? task.project?.id),
    doc => `/api/projects/${encodeURIComponent(doc.projectId ?? task.project!.id)}/docs/${encodeURIComponent(doc.id)}`));
  task.projectWikiDocs = loaded;
  task.project_wiki_docs = loaded;
  for (const context of task.projectContexts ?? task.project_contexts ?? []) {
    context.docs = await fetchDocs(context.docs,
      doc => `/api/projects/${encodeURIComponent(context.project.id)}/docs/${encodeURIComponent(doc.id)}`);
  }
  for (const context of task.repositoryWikiContexts ?? task.repository_wiki_contexts ?? []) {
    for (let index = 0; index < context.docs.length; index += 16) {
      const fetchedDocs = await Promise.all(context.docs.slice(index, index + 16).map(async doc => {
        if (doc.status === "unavailable") return doc;
        const fetched = await fetchDoc(doc, `/api/workspaces/${encodeURIComponent(task.workspaceId ?? "local")}`
          + `/repos/${encodeURIComponent(context.repository.id)}/wiki/${encodeURIComponent(doc.id)}`);
        return fetched ?? { ...doc, body: "", status: "unavailable" };
      }));
      context.docs.splice(index, fetchedDocs.length, ...fetchedDocs);
    }
  }
}
