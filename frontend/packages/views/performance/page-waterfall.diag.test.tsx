import { appendFileSync, rmSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { createQueryClient } from "@multiremi/core/query-client";
import { paths } from "@multiremi/core/paths";
import { setApiInstance } from "@multiremi/core/api";
import { RESOURCES } from "../locales";

const navigationState = vi.hoisted(() => ({
  pathname: "/test",
  searchParams: new URLSearchParams(),
}));

const mockContext = vi.hoisted(() => ({
  workspace: {
    id: "ws-1",
    name: "Test workspace",
    slug: "test",
    description: null,
    context: null,
    settings: {},
    repos: [],
    issue_prefix: "TST",
    avatar_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  user: {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    avatar_url: null,
    onboarded_at: "2026-01-01T00:00:00.000Z",
    onboarding_questionnaire: {},
    starter_content_state: "imported",
    language: "en",
    profile_description: "",
    timezone: "UTC",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
}));

const workspace = {
  id: "ws-1",
  name: "Test workspace",
  slug: "test",
  description: null,
  context: null,
  settings: {},
  repos: [],
  issue_prefix: "TST",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const user = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  avatar_url: null,
  onboarded_at: "2026-01-01T00:00:00.000Z",
  onboarding_questionnaire: {},
  starter_content_state: "imported",
  language: "en",
  profile_description: "",
  timezone: "UTC",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

vi.mock("@multiremi/core/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/hooks")>()),
  useWorkspaceId: () => mockContext.workspace.id,
}));

vi.mock("@multiremi/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => mockContext.workspace,
    useWorkspacePaths: () => actual.paths.workspace(mockContext.workspace.slug),
  };
});

vi.mock("@multiremi/core/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/auth")>();
  const state = {
    user: mockContext.user,
    isLoading: false,
    setUser: vi.fn(),
    logout: vi.fn(),
    refreshMe: vi.fn(),
  };
  return {
    ...actual,
    useAuthStore: Object.assign(
      (selector?: (value: typeof state) => unknown) => selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});

