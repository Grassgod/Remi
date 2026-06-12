import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { paths } from "@multimira/core/paths";

const {
  mockPush,
  mockSearchParams,
  mockLoginWithLark,
  mockListWorkspaces,
  mockListMyInvitations,
  mockSetQueryData,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockSearchParams: new URLSearchParams(),
  mockLoginWithLark: vi.fn(),
  mockListWorkspaces: vi.fn(),
  mockListMyInvitations: vi.fn(),
  mockSetQueryData: vi.fn(),
}));

const makeUser = (
  overrides: Partial<{
    onboarded_at: string | null;
    onboarding_questionnaire: Record<string, unknown>;
  }> = {},
) => ({
  id: "user-1",
  name: "Test",
  email: "test@multimira.ai",
  avatar_url: null,
  onboarded_at: null,
  onboarding_questionnaire: { source: ["search"] },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

// Preserve the real sanitizeNextUrl so the "drop unsafe ?next=" behavior is
// exercised rather than silently diverging from the source of truth.
vi.mock("@multimira/core/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@multimira/core/auth")>(
      "@multimira/core/auth",
    );
  return {
    ...actual,
    useAuthStore: (selector: (s: unknown) => unknown) =>
      selector({ loginWithLark: mockLoginWithLark }),
  };
});

vi.mock("@multimira/core/workspace/queries", () => ({
  workspaceKeys: {
    list: () => ["workspaces"],
    myInvitations: () => ["invitations", "mine"],
  },
}));

vi.mock("@multimira/core/api", () => ({
  api: {
    listWorkspaces: mockListWorkspaces,
    listMyInvitations: mockListMyInvitations,
    larkLogin: vi.fn(),
  },
}));

import CallbackPage from "./page";

describe("CallbackPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the source-backfill dismiss counter so a test that writes
    // it doesn't leak state into the next test (and the next test
    // doesn't inherit a cap-reached state from a previous run).
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("multimira.source_backfill.dismiss.")) {
        window.localStorage.removeItem(k);
      }
    }
    // Snapshot keys before deleting — forEach + delete skips entries because
    // the iteration index advances while the underlying list shrinks.
    Array.from(mockSearchParams.keys()).forEach((k) =>
      mockSearchParams.delete(k),
    );
    mockSearchParams.set("code", "test-code");
    mockLoginWithLark.mockResolvedValue(makeUser());
    mockListWorkspaces.mockResolvedValue([]);
    mockListMyInvitations.mockResolvedValue([]);
  });

  it("unonboarded user honors a safe next= (e.g. /invite/{id}) so invitees aren't trapped", async () => {
    mockSearchParams.set("state", "next:/invite/abc123");
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/invite/abc123");
    });
    expect(mockPush).not.toHaveBeenCalledWith(paths.onboarding());
    // nextUrl is a fast path — listMyInvitations should not be queried.
    expect(mockListMyInvitations).not.toHaveBeenCalled();
  });

  it("unonboarded user with no next= and no pending invitations lands on /onboarding", async () => {
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(paths.onboarding());
    });
    expect(mockListMyInvitations).toHaveBeenCalled();
  });

  it("unonboarded user with pending invitations lands on /invitations", async () => {
    mockListMyInvitations.mockResolvedValue([
      {
        id: "inv-1",
        workspace_id: "ws-1",
        workspace_name: "Acme",
        role: "member",
        status: "pending",
      },
    ]);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(paths.invitations());
    });
    expect(mockPush).not.toHaveBeenCalledWith(paths.onboarding());
  });

  it("onboarded user with workspace lands in that workspace", async () => {
    mockLoginWithLark.mockResolvedValue(
      makeUser({ onboarded_at: "2026-01-01T00:00:00Z" }),
    );
    mockListWorkspaces.mockResolvedValue([
      {
        id: "ws-1",
        name: "Acme",
        slug: "acme",
        description: null,
        context: null,
        settings: {},
        repos: [],
        issue_prefix: "ACME",
        avatar_url: null,
        created_at: "",
        updated_at: "",
      },
    ]);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(paths.workspace("acme").issues());
    });
    // Already-onboarded users skip the listMyInvitations check; new invites
    // surface in the sidebar instead of the wall.
    expect(mockListMyInvitations).not.toHaveBeenCalled();
  });

  it("onboarded user ignores unsafe next= targets and lands on the default destination", async () => {
    mockLoginWithLark.mockResolvedValue(
      makeUser({ onboarded_at: "2026-01-01T00:00:00Z" }),
    );
    mockSearchParams.set("state", "next:https://evil.example");

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });
    expect(mockPush).not.toHaveBeenCalledWith("https://evil.example");
  });

  it("onboarded user honors a safe next= target (e.g. /invite/{id})", async () => {
    mockLoginWithLark.mockResolvedValue(
      makeUser({ onboarded_at: "2026-01-01T00:00:00Z" }),
    );
    mockSearchParams.set("state", "next:/invite/abc123");

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/invite/abc123");
    });
  });

  it("falls through to /onboarding when listMyInvitations errors", async () => {
    mockListMyInvitations.mockRejectedValue(new Error("network"));
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(paths.onboarding());
    });
  });

  it("onboarded users with missing source land in the workspace; the source-backfill modal is mounted there", async () => {
    // Source attribution backfill is now an in-workspace modal — see
    // `<SourceBackfillModal />` mounted inside `DashboardLayout`. The
    // callback page is intentionally agnostic about it.
    mockLoginWithLark.mockResolvedValue(
      makeUser({
        onboarded_at: "2026-01-01T00:00:00Z",
        onboarding_questionnaire: {},
      }),
    );
    mockListWorkspaces.mockResolvedValue([
      {
        id: "ws-1",
        name: "Acme",
        slug: "acme",
        description: null,
        context: null,
        settings: {},
        repos: [],
        issue_prefix: "ACME",
        created_at: "",
        updated_at: "",
      },
    ]);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(paths.workspace("acme").issues());
    });
  });
});
