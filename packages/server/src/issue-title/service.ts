import type { MultiremiIssue } from "@multiremi/contracts/types.js";
import type { RelayHttpRequest } from "@multiremi/relay/http.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import {
  generateIssueTitle,
  IssueTitleGatewayUnconfiguredError,
} from "./client.js";
import {
  issueTitleContentHash,
  shouldAutoRetitle,
  type AutoRetitleIssue,
} from "./eligibility.js";

export type IssueRetitleSource = "auto" | "manual";
export type IssueRetitleReason = "generated" | "gateway_unconfigured" | "model_failed" | "kept" | "not_eligible";

export interface IssueRetitleResult {
  title: string;
  previousTitle: string;
  applied: boolean;
  reason: IssueRetitleReason;
}

export interface RetitleIssueOptions {
  source: IssueRetitleSource;
  apply: boolean;
  now?: Date;
  httpRequest?: RelayHttpRequest;
}

export async function retitleIssue(
  store: MultiremiStore,
  issueId: string,
  options: RetitleIssueOptions,
): Promise<IssueRetitleResult> {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const previousTitle = issue.title;
  const generatedDescription = issue.description ?? "";
  const generatedContentHash = issueTitleContentHash(generatedDescription);
  const now = options.now ?? new Date();
  const enriched = issueWithEligibilityContext(store, issue);
  if (options.source === "auto" && !shouldAutoRetitle(enriched, now)) {
    return { title: previousTitle, previousTitle, applied: false, reason: "not_eligible" };
  }

  let generated: Awaited<ReturnType<typeof generateIssueTitle>>;
  try {
    generated = await generateIssueTitle(store, {
      issue,
      projectName: enriched.projectName,
      httpRequest: options.httpRequest,
    });
  } catch (error) {
    return {
      title: previousTitle,
      previousTitle,
      applied: false,
      reason: error instanceof IssueTitleGatewayUnconfiguredError
        ? "gateway_unconfigured"
        : "model_failed",
    };
  }

  const kept = generated.keep || generated.title === previousTitle;
  if (!options.apply) {
    return {
      title: kept ? previousTitle : generated.title,
      previousTitle,
      applied: false,
      reason: kept ? "kept" : "generated",
    };
  }

  if (options.source === "auto") {
    const latest = store.getIssue(issue.id);
    if (
      !latest ||
      issueTitleContentHash(latest.description ?? "") !== generatedContentHash ||
      !shouldAutoRetitle(issueWithEligibilityContext(store, latest), now)
    ) {
      return {
        title: latest?.title ?? previousTitle,
        previousTitle,
        applied: false,
        reason: "not_eligible",
      };
    }
  }

  const previousMetadata = store.getIssueAutoTitleMetadata(issue.id);
  const nextMetadata = {
    ...previousMetadata,
    generated_at: now.toISOString(),
    model: generated.model,
    source: options.source,
    content_hash: generatedContentHash,
    count: (previousMetadata.count ?? 0) + (options.source === "auto" ? 1 : 0),
  };
  if (kept) {
    if (options.source === "auto") store.setIssueAutoTitleMetadata(issue.id, nextMetadata);
    return { title: previousTitle, previousTitle, applied: false, reason: "kept" };
  }

  store.updateIssue(issue.id, { title: generated.title });
  store.setIssueAutoTitleMetadata(issue.id, nextMetadata);
  store.appendIssueActivity(issue.id, {
    actorType: "system",
    actorId: null,
    type: "title_renamed",
    body: `${previousTitle} -> ${generated.title}`,
    data: {
      from: previousTitle,
      to: generated.title,
      source: options.source,
      model: generated.model,
    },
  });
  return { title: generated.title, previousTitle, applied: true, reason: "generated" };
}

export function issueWithEligibilityContext(
  store: Pick<MultiremiStore, "getProject" | "getAgent" | "getIssueAutoTitleMetadata">,
  issue: MultiremiIssue,
): AutoRetitleIssue {
  return {
    title: issue.title,
    description: issue.description,
    archivedAt: issue.archivedAt,
    updatedAt: issue.updatedAt,
    metadata: { auto_title: store.getIssueAutoTitleMetadata(issue.id) },
    projectName: issue.projectId ? store.getProject(issue.projectId)?.title ?? null : null,
    agentName: issue.assigneeType === "agent" && issue.assigneeId
      ? store.getAgent(issue.assigneeId)?.name ?? null
      : null,
  };
}
