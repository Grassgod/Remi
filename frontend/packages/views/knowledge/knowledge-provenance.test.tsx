// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { KnowledgeRunDetail } from "@multiremi/core/types";
import enCommon from "../locales/en/common.json";
import enProjects from "../locales/en/projects.json";

const queryState = vi.hoisted(() => ({
  data: undefined as KnowledgeRunDetail | undefined,
  pending: false,
  error: false,
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: () => ({
    data: queryState.data,
    isPending: queryState.pending,
    isError: queryState.error,
  }),
}));
vi.mock("@multiremi/core/knowledge", () => ({
  knowledgeRunOptions: () => ({ queryKey: ["knowledge-run"] }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/ws/issues/${id}`,
    projectWikiPage: (id: string, ref: string) => `/ws/projects/${id}/wiki/${ref}`,
    repositoryWikiPage: (id: string, path: string) => `/ws/repos/${id}/wiki/${path}`,
  }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span>{actorId}</span>,
}));
vi.mock("../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

import { KnowledgeProvenance } from "./knowledge-provenance";

function renderPanel(compilationRunId?: string | null) {
  render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, projects: enProjects } }}>
      <KnowledgeProvenance compilationRunId={compilationRunId} />
    </I18nProvider>,
  );
}

describe("KnowledgeProvenance", () => {
  beforeEach(() => Object.assign(queryState, { data: undefined, pending: false, error: false }));

  it("marks a formal document without compilation_run_id as unverified history", () => {
    renderPanel(null);
    expect(screen.getByText("Unverified history")).toBeInTheDocument();
    expect(screen.getByText(/remains readable and recallable/)).toBeInTheDocument();
  });

  it("shows the Atlas, decision, all Raw sources, outputs, task, issue, and commit", () => {
    queryState.data = {
      run: {
        id: "krun-1", workspace_id: "ws-1", project_id: "proj-1", repository_id: null,
        task_id: "atlas-task", agent_id: "atlas-agent", autopilot_run_id: null,
        mode: "issue_ingest", status: "published", result_summary: "Merged related facts",
        dedupe_key: "batch", created_at: "", completed_at: "", agent: { id: "atlas-agent", name: "Atlas" },
        provenance: null,
      },
      sources: [
        {
          id: "src-1", run_id: "krun-1", submission_id: "raw-1", source_type: "submission",
          source_ref: null, metadata: {}, created_at: "",
          submission: {
            id: "raw-1", workspace_id: "ws-1", project_id: "proj-1", repository_id: null,
            scope: "project_wiki", source_type: "agent", proposed_path: "overview.md", proposed_slug: null,
            body: "a", patch: null, base_revision: null, source_task_id: "task-1", source_issue_id: "issue-1",
            source_revision: "abcdef1234567890", author_agent_id: "author-1", content_sha256: "sha",
            status: "consumed", created_at: "", updated_at: "",
            source_issue: { id: "issue-1", key: "MUL-213", title: "Knowledge chain" },
            author_agent: { id: "author-1", name: "Executor" }, source_task: { id: "task-1", status: "completed" },
          },
        },
        { id: "src-2", run_id: "krun-1", submission_id: "raw-2", source_type: "submission", source_ref: null, metadata: {}, created_at: "", submission: null },
      ],
      outputs: [
        { id: "out-1", run_id: "krun-1", artifact_scope: "project_wiki", doc_id: "doc-1", revision_id: "rev-1", version: 2, action: "merge", content_sha256: null, created_at: "", artifact: { id: "doc-1", title: "Overview", path: "overview.md" } },
        { id: "out-2", run_id: "krun-1", artifact_scope: "memory", doc_id: "doc-2", revision_id: "rev-2", version: 1, action: "split", content_sha256: null, created_at: "", artifact: { id: "doc-2", title: "Runtime fact", path: "runtime.md" } },
      ],
    };
    renderPanel("krun-1");

    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("Merged related facts")).toBeInTheDocument();
    expect(screen.getByText(/raw-1/)).toBeInTheDocument();
    expect(screen.getByText("raw-2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MUL-213" })).toHaveAttribute("href", "/ws/issues/issue-1");
    expect(screen.getByText(/task-1/)).toBeInTheDocument();
    expect(screen.getByText("abcdef123456")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Overview/ })).toHaveAttribute("href", "/ws/projects/proj-1/wiki/doc-1");
    expect(screen.getByRole("link", { name: /Runtime fact/ })).toBeInTheDocument();
  });

  it("degrades a missing linked run to an unknown source message", () => {
    queryState.error = true;
    renderPanel("krun-missing");
    expect(screen.getByText("Unknown source")).toBeInTheDocument();
    expect(screen.getByText(/currently unavailable/)).toBeInTheDocument();
  });
});
