import type { MultiremiScheduler } from "@multiremi/scheduler.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MemoryWebhookRateLimiter } from "../helpers.js";
import type { GitRemoteInspector } from "../helpers/repositories.js";
import type { AgentPluginGitSourceResolver } from "@multiremi/agent-plugins/git-import.js";
import type { ProjectKnowledgeServiceContract } from "@multiremi/project-knowledge/service.js";
import type { RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";
import type { SessionArchiveService } from "@multiremi/session-archive/service.js";
import type { ScmConnectionVerifier } from "@multiremi/scm/verification.js";
import type { retitleIssue } from "@multiremi/issue-title/service.js";
import type { MessageProviderRegistry } from "@multiremi/messaging/registry.js";

/**
 * The values `createMultiremiApp` closes over. Domain routers receive them
 * explicitly — passing this object is the only change the D3 split makes to
 * the handlers, which are otherwise moved verbatim out of the app factory.
 */
export interface RouterDeps {
  store: MultiremiStore;
  scheduler: MultiremiScheduler | null;
  authToken: string;
  platformUpdaterToken: string;
  shareSecret: string;
  webhookRateLimiter: MemoryWebhookRateLimiter;
  webhookIpRateLimiter: MemoryWebhookRateLimiter;
  inspectGitRemoteRepository: GitRemoteInspector;
  resolveAgentPluginGitSource: AgentPluginGitSourceResolver;
  projectKnowledge: ProjectKnowledgeServiceContract;
  repositoryWiki: RepositoryWikiServiceContract;
  sessionArchives: SessionArchiveService;
  daemonDirectBaseUrl: string | null;
  verifyScmConnection: ScmConnectionVerifier;
  /** The Core's only way to reach a channel. Empty means no Provider is installed. */
  messagingProviders: MessageProviderRegistry;
  issueRetitle: typeof retitleIssue;
}
