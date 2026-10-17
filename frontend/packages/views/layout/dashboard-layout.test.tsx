import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTrigger } from "../search/search-trigger";
import { renderWithI18n } from "../test/i18n";
import { DashboardLayout } from "./dashboard-layout";
import { APP_NAV_COOKIE, DEFAULT_SHELL_PREFERENCES, readShellPreferencesFromDocument } from "./shell-preferences";
import { ShellPreferencesProvider } from "./shell-preferences-provider";

const { pathname, noData } = vi.hoisted(() => ({ pathname: { current: "/acme/issues" }, noData: { data: [] as unknown[] } }));

vi.mock("./dashboard-guard", () => ({ DashboardGuard: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./workspace-presence-prefetch", () => ({ WorkspacePresencePrefetch: () => null }));
vi.mock("./navigation-progress", () => ({ NavigationProgress: () => null }));
vi.mock("./floating-panel-layout", () => ({ FloatingPanelLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../modals/registry", () => ({ ModalRegistry: () => null }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn() }),
  verticalListSortingStrategy: vi.fn(),
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
vi.mock("../auth", () => ({ useLogout: () => vi.fn() }));
vi.mock("../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));
vi.mock("../navigation", () => ({
  AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>,
  useNavigation: () => ({ pathname: pathname.current, push: vi.fn() }),
}));
vi.mock("../projects/components/project-icon", () => ({ ProjectIcon: () => <span /> }));
vi.mock("../workspace/workspace-avatar", () => ({ WorkspaceAvatar: () => <span /> }));
vi.mock("@multiremi/ui/components/common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("@multiremi/core/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/auth")>()),
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/paths", () => {
  const route = (path: string) => () => `/acme/${path}`;
  return {
    paths: { workspace: (slug: string) => ({ issues: () => `/${slug}/issues` }) },
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
    useWorkspacePaths: () => ({
      inbox: route("inbox"), chat: route("chat"), myIssues: route("my-issues"), workbench: route("workbench"),
      issues: route("issues"), projects: route("projects"), repositories: route("repos"), knowledge: route("knowledge"),
      autopilots: route("autopilots"), agents: route("agents"), squads: route("squads"), usage: route("usage"),
      runtimes: route("runtimes"), plugins: route("plugins"), skills: route("skills"), settings: route("settings"),
      issueDetail: (id: string) => `/acme/issues/${id}`, projectDetail: (id: string) => `/acme/projects/${id}`,
    }),
  };
});
vi.mock("@multiremi/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/api")>();
  return { ...actual, api: { ...actual.api, getBaseUrl: () => "http://127.0.0.1:8080" } };
});
vi.mock("@multiremi/core/inbox/queries", () => ({ useInboxAttentionUnreadCount: () => 3 }));
vi.mock("@multiremi/core/issues/queries", () => ({ issueDetailOptions: () => ({ queryKey: ["issue"] }) }));
vi.mock("@multiremi/core/issues/workbench", () => ({ useWorkbenchPendingCount: () => 0 }));
vi.mock("@multiremi/core/issues/stores/create-mode-store", () => ({
  useCreateModeStore: { getState: () => ({ lastMode: "agent" }) },
  openCreateIssueWithPreference: vi.fn(),
}));
vi.mock("@multiremi/core/issues/stores/draft-store", () => ({ useIssueDraftStore: () => false }));
vi.mock("@multiremi/core/modals", () => ({ useModalStore: { getState: () => ({ modal: null, open: vi.fn() }) } }));
vi.mock("@multiremi/core/pins/mutations", () => ({ useDeletePin: () => ({ mutate: vi.fn() }), useReorderPins: () => ({ mutate: vi.fn() }) }));
vi.mock("@multiremi/core/pins/queries", () => ({ pinListOptions: () => ({ queryKey: ["pins"] }) }));
vi.mock("@multiremi/core/projects/queries", () => ({ projectDetailOptions: () => ({ queryKey: ["project"] }) }));
vi.mock("@multiremi/core/runtimes/hooks", () => ({ useMyRuntimesNeedUpdate: () => false }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  myInvitationListOptions: (options?: { enabled?: boolean }) => ({ queryKey: ["invitations"], ...(options ?? {}) }),
  workspaceKeys: { myInvitations: () => ["invitations"] },
  workspaceListOptions: () => ({ queryKey: ["workspaces"] }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => noData,
  useQueryClient: () => ({ fetchQuery: vi.fn(), invalidateQueries: vi.fn() }),
}));

function renderShell(navOpen: boolean) {
  return renderWithI18n(
    <ShellPreferencesProvider initial={{ ...DEFAULT_SHELL_PREFERENCES, navOpen }}>
      <DashboardLayout searchSlot={<SearchTrigger />}>
        <h1>Issues page</h1>
      </DashboardLayout>
    </ShellPreferencesProvider>,
  );
}

const nav = () => document.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
const link = (name: RegExp) => screen.getByRole("link", { name });

async function hoverTooltip(element: HTMLElement) {
  await act(async () => {
    fireEvent.pointerEnter(element, { pointerType: "mouse" });
    fireEvent.pointerMove(element, { pointerType: "mouse" });
    fireEvent.mouseEnter(element);
    fireEvent.mouseMove(element);
  });
  await act(async () => { vi.advanceTimersByTime(1000); });
}

const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');

describe("app navigation collapse", () => {
  beforeEach(() => {
    pathname.current = "/acme/issues";
    document.cookie = `${APP_NAV_COOKIE}=; path=/; max-age=0`;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.cookie = `${APP_NAV_COOKIE}=; path=/; max-age=0`;
  });

  it("starts as the icon rail the cookie asked for, with each icon named by a tooltip", async () => {
    renderShell(false);
    expect(nav()).toHaveAttribute("data-state", "collapsed");
    expect(nav()).toHaveAttribute("data-collapsible", "icon");
    expect(screen.getByRole("heading", { name: "Issues page" })).toBeInTheDocument();
    // The icons keep their names for assistive tech, and hovering shows them.
    const inbox = link(/^Inbox/);
    await hoverTooltip(inbox);
    expect(tooltip()).toBeVisible();
    expect(tooltip()).toHaveTextContent("Inbox");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    // Every entry, the workspace switcher and Search included, has one.
    const buttons = [...nav().querySelectorAll('[data-sidebar="menu-button"]')];
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) expect(button).toHaveAttribute("data-base-ui-tooltip-trigger");
    expect(screen.getByRole("button", { name: /^Search/ })).toHaveAttribute("data-base-ui-tooltip-trigger");
  });

  it("shows no tooltips while expanded", async () => {
    renderShell(true);
    expect(nav()).toHaveAttribute("data-state", "expanded");
    await hoverTooltip(link(/^Inbox/));
    // The label is on screen already, so the tooltip stays hidden.
    expect(tooltip()).not.toBeVisible();
  });

  it("collapses and expands from its button and remembers it in the cookie the server reads", () => {
    renderShell(true);
    const footer = within(nav());
    fireEvent.click(footer.getByRole("button", { name: "Collapse sidebar" }));
    expect(nav()).toHaveAttribute("data-state", "collapsed");
    expect(readShellPreferencesFromDocument().navOpen).toBe(false);
    fireEvent.click(footer.getByRole("button", { name: "Expand sidebar" }));
    expect(nav()).toHaveAttribute("data-state", "expanded");
    expect(readShellPreferencesFromDocument().navOpen).toBe(true);
  });
});