vi.mock("../navigation", () => ({
  AppLink: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
  useNavigation: () => ({
    pathname: navigationState.pathname,
    searchParams: navigationState.searchParams,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  NavigationProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("@multiremi/core/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/realtime")>()),
  useWSEvent: () => undefined,
  useWSReconnect: () => undefined,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: null }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  pointerWithin: vi.fn(),
  closestCenter: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  verticalListSortingStrategy: {},
  arrayMove: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

import { WorkbenchPage } from "../workbench";
import { InboxPage } from "../inbox";
import { IssuesPage } from "../issues/components";
import { DashboardPage } from "../dashboard";
import { MyIssuesPage } from "../my-issues";
import { ProjectDetail, ProjectsPage } from "../projects/components";
import { AgentDetailPage, AgentsPage } from "../agents";
import { RuntimesPage } from "../runtimes";
import { SquadsPage } from "../squads";
import { SkillsPage } from "../skills";
import { AutopilotsPage } from "../autopilots/components";
import { PluginsPage } from "../plugins";
import { MemberDetailPage } from "../members";
import { RepositoriesPage } from "../repositories";
import { KnowledgePage } from "../knowledge";
import { SettingsPage } from "../settings";

const OUTPUT_PATH = "/tmp/mul180-page-waterfalls.txt";
const SYNTHETIC_DELAY_MS = 20;
const WAVE_GAP_MS = 10;

interface ApiCall {
  method: string;
  args: string;
  startedAt: number;
  endedAt: number;
}

interface PageResult {
  page: string;
  cold: ApiCall[];
  coldWaves: ApiCall[][];
  warm: ApiCall[];
  warmWaves: ApiCall[][];
}

const project = {
  id: "project-1",
  workspace_id: workspace.id,
  title: "Test project",
  description: null,
  instructions: "",
  delta_instructions: "",
  instructions_revision: 1,
  instructions_updated_at: null,
  instructions_updated_by: null,
  icon: null,
  status: "in_progress",
  priority: "none",
  lead_type: null,
  lead_id: null,
  default_assignee_type: null,
  default_assignee_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  issue_count: 0,
  done_count: 0,
  resource_count: 0,
};

const agent = {
  id: "agent-1",
  workspace_id: workspace.id,
  runtime_id: "",
  provider: "codex",
  name: "Test agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  status: "idle",
  max_concurrent_tasks: 1,
  model: "",
  reasoning_effort: "",
  role: "normal",
  owner_id: user.id,
  skills: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const member = {
  id: "member-1",
  workspace_id: workspace.id,
  user_id: user.id,
  role: "owner",
  name: user.name,
  email: user.email,
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const autopilot = {
  id: "autopilot-1",
  workspace_id: workspace.id,
  title: "Test autopilot",
  description: null,
  project_id: project.id,
  assignee_type: "agent",
  assignee_id: agent.id,
  status: "active",
  execution_mode: "run_only",
  session_policy: "new",
  workspace_policy: "reuse_issue",
  issue_title_template: null,
  created_by_type: "member",
  created_by_id: user.id,
  last_run_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const plugin = {
  id: "plugin-1",
  workspaceId: workspace.id,
  provider: "claude",
  name: "Test plugin",
  description: "Representative populated-page fixture",
  activeVersion: null,
  bindingCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function issueForStatus(status: string) {
  return {
    id: `issue-${status}`,
    workspace_id: workspace.id,
    number: 1,
    identifier: `TST-${status}`,
    title: `Issue ${status}`,
    description: "Representative populated-page fixture",
    status,
    priority: "none",
    assignee_type: "member",
    assignee_id: user.id,
    creator_type: "member",
    creator_id: user.id,
    parent_issue_id: null,
    project_id: project.id,
    position: 0,
    start_date: null,
    due_date: null,
    completed_at: null,
    archived_at: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function apiResponse(method: string, args: unknown[]): unknown {
  switch (method) {
    case "listIssues": {
      const params = args[0] as { status?: string; archived_only?: boolean } | undefined;
      if (!params?.status || params.archived_only) return { issues: [], total: 0 };
      return { issues: [issueForStatus(params.status)], total: 1 };
    }
    case "listGroupedIssues": return { groups: [] };
    case "listInbox": return [];
    case "getAgentTaskSnapshot": return [];
    case "getWorkspaceAgentActivity30d": return [];
    case "getWorkspaceAgentRunCounts": return [];
    case "getChildIssueProgress": return { progress: [] };
    case "listProjects": return { projects: [project], total: 1 };
    case "getProject": return project;
    case "listAgents": return [agent];
    case "getAgent": return agent;
    case "listMembers": return [member];
    case "listSquads": return [];
    case "listSkills": return [];
    case "listRuntimes": return [];
    case "listLabels": return [];
    case "listPins": return [];
    case "getAssigneeFrequency": return [];
    case "getDashboardUsageDaily": return [];
    case "getDashboardUsageByAgent": return [];
    case "getDashboardAgentRunTime": return [];
    case "getDashboardRunTimeDaily": return [];
    case "getDaemonInventory": return { workspace_id: workspace.id, daemons: [] };
    case "listFleetModels": return { providers: [] };
    case "listLarkInstallations": return { configured: false, installations: [] };
    case "listAgentPluginBindings": return [];
    case "listProjectResources": return { resources: [], total: 0 };
    case "listWorkspaceDocs": return { docs: [], total: 0 };
    case "listAutopilots": return { autopilots: [autopilot], total: 1 };
    case "listAgentPlugins": return [plugin];
    case "listAgentPluginRuntimeStates": return [];
    case "listWorkspaceRepositories": return { repositories: [], total: 0 };
    case "listScmConnections": return { connections: [] };
    case "listRepositoryWikiSummaries": return [];
    case "getAtlasWikiSetupStatus": return {
      configured: false,
      plugin_id: null,
      agent_id: null,
      repository_autopilot_id: null,
      project_autopilot_id: null,
    };
    case "getPlatformStatus": return { canManage: false, activeOperation: null };
    default: return [];
  }
}

function summarizeArgs(args: unknown[]): string {
  const summary = JSON.stringify(args, (_key, value) => {
    if (typeof value === "function") return "[function]";
    return value;
  });
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function createRecordingApi(calls: ApiCall[]) {
  return new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      if (property === "getBaseUrl") return () => "http://127.0.0.1:8080";
      if (property === "getToken") return () => "diagnostic-token";
      return async (...args: unknown[]) => {
        const call: ApiCall = {
          method: property,
          args: summarizeArgs(args),
          startedAt: performance.now(),
          endedAt: 0,
        };
        calls.push(call);
        await new Promise((resolve) => setTimeout(resolve, SYNTHETIC_DELAY_MS));
        call.endedAt = performance.now();
        return apiResponse(property, args);
      };
    },
  });
}

function clusterWaves(calls: ApiCall[]): ApiCall[][] {
  const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt);
  const waves: ApiCall[][] = [];
  for (const call of sorted) {
    const current = waves.at(-1);
    if (!current || call.startedAt - current[0]!.startedAt > WAVE_GAP_MS) {
      waves.push([call]);
    } else {
      current.push(call);
    }
  }
  return waves;
}

async function settle() {
  await act(async () => {
    // A fixed observation window keeps background polling out of the initial
    // waterfall while covering far more serial depth than any measured page.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

function wrapper(client: ReturnType<typeof createQueryClient>) {
  return function DiagnosticWrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider locale="en" resources={RESOURCES}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </I18nProvider>
    );
  };
}

async function measurePage(page: string, element: () => ReactElement): Promise<PageResult> {
  navigationState.pathname = paths.workspace(workspace.slug).workbench();
  navigationState.searchParams = new URLSearchParams();
  localStorage.clear();

  const calls: ApiCall[] = [];
  setApiInstance(createRecordingApi(calls) as unknown as Parameters<typeof setApiInstance>[0]);
  const client = createQueryClient();
  const Wrapper = wrapper(client);

  const coldRender = render(element(), { wrapper: Wrapper });
  await settle();
  coldRender.unmount();
  const cold = [...calls];

  calls.length = 0;
  const warmRender = render(element(), { wrapper: Wrapper });
  await settle();
  warmRender.unmount();
  const warm = [...calls];
  client.clear();

  return {
    page,
    cold,
    coldWaves: clusterWaves(cold),
    warm,
    warmWaves: clusterWaves(warm),
  };
}

function formatResult(result: PageResult): string {
  const lines = [
    `PAGE ${result.page}`,
    `COLD requests=${result.cold.length} waves=${result.coldWaves.length} lower_bound_ms=${result.coldWaves.length * SYNTHETIC_DELAY_MS}`,
  ];
  result.coldWaves.forEach((wave, index) => {
    const base = wave[0]!.startedAt;
    lines.push(`  wave ${index + 1}: ${wave.map((call) => `${call.method}${call.args} @+${(call.startedAt - base).toFixed(1)}ms`).join(" | ")}`);
  });
  lines.push(`WARM requests=${result.warm.length} waves=${result.warmWaves.length}`);
  result.warmWaves.forEach((wave, index) => {
    lines.push(`  wave ${index + 1}: ${wave.map((call) => `${call.method}${call.args}`).join(" | ")}`);
  });
  const counts = new Map<string, number>();
  for (const call of result.cold) counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
  const duplicates = [...counts].filter(([, count]) => count >= 2);
  lines.push(`DUPLICATES ${duplicates.length ? duplicates.map(([method, count]) => `${method} x${count}`).join(", ") : "none"}`);
  return `${lines.join("\n")}\n`;
}

const pages: Array<[string, () => ReactElement]> = [
  ["workbench", () => <WorkbenchPage />],
  ["inbox", () => <InboxPage />],
  ["issues", () => <IssuesPage />],
  ["usage", () => <DashboardPage />],
  ["my-issues", () => <MyIssuesPage />],
  ["projects", () => <ProjectsPage />],
  ["projects/[id]", () => <ProjectDetail projectId={project.id} />],
  ["agents", () => <AgentsPage />],
  ["agents/[id]", () => <AgentDetailPage agentId={agent.id} />],
  ["runtimes", () => <RuntimesPage cloudRuntimeEnabled={false} />],
  ["squads", () => <SquadsPage />],
  ["skills", () => <SkillsPage />],
  ["autopilots", () => <AutopilotsPage />],
  ["plugins", () => <PluginsPage />],
  ["members/[id]", () => <MemberDetailPage userId={user.id} />],
  ["repos", () => <RepositoriesPage />],
  ["knowledge", () => <KnowledgePage />],
  ["settings", () => <SettingsPage />],
];

describe("MUL-180 main-page API waterfall diagnostic", () => {
  beforeAll(() => rmSync(OUTPUT_PATH, { force: true }));
  afterAll(() => setApiInstance(null as unknown as Parameters<typeof setApiInstance>[0]));

  for (const [page, element] of pages) {
    it(`records ${page} cold and warm waterfalls`, async () => {
      const result = await measurePage(page, element);
      appendFileSync(OUTPUT_PATH, formatResult(result));
      expect(result.cold.length).toBeGreaterThan(0);
    }, 15_000);
  }
});
