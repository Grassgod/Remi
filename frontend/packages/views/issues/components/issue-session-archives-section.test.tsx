import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { SessionArchive } from "@multiremi/core/api";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const archivesRef = vi.hoisted(() => ({
  data: {
    archives: [] as SessionArchive[],
    latest: null as SessionArchive | null,
    latest_ready: null as SessionArchive | null,
  },
  pending: false,
  error: false,
}));
const mockVerify = vi.hoisted(() => vi.fn());
const mockRetry = vi.hoisted(() => vi.fn());
const mockRefetch = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: archivesRef.error ? undefined : archivesRef.data,
    isPending: archivesRef.pending,
    isError: archivesRef.error,
    refetch: mockRefetch,
  }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/session-archives", () => ({
  issueSessionArchivesOptions: (issueId: string) => ({
    queryKey: ["session-archives", "issue", issueId, "list"],
    queryFn: vi.fn(),
  }),
  useVerifyIssueSessionArchive: () => ({
    mutateAsync: mockVerify,
    isPending: false,
    variables: undefined,
  }),
  useRetryIssueSessionArchive: () => ({
    mutateAsync: mockRetry,
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  IssueSessionArchivesSection,
  sessionArchiveRefetchInterval,
} from "./issue-session-archives-section";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider resources={TEST_RESOURCES} locale="en">{children}</I18nProvider>;
}

function makeArchive(overrides: Partial<SessionArchive> = {}): SessionArchive {
  return {
    id: "archive-abcdef123456",
    workspace_id: "workspace-1",
    issue_id: "issue-1",
    runtime_id: "runtime-1",
    daemon_id: "daemon-1",
    source_revision: "rev-1",
    sha256: "abc123",
    size_bytes: 2048,
    uploaded_size_bytes: 2048,
    file_count: 2,
    status: "ready",
    relative_path: "issue-1/archive.tar.gz",
    metadata: {},
    attempt_count: 1,
    last_error: null,
    next_retry_at: null,
    retry_exhausted_at: null,
    retry_state: "eligible",
    created_at: "2026-08-19T01:00:00Z",
    updated_at: "2026-08-19T01:01:00Z",
    completed_at: "2026-08-19T01:01:00Z",
    ...overrides,
  };
}

function renderSection(
  props: Partial<ComponentProps<typeof IssueSessionArchivesSection>> = {},
) {
  return render(
    <IssueSessionArchivesSection
      issueId="issue-1"
      issueStatus="done"
      canManage
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

describe("IssueSessionArchivesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archivesRef.data = { archives: [], latest: null, latest_ready: null };
    archivesRef.pending = false;
    archivesRef.error = false;
    mockVerify.mockResolvedValue({ valid: true });
    mockRetry.mockResolvedValue({ archive: makeArchive({ status: "pending" }) });
  });

  it("shows a clear empty state for a completed issue", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /Session archives/ }));
    expect(screen.getByText("No session archive has been created yet.")).toBeInTheDocument();
  });

  it("verifies a ready archive from the compact issue sidebar section", async () => {
    const user = userEvent.setup();
    const archive = makeArchive();
    archivesRef.data = { archives: [archive], latest: archive, latest_ready: archive };
    renderSection();

    await user.click(screen.getByRole("button", { name: /Session archives/ }));
    await user.click(screen.getByRole("button", { name: "Verify archive" }));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith(archive.id));
    expect(screen.getByText("2 files · 2.0 KB")).toBeInTheDocument();
  });

  it("offers retry only for a failed archive", async () => {
    const user = userEvent.setup();
    const archive = makeArchive({ status: "failed", last_error: "disk full" });
    archivesRef.data = { archives: [archive], latest: archive, latest_ready: null };
    renderSection();

    await user.click(screen.getByRole("button", { name: /Session archives/ }));
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry archive" }));

    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith(archive.id));
    expect(screen.queryByRole("button", { name: "Verify archive" })).not.toBeInTheDocument();
  });

  it("shows exhausted retry details and keeps manual retry available", async () => {
    const user = userEvent.setup();
    const archive = makeArchive({
      status: "failed",
      attempt_count: 6,
      last_error: "upload stalled after 900000ms",
      next_retry_at: "2026-08-19T02:00:00Z",
      retry_exhausted_at: "2026-08-19T01:30:00Z",
      retry_state: "exhausted",
    });
    archivesRef.data = { archives: [archive], latest: archive, latest_ready: null };
    renderSection();

    expect(screen.getByText("Automatic retries stopped")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Session archives/ }));
    expect(screen.getAllByText("Automatic retries stopped")).toHaveLength(2);
    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && element.textContent?.includes("6 attempts") === true
    )).toBeInTheDocument();
    expect(screen.getByText("upload stalled after 900000ms")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry archive" }));
    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith(archive.id));
  });

  it("stays hidden for an active issue with no archive", () => {
    renderSection({ issueStatus: "in_progress" });
    expect(screen.queryByText("Session archives")).not.toBeInTheDocument();
  });

  it("does not report an empty archive when loading the archive state failed", async () => {
    const user = userEvent.setup();
    archivesRef.error = true;
    renderSection();

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Not archived")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Session archives/ }));
    expect(screen.getByText("Could not load session archives.")).toBeInTheDocument();
  });

  it("does not expose archive controls to regular members", () => {
    const archive = makeArchive();
    archivesRef.data = { archives: [archive], latest: archive, latest_ready: archive };
    renderSection({ canManage: false });
    expect(screen.queryByText("Session archives")).not.toBeInTheDocument();
  });
});

describe("sessionArchiveRefetchInterval", () => {
  it("polls while an archive is expected or still being uploaded", () => {
    expect(sessionArchiveRefetchInterval(true, null)).toBe(5000);
    expect(sessionArchiveRefetchInterval(false, "pending")).toBe(5000);
    expect(sessionArchiveRefetchInterval(false, "uploading")).toBe(5000);
    expect(sessionArchiveRefetchInterval(true, "failed")).toBe(false);
    expect(sessionArchiveRefetchInterval(true, "ready")).toBe(false);
    expect(sessionArchiveRefetchInterval(false, "failed")).toBe(false);
    expect(sessionArchiveRefetchInterval(false, null)).toBe(false);
  });
});
